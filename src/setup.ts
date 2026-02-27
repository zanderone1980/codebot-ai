import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { PROVIDER_DEFAULTS, MODEL_REGISTRY } from './providers/registry';

const CONFIG_DIR = path.join(os.homedir(), '.codebot');
const CONFIG_FILE = path.join(CONFIG_DIR, 'config.json');

export interface SavedConfig {
  model?: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  autoApprove?: boolean;
  maxIterations?: number;
}

/** Load saved config from ~/.codebot/config.json */
export function loadConfig(): SavedConfig {
  try {
    if (fs.existsSync(CONFIG_FILE)) {
      return JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf-8'));
    }
  } catch {
    // corrupt config, ignore
  }
  return {};
}

/** Save config to ~/.codebot/config.json */
export function saveConfig(config: SavedConfig): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  // Never persist API keys to disk — use env vars
  const safe = { ...config };
  delete safe.apiKey;
  fs.writeFileSync(CONFIG_FILE, JSON.stringify(safe, null, 2) + '\n');
}

/** Check if this is the first run (no config, no env keys) */
export function isFirstRun(): boolean {
  if (fs.existsSync(CONFIG_FILE)) return false;

  // Check if any provider API keys are set
  const envKeys = [
    'ANTHROPIC_API_KEY', 'OPENAI_API_KEY', 'GEMINI_API_KEY',
    'DEEPSEEK_API_KEY', 'GROQ_API_KEY', 'MISTRAL_API_KEY',
    'XAI_API_KEY', 'CODEBOT_API_KEY',
  ];
  for (const key of envKeys) {
    if (process.env[key]) return false;
  }

  return true;
}

/** Detect what local LLM servers are running */
async function detectLocalServers(): Promise<Array<{ name: string; url: string; models: string[] }>> {
  const servers: Array<{ name: string; url: string; models: string[] }> = [];
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
        const data = await res.json() as { data?: Array<{ id: string }> };
        const models = (data.data || []).map(m => m.id);
        servers.push({ name, url, models });
      }
    } catch {
      // not running
    }
  }

  return servers;
}

/** Detect which cloud API keys are available */
function detectApiKeys(): Array<{ provider: string; envVar: string; set: boolean }> {
  return Object.entries(PROVIDER_DEFAULTS).map(([provider, defaults]) => ({
    provider,
    envVar: defaults.envKey,
    set: !!process.env[defaults.envKey],
  }));
}

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function fmt(text: string, style: keyof typeof C): string {
  return `${C[style]}${text}${C.reset}`;
}

function ask(rl: readline.Interface, question: string): Promise<string> {
  return new Promise(resolve => {
    rl.question(question, answer => resolve(answer.trim()));
  });
}

