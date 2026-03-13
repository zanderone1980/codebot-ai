/**
 * Configuration resolution and provider creation.
 * Extracted from cli.ts for maintainability.
 */

import { OpenAIProvider } from '../providers/openai';
import { AnthropicProvider } from '../providers/anthropic';
import { detectProvider, PROVIDER_DEFAULTS } from '../providers/registry';
import { Config, LLMProvider } from '../types';
import { loadConfig } from '../setup';

const C = {
  reset: '\x1b[0m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
};

function c(text: string, style: keyof typeof C): string {
  return `${C[style]}${text}${C.reset}`;
}

export function createProvider(config: Config): LLMProvider {
  if (config.provider === 'anthropic') {
    return new AnthropicProvider({
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

  if (!config.apiKey && explicitProvider) {
    const defaults = PROVIDER_DEFAULTS[config.provider];
    if (defaults) config.apiKey = process.env[defaults.envKey] || '';
  }
  if (!config.apiKey && saved.apiKey) {
    config.apiKey = saved.apiKey;
  }
  if (!config.apiKey) {
    const defaults = PROVIDER_DEFAULTS[config.provider];
    if (defaults) config.apiKey = process.env[defaults.envKey] || '';
  }
  if (!config.apiKey) {
    config.apiKey = process.env.CODEBOT_API_KEY || process.env.OPENAI_API_KEY || '';
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
