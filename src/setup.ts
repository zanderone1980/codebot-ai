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
  const safe = { ...config };
  // Persist API key if user entered it during setup (convenience over env vars)
  // The key is stored in the user's home directory with default permissions
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

/** Cloud provider display info */
const CLOUD_PROVIDERS: Array<{
  provider: string;
  name: string;
  defaultModel: string;
  description: string;
}> = [
  { provider: 'openai', name: 'OpenAI', defaultModel: 'gpt-4o', description: 'GPT-4o, GPT-4.1, o3/o4' },
  { provider: 'anthropic', name: 'Anthropic', defaultModel: 'claude-sonnet-4-6', description: 'Claude Opus/Sonnet/Haiku' },
  { provider: 'gemini', name: 'Google Gemini', defaultModel: 'gemini-2.5-flash', description: 'Gemini 2.5 Pro/Flash' },
  { provider: 'deepseek', name: 'DeepSeek', defaultModel: 'deepseek-chat', description: 'DeepSeek Chat/Reasoner' },
  { provider: 'groq', name: 'Groq', defaultModel: 'llama-3.3-70b-versatile', description: 'Fast Llama/Mixtral inference' },
  { provider: 'mistral', name: 'Mistral', defaultModel: 'mistral-large-latest', description: 'Mistral Large, Codestral' },
  { provider: 'xai', name: 'xAI', defaultModel: 'grok-3', description: 'Grok-3' },
];

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

  // Step 3: Choose provider — show ALL options (local + cloud)
  console.log(fmt('\nChoose your setup:', 'bold'));

  const options: Array<{
    label: string;
    provider: string;
    model: string;
    baseUrl: string;
    needsKey: boolean;
    envVar?: string;
  }> = [];
  let idx = 1;

  // Local options first
  for (const server of localServers) {
    const defaultModel = server.models[0] || 'qwen2.5-coder:32b';
    options.push({
      label: `${server.name} (local, free)`,
      provider: 'openai',
      model: defaultModel,
      baseUrl: server.url,
      needsKey: false,
    });
    console.log(`  ${fmt(`${idx}`, 'cyan')} ${server.name} — ${defaultModel} ${fmt('(local, free, private)', 'green')}`);
    idx++;
  }

  // Cloud options — ALWAYS show all providers
  for (const cloud of CLOUD_PROVIDERS) {
    const keyInfo = apiKeys.find(k => k.provider === cloud.provider);
    const hasKey = keyInfo?.set || false;
    const defaults = PROVIDER_DEFAULTS[cloud.provider];
    const keyStatus = hasKey ? fmt('✓ key set', 'green') : fmt('enter key during setup', 'yellow');

    options.push({
      label: cloud.name,
      provider: cloud.provider,
      model: cloud.defaultModel,
      baseUrl: defaults.baseUrl,
      needsKey: !hasKey,
      envVar: defaults.envKey,
    });

    console.log(`  ${fmt(`${idx}`, 'cyan')} ${cloud.name} — ${cloud.description} ${fmt(`(${keyStatus})`, 'dim')}`);
    idx++;
  }

  const choice = await ask(rl, fmt(`\nSelect [1-${options.length}]: `, 'cyan'));
  const selected = options[parseInt(choice, 10) - 1] || options[0];

  // Step 4: If cloud provider needs API key, prompt for it
  let apiKey = '';
  if (selected.needsKey && selected.envVar) {
    console.log(fmt(`\n  ${selected.label} requires an API key.`, 'yellow'));
    console.log(fmt(`  Get one at: ${getKeyUrl(selected.provider)}`, 'dim'));
    apiKey = await ask(rl, fmt(`\n  Enter your ${selected.label} API key: `, 'cyan'));
    if (!apiKey) {
      console.log(fmt(`\n  No key entered. You can set it later:`, 'yellow'));
      console.log(fmt(`    export ${selected.envVar}="your-key-here"`, 'dim'));
    }
  } else if (selected.envVar) {
    // Use existing env var
    apiKey = process.env[selected.envVar] || '';
  }

  // Step 5: Show available models for chosen provider
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

  // Step 6: Auto mode?
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

  // Save API key if user entered one
  if (apiKey) {
    config.apiKey = apiKey;
  }

  saveConfig(config);

  console.log(fmt('\n✓ Config saved to ~/.codebot/config.json', 'green'));
  console.log(fmt(`  Model: ${config.model}`, 'dim'));
  console.log(fmt(`  Provider: ${config.provider}`, 'dim'));
  if (apiKey) {
    console.log(fmt(`  API Key: ${'*'.repeat(Math.min(apiKey.length, 20))}`, 'dim'));
  }
  if (autoApprove) {
    console.log(fmt(`  Mode: AUTONOMOUS`, 'yellow'));
  }
  console.log(fmt(`\nRun ${fmt('codebot', 'bold')} to start. Run ${fmt('codebot --setup', 'bold')} to reconfigure.\n`, 'dim'));

  return config;
}

/** Get the URL where users can get API keys for each provider */
function getKeyUrl(provider: string): string {
  switch (provider) {
    case 'openai': return 'https://platform.openai.com/api-keys';
    case 'anthropic': return 'https://console.anthropic.com/settings/keys';
    case 'gemini': return 'https://aistudio.google.com/app/apikey';
    case 'deepseek': return 'https://platform.deepseek.com/api_keys';
    case 'groq': return 'https://console.groq.com/keys';
    case 'mistral': return 'https://console.mistral.ai/api-keys';
    case 'xai': return 'https://console.x.ai/';
    default: return 'Check provider documentation';
  }
}
