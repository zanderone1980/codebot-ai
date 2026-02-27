import * as readline from 'readline';
import { Agent } from './agent';
import { OpenAIProvider } from './providers/openai';
import { AnthropicProvider } from './providers/anthropic';
import { detectProvider, PROVIDER_DEFAULTS } from './providers/registry';
import { AgentEvent, Config, LLMProvider, Message } from './types';
import { SessionManager } from './history';
import { loadConfig, isFirstRun, runSetup } from './setup';
import { banner, randomGreeting, compactBanner } from './banner';
import { EditFileTool } from './tools';
import { Scheduler } from './scheduler';

const VERSION = '1.2.0';

// Session-wide token tracking
let sessionTokens = { input: 0, output: 0, total: 0 };

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function c(text: string, style: keyof typeof C): string {
  return `${C[style]}${text}${C.reset}`;
}

export async function main() {
  const args = parseArgs(process.argv.slice(2));

  if (args.help) {
    showHelp();
    return;
  }

  if (args.version) {
    console.log(`codebot v${VERSION}`);
    return;
  }

  // Setup wizard
  if (args.setup) {
    await runSetup();
    return;
  }

  // First run: auto-launch setup if nothing is configured
  if (isFirstRun() && process.stdin.isTTY && !args.message) {
    console.log(c('Welcome! No configuration found — launching setup...', 'cyan'));
    await runSetup();
    // If setup saved a config, continue to main flow
    // Otherwise exit
    if (isFirstRun()) return;
  }

  const config = await resolveConfig(args);
  const provider = createProvider(config);

  // Session management
  let resumeId: string | undefined;
  if (args.continue) {
    resumeId = SessionManager.latest();
    if (!resumeId) {
      console.log(c('No previous session found.', 'yellow'));
    }
  } else if (typeof args.resume === 'string') {
    resumeId = args.resume as string;
  }

  const session = new SessionManager(config.model, resumeId);

  const sessionShort = session.getId().substring(0, 8);
  console.log(banner(VERSION, config.model, `${config.provider} @ ${config.baseUrl}`, `${sessionShort}...`, !!config.autoApprove));
  if (resumeId) {
    console.log(c(`   Resuming session...`, 'green'));
  }
  console.log(c(`   ${randomGreeting()}\n`, 'dim'));

  const agent = new Agent({
    provider,
    model: config.model,
    maxIterations: config.maxIterations,
    autoApprove: config.autoApprove,
    onMessage: (msg: Message) => session.save(msg),
  });

  // Resume: load previous messages
  if (resumeId) {
    const messages = session.load();
    if (messages.length > 0) {
      agent.loadMessages(messages);
      console.log(c(`   Loaded ${messages.length} messages from previous session.`, 'dim'));
    }
  }

  // Non-interactive: single message from CLI args
  if (typeof args.message === 'string') {
    await runOnce(agent, args.message);
    return;
  }

  // Non-interactive: piped stdin
  if (!process.stdin.isTTY) {
    const input = await readStdin();
    if (input.trim()) {
      await runOnce(agent, input.trim());
    }
    return;
  }

  // Start the routine scheduler in the background
  const scheduler = new Scheduler(agent, (text) => process.stdout.write(text));
  scheduler.start();

  // Interactive REPL
  await repl(agent, config, session);

  // Cleanup scheduler on exit
  scheduler.stop();
}

function createProvider(config: Config): LLMProvider {
  if (config.provider === 'anthropic') {
    return new AnthropicProvider({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
    });
  }

  // All other providers use OpenAI-compatible format
  return new OpenAIProvider({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
  });
}

async function repl(agent: Agent, config: Config, session?: SessionManager) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: c('> ', 'cyan'),
  });

  rl.prompt();

  rl.on('line', async (line: string) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }

    if (input.startsWith('/')) {
      handleSlashCommand(input, agent, config);
      rl.prompt();
      return;
    }

    try {
      for await (const event of agent.run(input)) {
        renderEvent(event);
      }
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(c(`\nError: ${msg}`, 'red'));
    }

    console.log();
    rl.prompt();
  });

  rl.on('close', () => {
    console.log(c('\nBye!', 'dim'));
    process.exit(0);
  });
}

