/**
 * Configuration resolution and provider creation.
 * Extracted from cli.ts for maintainability.
 */

import { OpenAIProvider } from '../providers/openai';
import { OpenAIResponsesProvider, modelRequiresResponsesApi } from '../providers/openai-responses';
import { AnthropicProvider } from '../providers/anthropic';
import { detectProvider, PROVIDER_DEFAULTS } from '../providers/registry';
import { Config, LLMProvider } from '../types';
import { loadConfig, pickProviderKey, isProviderDisabled, SavedConfig } from '../setup';
import { parseAllowCapabilityFlag, CapabilityAllowlistError } from '../capability-allowlist';

const C = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
};

function c(text: string, style: keyof typeof C): string {
  return `${C[style]}${text}${C.reset}`;
}

export function createProvider(config: Config): LLMProvider {
  // Hard block: refuse to instantiate a provider the user banned.
  // Throws a stub provider that yields a clear error message instead
  // of silently routing elsewhere, so the user knows exactly why.
  const saved = loadConfig();
  if (isProviderDisabled(saved, config.provider)) {
    return {
      name: config.model,
      async *chat() {
        yield {
          type: 'error',
          error: `Provider "${config.provider}" is disabled in ~/.codebot/config.json (disabledProviders). Pick a different model/provider, or remove it from disabledProviders to re-enable.`,
        };
      },
    } as LLMProvider;
  }

  if (config.provider === 'anthropic') {
    return new AnthropicProvider({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
    });
  }

  // Route gpt-5.4 family + codex variants through OpenAI's newer Responses
  // API (POST /v1/responses) — these models are NOT available on the
  // chat-completions endpoint and previously returned 404 from CodeBot.
  if (modelRequiresResponsesApi(config.model)) {
    return new OpenAIResponsesProvider({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
    });
  }

  return new OpenAIProvider({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
  });
}

// ── Config resolution helpers ────────────────────────────────────────────────

/** Resolve --allow-capability: validate and parse the raw string. */
function resolveCapabilities(
  args: Record<string, string | boolean>,
  config: Config,
): void {
  if (args['allow-capability'] === undefined) return;
  const raw = args['allow-capability'] as string;
  if (!raw || !raw.trim()) {
    // PR 11 — empty value is a hard error, not silent ignore.
    throw new CapabilityAllowlistError(
      '--allow-capability requires a comma-separated list of labels ' +
      '(e.g., --allow-capability account-access,net-fetch). Got empty value.',
    );
  }
  config.allowedCapabilities = parseAllowCapabilityFlag(raw);
}

/**
 * Resolve baseUrl with precedence:
 *   1. --base-url CLI arg (already in config.baseUrl if passed)
 *   2. Saved baseUrl (when not overriding provider explicitly)
 *   3. Provider defaults
 *   4. Auto-detect (Ollama / LM Studio / vLLM)
 */
async function resolveBaseUrl(
  config: Config,
  saved: SavedConfig,
  explicitProvider: string | undefined,
): Promise<void> {
  if (config.baseUrl) return; // CLI arg wins

  if (explicitProvider) {
    const defaults = PROVIDER_DEFAULTS[config.provider];
    if (defaults?.baseUrl) { config.baseUrl = defaults.baseUrl; return; }
  } else {
    config.baseUrl = saved.baseUrl || '';
  }

  if (!config.baseUrl) {
    const defaults = PROVIDER_DEFAULTS[config.provider];
    if (defaults?.baseUrl) { config.baseUrl = defaults.baseUrl; return; }
  }

  if (!config.baseUrl) {
    config.baseUrl = await autoDetectProvider();
  }
}

/**
 * Resolve API key with precedence (most specific wins):
 *   1. --api-key CLI arg (already in config.apiKey if passed)
 *   2. Provider env var, only when --provider was explicit
 *   3. Saved provider-specific key
 *   4. Provider env var (catch-all)
 *   5. Generic env vars (CODEBOT_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY)
 */
function resolveApiKey(
  config: Config,
  saved: SavedConfig,
  explicitProvider: string | undefined,
): void {
  if (config.apiKey) return; // CLI arg wins

  if (explicitProvider) {
    const defaults = PROVIDER_DEFAULTS[config.provider];
    if (defaults) config.apiKey = process.env[defaults.envKey] || '';
  }
  if (!config.apiKey) {
    const savedKey = pickProviderKey(saved, config.provider);
    if (savedKey) config.apiKey = savedKey;
  }
  if (!config.apiKey) {
    const defaults = PROVIDER_DEFAULTS[config.provider];
    if (defaults) config.apiKey = process.env[defaults.envKey] || '';
  }
  if (!config.apiKey) {
    config.apiKey =
      process.env.CODEBOT_API_KEY ||
      process.env.OPENAI_API_KEY ||
      process.env.ANTHROPIC_API_KEY ||
      '';
  }
}

/** Validate the resolved baseUrl and warn if missing API key. */
function validateResolved(config: Config): void {
  if (config.baseUrl && !config.baseUrl.startsWith('http://') && !config.baseUrl.startsWith('https://')) {
    console.log(c(`  ⚠ Invalid base URL: "${config.baseUrl}". Must start with http:// or https://`, 'yellow'));
    config.baseUrl = 'http://localhost:11434';
  }
  const isLocal = config.baseUrl.includes('localhost') || config.baseUrl.includes('127.0.0.1');
  if (!isLocal && !config.apiKey) {
    console.log(c(`  ⚠ No API key found for ${config.provider}. Run: codebot --setup`, 'yellow'));
  }
}

// ── Main resolver ────────────────────────────────────────────────────────────

export async function resolveConfig(args: Record<string, string | boolean>): Promise<Config> {
  const saved = loadConfig();
  const model = (args.model as string) || process.env.CODEBOT_MODEL || saved.model || 'qwen2.5-coder:32b';
  const detected = detectProvider(model);
  const explicitProvider = args.provider as string | undefined;

  const maxIter = parseInt((args['max-iterations'] as string) || String(saved.maxIterations || 50), 10) || 50;
  const config: Config = {
    provider: explicitProvider || process.env.CODEBOT_PROVIDER || saved.provider || detected || 'openai',
    model,
    baseUrl: (args['base-url'] as string) || process.env.CODEBOT_BASE_URL || '',
    apiKey: (args['api-key'] as string) || '',
    maxIterations: Math.max(1, Math.min(maxIter, 500)),
    autoApprove:
      !!args['auto-approve'] ||
      !!args.autonomous ||
      !!args.auto ||
      !!saved.autoApprove ||
      !!process.env.CODEBOT_AUTO_APPROVE,
    // Router config from saved settings only (PR 5: no CLI flag yet).
    // Absent or `enabled: false` → routing OFF, identical to pre-PR-5.
    router: saved.router,
    // Budget config from saved settings only (PR 6: no CLI flag yet).
    // Absent or `perSessionCapUsd: 0` → no user-set cap. The existing
    // `policy.limits.cost_limit_usd` path still applies independently.
    budget: saved.budget,
    disableConstitutional: !!args['no-constitutional'],
  };

  resolveCapabilities(args, config);
  await resolveBaseUrl(config, saved, explicitProvider);
  resolveApiKey(config, saved, explicitProvider);
  validateResolved(config);

  return config;
}

export async function autoDetectProvider(): Promise<string> {
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