/** Interactive setup wizard */
export async function runSetup(): Promise<SavedConfig> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(fmt('\n⚡ CodeBot AI — Setup', 'bold'));
  console.log(fmt('   Let\'s get you configured.\n', 'dim'));

  // Step 1: Detect local servers
  console.log(fmt('Scanning for local LLM servers...', 'dim'));
  const localServers = await detectLocalServers();

  // Step 2: Detect API keys
  const apiKeys = detectApiKeys();
  const availableKeys = apiKeys.filter(k => k.set);

  // Show what was found
  if (localServers.length > 0) {
    for (const server of localServers) {
      console.log(fmt(`  ✓ ${server.name} detected (${server.models.length} models)`, 'green'));
    }
  } else {
    console.log(fmt('  No local LLM servers detected.', 'dim'));
  }

  if (availableKeys.length > 0) {
    for (const key of availableKeys) {
      console.log(fmt(`  ✓ ${key.provider} API key found (${key.envVar})`, 'green'));
    }
  }

  const missingKeys = apiKeys.filter(k => !k.set);
  if (missingKeys.length > 0 && localServers.length === 0) {
    console.log(fmt('\n  No API keys found. Set one to use cloud models:', 'yellow'));
    for (const key of missingKeys) {
      console.log(fmt(`    export ${key.envVar}="your-key-here"`, 'dim'));
    }
  }

  // Step 3: Choose provider
  console.log(fmt('\nChoose your setup:', 'bold'));

  const options: Array<{ label: string; provider: string; model: string; baseUrl: string }> = [];
  let idx = 1;

  // Local options first
  for (const server of localServers) {
    const defaultModel = server.models[0] || 'qwen2.5-coder:32b';
    options.push({ label: `${server.name} (local, free)`, provider: 'openai', model: defaultModel, baseUrl: server.url });
    console.log(`  ${fmt(`${idx}`, 'cyan')} ${server.name} — ${defaultModel} ${fmt('(local, free, private)', 'green')}`);
    idx++;
  }

  // Cloud options
  for (const key of availableKeys) {
    const models = Object.entries(MODEL_REGISTRY)
      .filter(([, info]) => info.provider === key.provider)
      .map(([name]) => name);
    const defaultModel = models[0] || key.provider;
    const defaults = PROVIDER_DEFAULTS[key.provider];
    options.push({ label: key.provider, provider: key.provider, model: defaultModel, baseUrl: defaults.baseUrl });
    console.log(`  ${fmt(`${idx}`, 'cyan')} ${key.provider} — ${defaultModel} ${fmt('(cloud)', 'dim')}`);
    idx++;
  }

  if (options.length === 0) {
    console.log(fmt('\n  No providers available. Either:', 'yellow'));
    console.log(fmt('    1. Install Ollama: https://ollama.ai', 'dim'));
    console.log(fmt('    2. Set an API key: export ANTHROPIC_API_KEY="..."', 'dim'));
    rl.close();
    return {};
  }

  const choice = await ask(rl, fmt(`\nSelect [1-${options.length}]: `, 'cyan'));
  const selected = options[parseInt(choice, 10) - 1] || options[0];

  // Step 4: Show available models for chosen provider
  // For local servers, use the actual installed models instead of the hardcoded registry
  const matchedServer = localServers.find(s => s.url === selected.baseUrl);
  const providerModels = matchedServer && matchedServer.models.length > 0
    ? matchedServer.models
    : Object.entries(MODEL_REGISTRY)
        .filter(([, info]) => info.provider === selected.provider)
        .map(([name]) => name);

  if (providerModels.length > 1) {
    console.log(fmt(`\nAvailable models${matchedServer ? ` on ${matchedServer.name}` : ''}:`, 'bold'));
    providerModels.slice(0, 15).forEach((m, i) => {
      const marker = m === selected.model ? fmt(' (default)', 'green') : '';
      console.log(`  ${fmt(`${i + 1}`, 'cyan')} ${m}${marker}`);
    });

    const modelChoice = await ask(rl, fmt(`\nModel [Enter for ${selected.model}]: `, 'cyan'));
    if (modelChoice) {
      const modelIdx = parseInt(modelChoice, 10) - 1;
      if (providerModels[modelIdx]) {
        selected.model = providerModels[modelIdx];
      } else if (modelChoice.length > 2) {
        // Treat as model name typed directly
        selected.model = modelChoice;
      }
    }
  }

  // Step 5: Auto mode?
  const autoChoice = await ask(rl, fmt('\nEnable autonomous mode? (skip permission prompts) [y/N]: ', 'cyan'));
  const autoApprove = autoChoice.toLowerCase().startsWith('y');

  rl.close();

  // Save config
  const config: SavedConfig = {
    model: selected.model,
    provider: selected.provider,
    baseUrl: selected.baseUrl,
    autoApprove,
  };

  saveConfig(config);

  console.log(fmt('\n✓ Config saved to ~/.codebot/config.json', 'green'));
  console.log(fmt(`  Model: ${config.model}`, 'dim'));
  console.log(fmt(`  Provider: ${config.provider}`, 'dim'));
  if (autoApprove) {
    console.log(fmt(`  Mode: AUTONOMOUS`, 'yellow'));
  }
  console.log(fmt(`\nRun ${fmt('codebot', 'bold')} to start. Run ${fmt('codebot --setup', 'bold')} to reconfigure.\n`, 'dim'));

  return config;
}