async function runOnce(agent: Agent, message: string) {
  for await (const event of agent.run(message)) {
    renderEvent(event);
  }
  console.log();
}

let isThinking = false;

function renderEvent(event: AgentEvent) {
  switch (event.type) {
    case 'thinking':
      if (!isThinking) {
        process.stdout.write(c('\n💭 ', 'dim'));
        isThinking = true;
      }
      process.stdout.write(c(event.text || '', 'dim'));
      break;
    case 'text':
      if (isThinking) {
        process.stdout.write('\n');
        isThinking = false;
      }
      process.stdout.write(event.text || '');
      break;
    case 'tool_call':
      if (isThinking) {
        process.stdout.write('\n');
        isThinking = false;
      }
      console.log(
        c(`\n⚡ ${event.toolCall?.name}`, 'yellow') +
          c(`(${formatArgs(event.toolCall?.args)})`, 'dim')
      );
      break;
    case 'tool_result':
      if (event.toolResult?.is_error) {
        console.log(c(`  ✗ ${truncate(event.toolResult.result, 200)}`, 'red'));
      } else {
        const result = event.toolResult?.result || '';
        const lines = result.split('\n');
        if (lines.length > 10) {
          console.log(c(`  ✓ (${lines.length} lines)`, 'green'));
        } else {
          console.log(c(`  ✓ ${truncate(result, 200)}`, 'green'));
        }
      }
      break;
    case 'usage':
      if (event.usage) {
        if (event.usage.inputTokens) sessionTokens.input += event.usage.inputTokens;
        if (event.usage.outputTokens) sessionTokens.output += event.usage.outputTokens;
        if (event.usage.totalTokens) sessionTokens.total += event.usage.totalTokens;
        const parts: string[] = [];
        if (event.usage.inputTokens) parts.push(`in: ${event.usage.inputTokens}`);
        if (event.usage.outputTokens) parts.push(`out: ${event.usage.outputTokens}`);
        if (parts.length > 0) {
          console.log(c(`  [${parts.join(', ')} tokens]`, 'dim'));
        }
      }
      break;
    case 'compaction':
      console.log(c(`\n📦 ${event.text}`, 'dim'));
      break;
    case 'error':
      console.error(c(`\n✗ ${event.error}`, 'red'));
      break;
    case 'done':
      if (isThinking) {
        process.stdout.write('\n');
        isThinking = false;
      }
      break;
  }
}

function formatArgs(args?: Record<string, unknown>): string {
  if (!args) return '';
  return Object.entries(args)
    .map(([k, v]) => {
      const val = typeof v === 'string' ? truncate(v, 60) : JSON.stringify(v);
      return `${k}: ${val}`;
    })
    .join(', ');
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.substring(0, max) + '...';
}

