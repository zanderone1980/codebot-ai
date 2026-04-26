/**
 * Configuration resolution and provider creation.
 * Extracted from cli.ts for maintainability.
 */

import { OpenAIProvider } from '../providers/openai';
import { OpenAIResponsesProvider, modelRequiresResponsesApi } from '../providers/openai-responses';
import { AnthropicProvider } from '../providers/anthropic';
import { detectProvider, PROVIDER_DEFAULTS } from '../providers/registry';
import { Config, LLMProvider } from '../types';
import { loadConfig, pickProviderKey, isProviderDisabled } from '../setup';

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

export async function resolveConfig(args: Record<string, string | boolean>): Promise<Config> {
  const saved = loadConfig();

  const model = (args.model as string) || process.env.CODEBOT_MODEL || saved.model || 'qwen2.5-coder:32b';
  const detected = detectProvider(model);

  const explicitProvider = args.provider as string | undefined;
  const config: Config = {
    provider: explicitProvider || process.env.CODEBOT_PROVIDER || saved.provider || detected || 'openai',
    model,
    baseUrl: (args['base-url'] as string) || process.env.CODEBOT_BASE_URL || '',
    apiKey: (args['api-key'] as string) || '',
    maxIterations: Math.max(1, Math.min(parseInt((args['max-iterations'] as string) || String(saved.maxIterations || 50), 10) || 50, 500)),
    autoApprove: !!args['auto-approve'] || !!args.autonomous || !!args.auto || !!saved.autoApprove,
    // Router config from saved settings only (PR 5: no CLI flag yet).
    // Absent or `enabled: false` → routing OFF, identical to pre-PR-5.
    router: saved.router,
  };

  if (!config.baseUrl) {
    if (explicitProvider) {
      const defaults = PROVIDER_DEFAULTS[config.provider];
      if (defaults) config.baseUrl = defaults.baseUrl;
    } else {
      config.baseUrl = saved.baseUrl || '';
    }
  }
  if (!config.baseUrl) {
    const defaults = PROVIDER_DEFAULTS[config.provider];
    if (defaults) config.baseUrl = defaults.baseUrl;
  }

  // Key precedence (most specific wins):
  //   1. --api-key CLI arg (already in config.apiKey if passed)
  //   2. Provider-specific env var (OPENAI_API_KEY for openai, etc.)
  //      — only when --provider was explicit, so we don't override saved
  //      cross-provider keys with a stale env var
  //   3. Saved provider-specific key (saved.openaiApiKey for openai, etc.)
  //   4. Saved generic apiKey
  //   5. Provider-specific env var (catch-all)
  //   6. Generic env vars (CODEBOT_API_KEY, OPENAI_API_KEY, ANTHROPIC_API_KEY)
  if (!config.apiKey && explicitProvider) {
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
    config.apiKey = process.env.CODEBOT_API_KEY || process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY || '';
  }

  if (!config.baseUrl) {
    config.baseUrl = await autoDetectProvider();
  }

  if (config.baseUrl && !config.baseUrl.startsWith('http://') && !config.baseUrl.startsWith('https://')) {
    console.log(c(`  \u26a0 Invalid base URL: "${config.baseUrl}". Must start with http:// or https://`, 'yellow'));
    config.baseUrl = 'http://localhost:11434';
  }

  const isLocal = config.baseUrl.includes('localhost') || config.baseUrl.includes('127.0.0.1');
  if (!isLocal && !config.apiKey) {
    console.log(c(`  \u26a0 No API key found for ${config.provider}. Run: codebot --setup`, 'yellow'));
  }

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
        console.log(c(`  \u2713 ${name} detected on ${url}`, 'green'));
        return url;
      }
    } catch {
      // not running
    }
  }

  console.log(c('  \u26a0 No local LLM detected. Start Ollama or set --base-url', 'yellow'));
  return 'http://localhost:11434';
}
