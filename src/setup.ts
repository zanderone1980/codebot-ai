import * as fs from 'fs';
import * as path from 'path';
import * as readline from 'readline';
import { PROVIDER_DEFAULTS, MODEL_REGISTRY, detectProvider, getModelInfo } from './providers/registry';
import { codebotHome, codebotPath } from './paths';



export interface SavedConfig {
  model?: string;
  provider?: string;
  baseUrl?: string;
  /** Generic API key (legacy / fallback). Used when no provider-specific key is set. */
  apiKey?: string;
  /**
   * Provider-specific API keys. When set, these take precedence over the
   * generic `apiKey` field for the matching provider. Lets the user have
   * multiple providers configured at once and switch between them with
   * `--provider` or `--model` without losing keys.
   *
   * Setup wizards / dashboard write to these; resolveConfig + pickProviderKey
   * read them.
   */
  anthropicApiKey?: string;
  openaiApiKey?: string;
  geminiApiKey?: string;
  deepseekApiKey?: string;
  groqApiKey?: string;
  mistralApiKey?: string;
  xaiApiKey?: string;
  autoApprove?: boolean;
  maxIterations?: number;
  firstRunComplete?: boolean;
  /**
   * Providers the user has explicitly banned from this install. When a
   * provider name is in this list:
   *   - pickProviderKey returns empty (no env/config fallback leaks)
   *   - the dashboard /api/models/registry reports it unavailable
   *   - createProvider refuses to instantiate it and throws
   *   - the setup wizard won't ask for its key
   *
   * Typical use case: an Anthropic user is also a Claude Code user with
   * CLAUDE_CODE_OAUTH_TOKEN set — without this flag, CodeBot would happily
   * inherit that token and bill against their Anthropic budget on provider
   * mismatches. Add `"disabledProviders": ["anthropic"]` to ~/.codebot/config.json
   * to force CodeBot to stay OpenAI-only (or whatever else you want).
   */
  disabledProviders?: string[];
}

/** Return true if the user has explicitly banned this provider. */
export function isProviderDisabled(saved: SavedConfig, provider: string): boolean {
  if (!saved.disabledProviders || !Array.isArray(saved.disabledProviders)) return false;
  return saved.disabledProviders.includes(provider);
}

/**
 * Look up the saved API key for a specific provider, falling back to the
 * generic `apiKey` field. Returns empty string if neither is set.
 *
 * Centralized so the CLI, dashboard, and any future provider-switching
 * code use the same precedence rule.
 */
export function pickProviderKey(saved: SavedConfig, provider: string): string {
  // Hard block: if the user banned this provider, never return a key.
  // Stops env-var fallbacks (ANTHROPIC_API_KEY, CLAUDE_CODE_OAUTH_TOKEN, etc.)
  // from ever reaching an Anthropic call when the user has opted out.
  if (isProviderDisabled(saved, provider)) return '';

  const fieldMap: Record<string, keyof SavedConfig> = {
    anthropic: 'anthropicApiKey',
    openai: 'openaiApiKey',
    gemini: 'geminiApiKey',
    deepseek: 'deepseekApiKey',
    groq: 'groqApiKey',
    mistral: 'mistralApiKey',
    xai: 'xaiApiKey',
  };
  const field = fieldMap[provider];
  if (field) {
    const v = saved[field];
    if (typeof v === 'string' && v.length > 0) return v;
  }
  return saved.apiKey || '';
}

/** Load saved config from ~/.codebot/config.json */
export function loadConfig(): SavedConfig {
  try {
    if (fs.existsSync(codebotPath('config.json'))) {
      return JSON.parse(fs.readFileSync(codebotPath('config.json'), 'utf-8'));
    }
  } catch {
    // corrupt config, ignore
  }
  return {};
}

/**
 * If `provider` is set but `baseUrl` either is empty or matches the default
 * URL of a DIFFERENT provider (i.e., the user just switched providers and
 * left a stale baseUrl from the previous one), set `baseUrl` to the new
 * provider's default. Returns a new object — does not mutate input.
 *
 * Local URLs (containing `localhost` or `127.0.0.1`) are left alone — the
 * user explicitly chose them.
 *
 * Issue #5: setup wizard / dashboard wrote `provider: openai` but kept
 * `baseUrl: https://api.anthropic.com` from a prior Anthropic config →
 * every OpenAI call returned 404. This function makes that impossible.
 */