function handleSlashCommand(input: string, agent: Agent, config: Config) {
  const [cmd, ...rest] = input.split(/\s+/);
  switch (cmd) {
    case '/help':
      console.log(`${c('Commands:', 'bold')}
  /help      Show this help
  /model     Show or change model (/model <name>)
  /models    List all supported models
  /sessions  List saved sessions
  /clear     Clear conversation history
  /compact   Force context compaction
  /auto      Toggle autonomous mode
  /routines  List scheduled routines
  /undo      Undo last file edit (/undo [path])
  /usage     Show token usage for this session
  /config    Show current config
  /quit      Exit`);
      break;
    case '/model':
      if (rest.length > 0) {
        config.model = rest.join(' ');
        const detected = detectProvider(config.model);
        if (detected) {
          config.provider = detected;
          console.log(c(`Model: ${config.model} (provider: ${detected})`, 'green'));
        } else {
          console.log(c(`Model: ${config.model} (local/ollama)`, 'green'));
        }
      } else {
        console.log(`Current model: ${config.model} (${config.provider})`);
      }
      break;
    case '/models':
      showModels();
      break;
    case '/clear':
      agent.clearHistory();
      console.log(c('Conversation cleared.', 'dim'));
      break;
    case '/compact': {
      const stats = agent.forceCompact();
      console.log(c(`Context compacted: ${stats.before} → ${stats.after} messages.`, 'dim'));
      break;
    }
    case '/auto':
      config.autoApprove = !config.autoApprove;
      agent.setAutoApprove(config.autoApprove);
      console.log(c(`Autonomous mode: ${config.autoApprove ? 'ON' : 'OFF'}`, config.autoApprove ? 'yellow' : 'green'));
      break;
    case '/sessions': {
      const sessions = SessionManager.list();
      if (sessions.length === 0) {
        console.log(c('No saved sessions.', 'dim'));
      } else {
        console.log(c('\nSaved sessions:', 'bold'));
        for (const s of sessions) {
          const date = s.updated ? new Date(s.updated).toLocaleString() : 'unknown';
          console.log(`  ${c(s.id.substring(0, 8), 'cyan')}  ${date}  ${s.messageCount} msgs  ${c(s.preview || '(empty)', 'dim')}`);
        }
        console.log(c(`\nResume with: codebot --resume <id>`, 'dim'));
      }
      break;
    }
    case '/undo': {
      const undoPath = rest.length > 0 ? rest.join(' ') : undefined;
      const undoResult = EditFileTool.undo(undoPath);
      console.log(c(undoResult, undoResult.includes('Restored') ? 'green' : 'yellow'));
      break;
    }
    case '/usage': {
      console.log(c('\nToken Usage (this session):', 'bold'));
      console.log(`  Input:  ${sessionTokens.input.toLocaleString()} tokens`);
      console.log(`  Output: ${sessionTokens.output.toLocaleString()} tokens`);
      console.log(`  Total:  ${(sessionTokens.input + sessionTokens.output).toLocaleString()} tokens`);
      break;
    }
    case '/routines': {
      const { RoutineTool } = require('./tools/routine');
      const rt = new RoutineTool();
      rt.execute({ action: 'list' }).then((out: string) => console.log('\n' + out));
      break;
    }
    case '/config':
      console.log(JSON.stringify({ ...config, apiKey: config.apiKey ? '***' : undefined }, null, 2));
      break;
    case '/quit':
    case '/exit':
      process.exit(0);
    default:
      console.log(c(`Unknown command: ${cmd}. Type /help`, 'yellow'));
  }
}

function showModels() {
  const { MODEL_REGISTRY } = require('./providers/registry');
  const byProvider: Record<string, string[]> = {};
  for (const [name, info] of Object.entries(MODEL_REGISTRY) as [string, { provider?: string }][]) {
    const p = info.provider || 'local/ollama';
    if (!byProvider[p]) byProvider[p] = [];
    byProvider[p].push(name);
  }
  for (const [provider, models] of Object.entries(byProvider).sort()) {
    console.log(c(`\n${provider}:`, 'bold'));
    for (const m of models) {
      console.log(`  ${m}`);
    }
  }
}

async function resolveConfig(args: Record<string, string | boolean>): Promise<Config> {
  // Load saved config (CLI args override saved config)
  const saved = loadConfig();

  const model = (args.model as string) || process.env.CODEBOT_MODEL || saved.model || 'qwen2.5-coder:32b';
  const detected = detectProvider(model);

  const config: Config = {
    provider: (args.provider as string) || process.env.CODEBOT_PROVIDER || saved.provider || detected || 'openai',
    model,
    baseUrl: (args['base-url'] as string) || process.env.CODEBOT_BASE_URL || saved.baseUrl || '',
    apiKey: (args['api-key'] as string) || '',
    maxIterations: parseInt((args['max-iterations'] as string) || String(saved.maxIterations || 50), 10),
    autoApprove: !!args['auto-approve'] || !!args.autonomous || !!args.auto || !!saved.autoApprove,
  };

  // Auto-resolve base URL and API key from provider
  if (!config.baseUrl || !config.apiKey) {
    const defaults = PROVIDER_DEFAULTS[config.provider];
    if (defaults) {
      if (!config.baseUrl) config.baseUrl = defaults.baseUrl;
      if (!config.apiKey) config.apiKey = process.env[defaults.envKey] || process.env.CODEBOT_API_KEY || '';
    }
  }

  // Fallback: try saved config API key, then generic env vars
  if (!config.apiKey && saved.apiKey) {
    config.apiKey = saved.apiKey;
  }
  if (!config.apiKey) {
    config.apiKey = process.env.CODEBOT_API_KEY || process.env.OPENAI_API_KEY || '';
  }

  // If still no base URL, auto-detect local provider
  if (!config.baseUrl) {
    config.baseUrl = await autoDetectProvider();
  }

  return config;
}