export function normalizeProviderBaseUrl(config: SavedConfig): SavedConfig {
  if (!config.provider) return config;
  const target = PROVIDER_DEFAULTS[config.provider];
  if (!target) return config;

  const url = config.baseUrl || '';

  // Local URLs are user choice.
  if (url.includes('localhost') || url.includes('127.0.0.1')) return config;

  // Empty → fill in.
  if (!url) {
    return { ...config, baseUrl: target.baseUrl };
  }

  // Matches a different provider's default → switch to current provider's default.
  for (const [otherProvider, defaults] of Object.entries(PROVIDER_DEFAULTS)) {
    if (otherProvider === config.provider) continue;
    if (url === defaults.baseUrl) {
      return { ...config, baseUrl: target.baseUrl };
    }
  }

  // Matches current provider's default OR a custom URL — leave it.
  return config;
}

/** Save config to ~/.codebot/config.json (with backup + atomic write). */
export function saveConfig(config: SavedConfig): void {
  fs.mkdirSync(codebotHome(), { recursive: true });
  // Auto-correct stale baseUrl (issue #5) before persisting.
  const safe = normalizeProviderBaseUrl({ ...config });
  const content = JSON.stringify(safe, null, 2) + '\n';

  // Create backup of existing config
  if (fs.existsSync(codebotPath('config.json'))) {
    try {
      fs.copyFileSync(codebotPath('config.json'), codebotPath('config.json') + '.bak');
    } catch { /* best effort */ }
  }

  // Atomic write: write to temp file, then rename
  const tmpFile = codebotPath('config.json') + '.tmp';
  fs.writeFileSync(tmpFile, content);
  fs.renameSync(tmpFile, codebotPath('config.json'));
}