async function autoDetectProvider(): Promise<string> {
  const candidates = [
    { url: 'http://localhost:11434', name: 'Ollama' },
    { url: 'http://localhost:1234', name: 'LM Studio' },
    { url: 'http://localhost:8000', name: 'vLLM' },
  ];

  for (const { url, name } of candidates) {
    try {
      const res = await fetch(`${url}/v1/models`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        console.log(c(`  ✓ ${name} detected on ${url}`, 'green'));
        return url;
      }
    } catch {
      // not running
    }
  }

  console.log(c('  ⚠ No local LLM detected. Start Ollama or set --base-url', 'yellow'));
  return 'http://localhost:11434';
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      result.help = true;
      continue;
    }
    if (arg === '--version' || arg === '-v') {
      result.version = true;
      continue;
    }
    if (arg === '--auto-approve' || arg === '--autonomous' || arg === '--auto') {
      result['auto-approve'] = true;
      result.autonomous = true;
      result.auto = true;
      continue;
    }
    if (arg === '--continue' || arg === '-c') {
      result.continue = true;
      continue;
    }
    if (arg === '--setup' || arg === '--init') {
      result.setup = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        result[key] = next;
        i++;
      } else {
        result[key] = true;
      }
      continue;
    }
    positional.push(arg);
  }

  if (positional.length > 0) {
    result.message = positional.join(' ');
  }

  return result;
}

function readStdin(): Promise<string> {
  return new Promise(resolve => {
    let data = '';
    process.stdin.on('data', (chunk: Buffer) => (data += chunk.toString()));
    process.stdin.on('end', () => resolve(data));
  });
}

function showHelp() {
  console.log(`${c('CodeBot AI', 'bold')} - Local-first AI coding assistant

${c('Quick Start:', 'bold')}
  codebot --setup                  Run interactive setup wizard
  codebot                          Start interactive mode
  codebot "fix the bug in app.ts"  Single message mode
  echo "explain this" | codebot    Pipe mode

${c('Options:', 'bold')}
  --setup              Run the setup wizard (auto-runs on first use)
  --model <name>       Model to use (default: qwen2.5-coder:32b)
  --provider <name>    Provider: openai, anthropic, gemini, deepseek, groq, mistral, xai
  --base-url <url>     LLM API base URL (auto-detects Ollama/LM Studio/vLLM + cloud)
  --api-key <key>      API key (or set provider-specific env var)
  --autonomous         Skip ALL permission prompts — full auto mode
  --auto-approve       Same as --autonomous
  --resume <id>        Resume a previous session by ID
  --continue, -c       Resume the most recent session
  --max-iterations <n> Max agent loop iterations (default: 50)
  -h, --help           Show this help
  -v, --version        Show version

${c('Supported Providers:', 'bold')}
  Local:      Ollama, LM Studio, vLLM (auto-detected)
  Anthropic:  Claude Opus/Sonnet/Haiku (ANTHROPIC_API_KEY)
  OpenAI:     GPT-4o, GPT-4.1, o1/o3/o4 (OPENAI_API_KEY)
  Google:     Gemini 2.5/2.0/1.5 (GEMINI_API_KEY)
  DeepSeek:   deepseek-chat, deepseek-reasoner (DEEPSEEK_API_KEY)
  Groq:       Llama, Mixtral on Groq (GROQ_API_KEY)
  Mistral:    mistral-large, codestral (MISTRAL_API_KEY)
  xAI:        Grok-3 (XAI_API_KEY)

${c('Examples:', 'bold')}
  codebot --model claude-opus-4-6          Uses Anthropic API
  codebot --model gpt-4o                   Uses OpenAI API
  codebot --model gemini-2.5-pro           Uses Gemini API
  codebot --model deepseek-chat            Uses DeepSeek API
  codebot --model qwen2.5-coder:32b        Uses local Ollama
  codebot --autonomous "refactor src/"     Full auto, no prompts

${c('Interactive Commands:', 'bold')}
  /help      Show commands
  /model     Show or change model
  /models    List all supported models
  /sessions  List saved sessions
  /auto      Toggle autonomous mode
  /clear     Clear conversation
  /compact   Force context compaction
  /config    Show configuration
  /quit      Exit`);
}