/** Check if this is the first run (no config, no env keys) */
export function isFirstRun(): boolean {
  if (fs.existsSync(codebotPath('config.json'))) return false;

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
export async function detectLocalServers(): Promise<Array<{ name: string; url: string; models: string[] }>> {
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

// ── ANSI helpers ─────────────────────────────────────────────────────────────

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

// ── Model-first setup data ──────────────────────────────────────────────────

interface SetupModelEntry {
  id: string;
  displayName: string;
  provider: string;
  category: 'local' | 'frontier' | 'fast' | 'reasoning';
  contextK: string;
}

const PROVIDER_DISPLAY: Record<string, string> = {
  anthropic: 'Anthropic',
  openai: 'OpenAI',
  gemini: 'Google',
  deepseek: 'DeepSeek',
  groq: 'Groq',
  mistral: 'Mistral',
  xai: 'xAI',
};

/** Hand-picked cloud models for the setup menu — best 2-3 from each provider */
const CURATED_CLOUD_MODELS: SetupModelEntry[] = [
  // Frontier (most capable)
  { id: 'claude-opus-4-6',         displayName: 'Claude Opus 4',       provider: 'anthropic', category: 'frontier', contextK: '200K' },
  { id: 'gpt-4.1',                 displayName: 'GPT-4.1',             provider: 'openai',    category: 'frontier', contextK: '1M' },
  { id: 'gemini-2.5-pro',          displayName: 'Gemini 2.5 Pro',      provider: 'gemini',    category: 'frontier', contextK: '1M' },
  { id: 'o3',                      displayName: 'o3',                   provider: 'openai',    category: 'frontier', contextK: '200K' },
  { id: 'grok-3',                  displayName: 'Grok-3',              provider: 'xai',       category: 'frontier', contextK: '131K' },

  // Fast & efficient
  { id: 'claude-sonnet-4-6',       displayName: 'Claude Sonnet 4',     provider: 'anthropic', category: 'fast', contextK: '200K' },
  { id: 'gpt-4o',                  displayName: 'GPT-4o',              provider: 'openai',    category: 'fast', contextK: '128K' },
  { id: 'gemini-2.5-flash',        displayName: 'Gemini 2.5 Flash',    provider: 'gemini',    category: 'fast', contextK: '1M' },
  { id: 'deepseek-chat',           displayName: 'DeepSeek Chat',       provider: 'deepseek',  category: 'fast', contextK: '65K' },
  { id: 'mistral-large-latest',    displayName: 'Mistral Large',       provider: 'mistral',   category: 'fast', contextK: '131K' },
  { id: 'llama-3.3-70b-versatile', displayName: 'Llama 3.3 70B',      provider: 'groq',      category: 'fast', contextK: '131K' },
  { id: 'claude-haiku-4-5-20251001', displayName: 'Claude Haiku 4.5',  provider: 'anthropic', category: 'fast', contextK: '200K' },

  // Reasoning
  { id: 'o1',                      displayName: 'o1',                   provider: 'openai',    category: 'reasoning', contextK: '200K' },
  { id: 'o4-mini',                 displayName: 'o4-mini',              provider: 'openai',    category: 'reasoning', contextK: '200K' },
  { id: 'deepseek-reasoner',       displayName: 'DeepSeek Reasoner',   provider: 'deepseek',  category: 'reasoning', contextK: '65K' },
];

interface DisplayEntry extends SetupModelEntry {
  baseUrl: string;
  needsKey: boolean;
  serverName?: string;
}

/** Format context window for display: 200000 → "200K", 1048576 → "1M" */
function formatCtx(tokens: number): string {
  if (tokens >= 1000000) return `${Math.round(tokens / 1048576)}M`;
  return `${Math.round(tokens / 1024)}K`;
}

/** Build the unified model list: local models first, then curated cloud models */
function buildModelList(
  localServers: Array<{ name: string; url: string; models: string[] }>,
  apiKeyStatus: Map<string, boolean>,
): DisplayEntry[] {
  const entries: DisplayEntry[] = [];

  // Local models (cap at 8, prioritize well-known models)
  const localPriority = ['qwen', 'deepseek', 'llama', 'phi', 'mistral', 'codellama'];
  for (const server of localServers) {
    const sorted = [...server.models].sort((a, b) => {
      const ai = localPriority.findIndex(p => a.toLowerCase().includes(p));
      const bi = localPriority.findIndex(p => b.toLowerCase().includes(p));
      return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
    });

    for (const model of sorted.slice(0, 8)) {
      const info = getModelInfo(model);
      entries.push({
        id: model,
        displayName: model,
        provider: 'local',
        category: 'local',
        contextK: formatCtx(info.contextWindow),
        baseUrl: server.url,
        needsKey: false,
        serverName: server.name,
      });
    }
  }

  // Cloud models from curated list
  for (const model of CURATED_CLOUD_MODELS) {
    const defaults = PROVIDER_DEFAULTS[model.provider];
    entries.push({
      ...model,
      baseUrl: defaults?.baseUrl || '',
      needsKey: !apiKeyStatus.get(model.provider),
    });
  }

  return entries;
}

function renderCategoryHeader(category: string): void {
  const headers: Record<string, string> = {
    local: 'LOCAL (free, private, runs on your machine)',
    frontier: 'CLOUD \u2014 FRONTIER (most capable)',
    fast: 'CLOUD \u2014 FAST & EFFICIENT',
    reasoning: 'CLOUD \u2014 REASONING',
  };
  const title = headers[category] || category.toUpperCase();
  console.log(`\n  ${fmt(title, 'bold')}`);
  console.log(`  ${fmt('\u2500'.repeat(48), 'dim')}`);
}

function renderModelRow(index: number, entry: DisplayEntry): void {
  const num = fmt(String(index).padStart(3), 'cyan');
  const name = entry.displayName.padEnd(26);
  const prov = (entry.serverName || PROVIDER_DISPLAY[entry.provider] || entry.provider).padEnd(11);
  const ctx = fmt((entry.contextK + ' ctx').padStart(9), 'dim');

  let keyStatus = '';
  if (entry.provider !== 'local') {
    keyStatus = entry.needsKey
      ? fmt('  needs key', 'yellow')
      : fmt('  \u2713 key set', 'green');
  }

  console.log(`  ${num}  ${name}${prov}${ctx}${keyStatus}`);
}

/** Fuzzy match a typed model name against all known models */
function fuzzyMatchModel(input: string, allModels: string[]): string | undefined {
  const lower = input.toLowerCase();
  // Exact match
  if (allModels.includes(input)) return input;
  // Case-insensitive exact
  const exact = allModels.find(m => m.toLowerCase() === lower);
  if (exact) return exact;
  // Prefix match
  const prefix = allModels.find(m => m.toLowerCase().startsWith(lower));
  if (prefix) return prefix;
  // Substring match
  const sub = allModels.find(m => m.toLowerCase().includes(lower));
  if (sub) return sub;
  return undefined;
}

// ── Setup wizard ─────────────────────────────────────────────────────────────

/** Interactive setup wizard — model-first flow */
export async function runSetup(): Promise<SavedConfig> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  console.log(fmt('\n\u26A1 CodeBot AI \u2014 Setup', 'bold'));
  console.log(fmt('   Let\'s get you configured.\n', 'dim'));

  // ── Phase A: Detection ──────────────────────────────────────────────────────
  console.log(fmt('Scanning for local LLM servers...', 'dim'));
  const localServers = await detectLocalServers();

  const apiKeyStatus = new Map<string, boolean>();
  for (const [provider, defaults] of Object.entries(PROVIDER_DEFAULTS)) {
    apiKeyStatus.set(provider, !!process.env[defaults.envKey]);
  }

  // Show detection results
  if (localServers.length > 0) {
    for (const server of localServers) {
      console.log(fmt(`  \u2713 ${server.name} detected (${server.models.length} models)`, 'green'));
    }
  } else {
    console.log(fmt('  No local servers found. Start Ollama for free local models: ollama.com', 'dim'));
  }

  const setKeys = [...apiKeyStatus.entries()].filter(([, set]) => set);
  for (const [prov] of setKeys) {
    const display = PROVIDER_DISPLAY[prov] || prov;
    console.log(fmt(`  \u2713 ${display} API key found`, 'green'));
  }

  // ── Phase B: Build & render model list ──────────────────────────────────────
  const modelList = buildModelList(localServers, apiKeyStatus);

  console.log(fmt('\nChoose a model:', 'bold'));

  let currentCategory = '';
  modelList.forEach((entry, i) => {
    if (entry.category !== currentCategory) {
      currentCategory = entry.category;
      renderCategoryHeader(currentCategory);
    }
    renderModelRow(i + 1, entry);
  });

  if (modelList.length === 0) {
    console.log(fmt('\n  No models available. Install Ollama or set a cloud API key.', 'yellow'));
    rl.close();
    return {};
  }

  // ── Phase C: Model selection ────────────────────────────────────────────────
  const allKnownModels = [
    ...Object.keys(MODEL_REGISTRY),
    ...localServers.flatMap(s => s.models),
  ];

  const choice = await ask(rl, fmt(`\nSelect [1-${modelList.length}] or type a model name: `, 'cyan'));

  let selectedModel: string;
  let selectedProvider: string;
  let selectedBaseUrl: string;
  let isLocal = false;

  const choiceNum = parseInt(choice, 10);
  if (choiceNum >= 1 && choiceNum <= modelList.length) {
    // User picked by number
    const entry = modelList[choiceNum - 1];
    selectedModel = entry.id;
    selectedProvider = entry.provider === 'local' ? 'openai' : entry.provider;
    selectedBaseUrl = entry.baseUrl;
    isLocal = entry.provider === 'local';
  } else if (choice.length > 1) {
    // User typed a model name — fuzzy match
    const matched = fuzzyMatchModel(choice, allKnownModels);
    selectedModel = matched || choice;
    const detected = detectProvider(selectedModel);
    selectedProvider = detected || 'openai';
    isLocal = !detected;

    if (isLocal) {
      const server = localServers.find(s => s.models.some(m =>
        m.toLowerCase() === selectedModel.toLowerCase() || m.toLowerCase().includes(selectedModel.toLowerCase())
      ));
      selectedBaseUrl = server?.url || 'http://localhost:11434';
    } else {
      selectedBaseUrl = PROVIDER_DEFAULTS[selectedProvider]?.baseUrl || '';
    }
  } else {
    // Empty or single char — default to first entry
    const entry = modelList[0];
    selectedModel = entry.id;
    selectedProvider = entry.provider === 'local' ? 'openai' : entry.provider;
    selectedBaseUrl = entry.baseUrl;
    isLocal = entry.provider === 'local';
  }

  console.log(fmt(`  \u2713 Selected: ${selectedModel}`, 'green'));

  // ── Phase D: API key resolution ─────────────────────────────────────────────
  let apiKey = '';

  if (!isLocal) {
    const defaults = PROVIDER_DEFAULTS[selectedProvider];
    const envKey = defaults?.envKey;
    const existingKey = envKey ? process.env[envKey] : undefined;
    const savedKey = loadConfig().apiKey;

    // Prefer saved config key over env var (user explicitly set it via --setup)
    if (savedKey) {
      const valid = await validateApiKey(selectedProvider, defaults?.baseUrl || '', savedKey);
      if (valid) {
        console.log(fmt(`  \u2713 Using saved API key from config`, 'green'));
        apiKey = savedKey;
      } else {
        console.log(fmt(`  \u2717 Saved API key is invalid or expired`, 'yellow'));
      }
    }

    if (!apiKey && existingKey) {
      const valid = await validateApiKey(selectedProvider, defaults?.baseUrl || '', existingKey);
      if (valid) {
        console.log(fmt(`  \u2713 Using ${envKey} from environment`, 'green'));
        apiKey = existingKey;
      } else {
        console.log(fmt(`  \u2717 ${envKey} from environment is invalid or expired`, 'yellow'));
      }
    }

    if (!apiKey && envKey) {
      const providerName = PROVIDER_DISPLAY[selectedProvider] || selectedProvider;
      const keyUrl = getKeyUrl(selectedProvider);

      console.log(fmt(`\n  ${selectedModel} requires a ${providerName} API key.`, 'yellow'));
      console.log(fmt(`  Get one at: ${keyUrl}`, 'dim'));

      apiKey = await ask(rl, fmt('\n  Paste your API key: ', 'cyan'));

      if (apiKey) {
        const valid = await validateApiKey(selectedProvider, defaults?.baseUrl || '', apiKey);
        if (!valid) {
          console.log(fmt(`  \u2717 API key validation failed. Saving anyway — check your key.`, 'yellow'));
        }
      } else {
        console.log(fmt(`\n  No key entered. Set it later:`, 'yellow'));
        console.log(fmt(`    export ${envKey}="your-key-here"`, 'dim'));
      }
    }
  }

  // ── Phase E: Autonomous mode ────────────────────────────────────────────────
  const autoChoice = await ask(rl, fmt('\nEnable autonomous mode? (skip permission prompts) [y/N]: ', 'cyan'));
  const autoApprove = autoChoice.toLowerCase().startsWith('y');

  rl.close();

  // ── Phase F: Save config + summary ──────────────────────────────────────────
  const config: SavedConfig = {
    model: selectedModel,
    provider: selectedProvider,
    baseUrl: selectedBaseUrl,
    autoApprove,
  };

  if (apiKey) {
    config.apiKey = apiKey;
  }

  saveConfig(config);

  console.log(fmt('\n\u2713 Config saved to ~/.codebot/config.json', 'green'));
  console.log(fmt(`  Model:    ${config.model}`, 'dim'));
  console.log(fmt(`  Provider: ${selectedProvider}${isLocal ? '' : ' (auto-detected)'}`, 'dim'));
  if (apiKey) {
    console.log(fmt(`  API Key:  ${'*'.repeat(Math.min(apiKey.length, 20))}`, 'dim'));
  }
  if (autoApprove) {
    console.log(fmt(`  Mode:     AUTONOMOUS`, 'yellow'));
  }
  console.log(fmt(`\nStarting CodeBot...\n`, 'dim'));

  return config;
}

/** Validate an API key by making a lightweight request to the provider */
async function validateApiKey(provider: string, baseUrl: string, apiKey: string): Promise<boolean> {
  try {
    const url = baseUrl || PROVIDER_DEFAULTS[provider]?.baseUrl;
    if (!url) return true; // can't validate, assume OK

    const headers: Record<string, string> = { 'Authorization': `Bearer ${apiKey}` };
    // Anthropic uses a different header
    if (provider === 'anthropic') {
      headers['x-api-key'] = apiKey;
      headers['anthropic-version'] = '2023-06-01';
      delete headers['Authorization'];
    }

    const res = await fetch(`${url}/models`, {
      method: 'GET',
      headers,
      signal: AbortSignal.timeout(5000),
    });
    return res.status !== 401 && res.status !== 403;
  } catch {
    return true; // network error = can't validate, assume OK
  }
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


// ── Auto-detect result ──────────────────────────────────────────────────────

export interface AutoDetectResult {
  type: 'auto-start' | 'one-question';
  model?: string;
  provider?: string;
  baseUrl?: string;
  apiKey?: string;
  localServers: Array<{ name: string; url: string; models: string[] }>;
  detectedKeys: Map<string, string>; // provider -> envKey name
}

// ── Model ranking for auto-pick ─────────────────────────────────────────────

const LOCAL_MODEL_RANKING: string[] = [
  'qwen2.5-coder:32b', 'qwen2.5-coder:14b', 'qwen3:32b', 'qwen3:14b',
  'deepseek-coder-v2:16b', 'deepseek-coder:33b', 'llama3.3:70b', 'llama3.1:70b',
  'codellama:34b', 'qwen2.5-coder:7b', 'qwen3:8b',
  'deepseek-coder:6.7b', 'mistral:7b', 'phi-4:14b', 'llama3.1:8b',
];

/** Pick the best local model from available models using coding capability ranking */
export function pickBestLocalModel(available: string[]): string | undefined {
  if (available.length === 0) return undefined;
  for (const ranked of LOCAL_MODEL_RANKING) {
    const match = available.find(m =>
      m.toLowerCase() === ranked.toLowerCase() ||
      m.toLowerCase().startsWith(ranked.split(':')[0].toLowerCase())
    );
    if (match) return match;
  }
  return available[0]; // fallback to first available
}

/** Best default model per cloud provider */
export const RECOMMENDED_MODELS: Record<string, { model: string; name: string }> = {
  anthropic: { model: 'claude-sonnet-4-6', name: 'Claude Sonnet 4' },
  openai:    { model: 'gpt-4o',            name: 'GPT-4o' },
  gemini:    { model: 'gemini-2.5-flash',  name: 'Gemini 2.5 Flash' },
  deepseek:  { model: 'deepseek-chat',     name: 'DeepSeek Chat' },
  groq:      { model: 'llama-3.3-70b-versatile', name: 'Llama 3.3 70B' },
  mistral:   { model: 'mistral-large-latest', name: 'Mistral Large' },
  xai:       { model: 'grok-3',            name: 'Grok-3' },
};

/** Provider priority order for auto-detection */
const PROVIDER_PRIORITY = ['anthropic', 'openai', 'gemini', 'deepseek', 'groq', 'mistral', 'xai'];

// ── Auto-detect ─────────────────────────────────────────────────────────────

/** Smart auto-detect: probe local servers + env keys, return best config */
export async function autoDetect(): Promise<AutoDetectResult> {
  // 1. Check if config already exists (returning user)
  const existing = loadConfig();
  if (existing.model && existing.provider) {
    return {
      type: 'auto-start',
      model: existing.model,
      provider: existing.provider,
      baseUrl: existing.baseUrl,
      apiKey: existing.apiKey,
      localServers: [],
      detectedKeys: new Map(),
    };
  }

  // 2. Detect local servers
  const localServers = await detectLocalServers();

  // 3. Detect env API keys
  const detectedKeys = new Map<string, string>();
  for (const [provider, defaults] of Object.entries(PROVIDER_DEFAULTS)) {
    if (process.env[defaults.envKey]) {
      detectedKeys.set(provider, defaults.envKey);
    }
  }

  // 4. Auto-start: local server with models?
  if (localServers.length > 0) {
    const allModels = localServers.flatMap(s => s.models);
    if (allModels.length > 0) {
      // pickBestLocalModel can return undefined (e.g., if the registry
      // has no matching entry). Guard explicitly instead of forcing `!`.
      const bestModel = pickBestLocalModel(allModels);
      if (bestModel) {
        const server = localServers.find(s => s.models.includes(bestModel));
        return {
          type: 'auto-start',
          model: bestModel,
          provider: 'openai', // Local servers use OpenAI-compatible API
          baseUrl: server?.url || localServers[0].url,
          localServers,
          detectedKeys,
        };
      }
    }
  }

  // 5. Auto-start: env API key?
  for (const prov of PROVIDER_PRIORITY) {
    // Bind the env-key name once so TS narrows it and we avoid the
    // previous `detectedKeys.get(prov)!` non-null assertion — which
    // would have produced `process.env[undefined]` (→ undefined) if
    // detectedKeys mutated between the `.has(prov)` check and the
    // `.get(prov)` read.
    const envKey = detectedKeys.get(prov);
    if (envKey) {
      const rec = RECOMMENDED_MODELS[prov];
      const defaults = PROVIDER_DEFAULTS[prov];
      return {
        type: 'auto-start',
        model: rec.model,
        provider: prov,
        baseUrl: defaults?.baseUrl,
        apiKey: process.env[envKey],
        localServers,
        detectedKeys,
      };
    }
  }

  // 6. Nothing found — need one question
  return {
    type: 'one-question',
    localServers,
    detectedKeys,
  };
}

// ── Quick setup (one question) ──────────────────────────────────────────────

/** Minimal one-question setup for when nothing is auto-detected */
export async function runQuickSetup(detected: AutoDetectResult): Promise<SavedConfig> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  // Import providerCard and guidedPrompts
  const { providerCard } = await import('./ui');

  const ollamaInstalled = detected.localServers.length > 0;

  const items = [
    {
      key: '1',
      icon: '\u{1F5A5}',
      name: 'Local (Ollama)',
      detail: 'free, private, runs on your machine',
      subtext: ollamaInstalled
        ? `\u2713 Ollama detected (${detected.localServers[0].models.length} models)`
        : 'Install: curl -fsSL https://ollama.com/install.sh | sh',
      recommended: true,
      available: ollamaInstalled,
    },
    {
      key: '2',
      icon: '\u{1F7E3}',
      name: 'Claude (Anthropic)',
      detail: 'best for code',
      subtext: 'Needs: ANTHROPIC_API_KEY',
      available: detected.detectedKeys.has('anthropic'),
    },
    {
      key: '3',
      icon: '\u{1F7E2}',
      name: 'GPT (OpenAI)',
      detail: 'widely used',
      subtext: 'Needs: OPENAI_API_KEY',
      available: detected.detectedKeys.has('openai'),
    },
    {
      key: '4',
      icon: '\u2B21',
      name: 'Other',
      detail: 'Gemini, DeepSeek, Groq, Mistral, xAI',
    },
  ];

  console.log('\n' + providerCard({ items }));

  const choice = await ask(rl, fmt('  Select [1-4]: ', 'cyan'));
  const choiceNum = parseInt(choice, 10);

  let config: SavedConfig = {};

  if (choiceNum === 1) {
    // Local (Ollama)
    if (ollamaInstalled && detected.localServers[0].models.length > 0) {
      const bestModel = pickBestLocalModel(detected.localServers[0].models);
      config = {
        model: bestModel,
        provider: 'openai',
        baseUrl: detected.localServers[0].url,
        autoApprove: true,
        firstRunComplete: true,
      };
      console.log(fmt(`  \u2713 Selected: ${bestModel}`, 'green'));
    } else {
      console.log(fmt('\n  To get started with Ollama:', 'bold'));
      console.log(fmt('  1. Install Ollama: https://ollama.com', 'dim'));
      console.log(fmt('  2. Pull a model:   ollama pull qwen2.5-coder', 'dim'));
      console.log(fmt('  3. Run codebot again\n', 'dim'));
      rl.close();
      return {};
    }
  } else if (choiceNum === 2 || choiceNum === 3) {
    // Claude or GPT
    const isAnthropic = choiceNum === 2;
    const prov = isAnthropic ? 'anthropic' : 'openai';
    const rec = RECOMMENDED_MODELS[prov];
    const defaults = PROVIDER_DEFAULTS[prov];
    const envKey = defaults?.envKey || '';
    const existingKey = process.env[envKey];

    // Check saved config key first, then env var, then prompt
    const savedKey = loadConfig().apiKey;
    let resolvedKey = '';

    if (savedKey) {
      const valid = await validateApiKey(prov, defaults?.baseUrl || '', savedKey);
      if (valid) {
        console.log(fmt(`  \u2713 Using saved API key from config`, 'green'));
        resolvedKey = savedKey;
      } else {
        console.log(fmt(`  \u2717 Saved API key is invalid`, 'yellow'));
      }
    }
    if (!resolvedKey && existingKey) {
      const valid = await validateApiKey(prov, defaults?.baseUrl || '', existingKey);
      if (valid) {
        console.log(fmt(`  \u2713 Using ${envKey} from environment`, 'green'));
        resolvedKey = existingKey;
      } else {
        console.log(fmt(`  \u2717 ${envKey} from environment is invalid`, 'yellow'));
      }
    }
    if (!resolvedKey) {
      const keyUrl = getKeyUrl(prov);
      console.log(fmt(`\n  Get your API key at: ${keyUrl}`, 'dim'));
      resolvedKey = await ask(rl, fmt('  Paste your API key: ', 'cyan'));
    }

    if (resolvedKey) {
      config = {
        model: rec.model,
        provider: prov,
        baseUrl: defaults?.baseUrl,
        apiKey: resolvedKey,
        autoApprove: true,
        firstRunComplete: true,
      };
      console.log(fmt(`  \u2713 Selected: ${rec.name}`, 'green'));
    } else {
      console.log(fmt(`\n  No key entered. Set it later:`, 'yellow'));
      console.log(fmt(`    export ${envKey}="your-key-here"\n`, 'dim'));
      rl.close();
      return {};
    }
  } else if (choiceNum === 4) {
    // Other providers sub-menu
    console.log(fmt('\n  Choose provider:', 'bold'));
    const others = [
      { key: '1', prov: 'gemini',  name: 'Gemini (Google)' },
      { key: '2', prov: 'deepseek', name: 'DeepSeek' },
      { key: '3', prov: 'groq',    name: 'Groq' },
      { key: '4', prov: 'mistral', name: 'Mistral' },
      { key: '5', prov: 'xai',     name: 'xAI (Grok)' },
    ];
    for (const o of others) {
      const hasKey = detected.detectedKeys.has(o.prov);
      const status = hasKey ? fmt(' \u2713', 'green') : '';
      console.log(fmt(`  [${o.key}]  ${o.name}${status}`, 'dim'));
    }
    const subChoice = await ask(rl, fmt('\n  Select [1-5]: ', 'cyan'));
    const subNum = parseInt(subChoice, 10);
    const selected = others[(subNum >= 1 && subNum <= 5) ? subNum - 1 : 0];
    const prov = selected.prov;
    const rec = RECOMMENDED_MODELS[prov];
    const defaults = PROVIDER_DEFAULTS[prov];
    const envKey = defaults?.envKey || '';
    const existingKey = process.env[envKey];

    // Check saved config key first, then env var, then prompt
    const savedKey2 = loadConfig().apiKey;
    let resolvedKey2 = '';

    if (savedKey2) {
      const valid = await validateApiKey(prov, defaults?.baseUrl || '', savedKey2);
      if (valid) {
        console.log(fmt(`  \u2713 Using saved API key from config`, 'green'));
        resolvedKey2 = savedKey2;
      } else {
        console.log(fmt(`  \u2717 Saved API key is invalid`, 'yellow'));
      }
    }
    if (!resolvedKey2 && existingKey) {
      const valid = await validateApiKey(prov, defaults?.baseUrl || '', existingKey);
      if (valid) {
        console.log(fmt(`  \u2713 Using ${envKey} from environment`, 'green'));
        resolvedKey2 = existingKey;
      } else {
        console.log(fmt(`  \u2717 ${envKey} from environment is invalid`, 'yellow'));
      }
    }
    if (!resolvedKey2) {
      const keyUrl = getKeyUrl(prov);
      console.log(fmt(`\n  Get your API key at: ${keyUrl}`, 'dim'));
      resolvedKey2 = await ask(rl, fmt('  Paste your API key: ', 'cyan'));
    }

    if (resolvedKey2) {
      config = {
        model: rec.model,
        provider: prov,
        baseUrl: defaults?.baseUrl,
        apiKey: resolvedKey2,
        autoApprove: true,
        firstRunComplete: true,
      };
      console.log(fmt(`  \u2713 Selected: ${rec.name}`, 'green'));
    } else {
      console.log(fmt(`\n  No key entered. Set it later:`, 'yellow'));
      console.log(fmt(`    export ${envKey}="your-key-here"\n`, 'dim'));
      rl.close();
      return {};
    }
  } else {
    // Invalid choice
    console.log(fmt('  Invalid selection. Run codebot --setup to try again.\n', 'yellow'));
    rl.close();
    return {};
  }

  rl.close();

  if (config.model) {
    saveConfig(config);
    console.log(fmt('  \u2713 Config saved\n', 'green'));
  }
  return config;
}

/** Full setup wizard — kept for --setup flag (backward compat) */
export const runFullSetup = runSetup;
