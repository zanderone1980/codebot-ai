export interface ModelInfo {
  contextWindow: number;
  supportsToolCalling: boolean;
  supportsCaching?: boolean;
  supportsVision?: boolean;
  supportsJsonMode?: boolean;
  tier?: 'fast' | 'standard' | 'powerful';
  provider?: string;
}

/** Default base URLs for cloud providers */
export const PROVIDER_DEFAULTS: Record<string, { baseUrl: string; envKey: string }> = {
  anthropic: { baseUrl: 'https://api.anthropic.com', envKey: 'ANTHROPIC_API_KEY' },
  openai: { baseUrl: 'https://api.openai.com', envKey: 'OPENAI_API_KEY' },
  gemini: { baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai', envKey: 'GEMINI_API_KEY' },
  deepseek: { baseUrl: 'https://api.deepseek.com', envKey: 'DEEPSEEK_API_KEY' },
  groq: { baseUrl: 'https://api.groq.com/openai', envKey: 'GROQ_API_KEY' },
  mistral: { baseUrl: 'https://api.mistral.ai', envKey: 'MISTRAL_API_KEY' },
  xai: { baseUrl: 'https://api.x.ai', envKey: 'XAI_API_KEY' },
};

export const MODEL_REGISTRY: Record<string, ModelInfo> = {
  // ── Ollama / Local Models ──────────────────────────────────────────────────
  'qwen2.5-coder:32b': { contextWindow: 32768, supportsToolCalling: true },
  'qwen2.5-coder:14b': { contextWindow: 32768, supportsToolCalling: true },
  'qwen2.5-coder:7b': { contextWindow: 32768, supportsToolCalling: true },
  'qwen2.5-coder:3b': { contextWindow: 32768, supportsToolCalling: true },
  'qwen3:32b': { contextWindow: 32768, supportsToolCalling: true },
  'qwen3:14b': { contextWindow: 32768, supportsToolCalling: true },
  'qwen3:8b': { contextWindow: 32768, supportsToolCalling: true },
  'deepseek-coder-v2:16b': { contextWindow: 16384, supportsToolCalling: true },
  'deepseek-coder:33b': { contextWindow: 16384, supportsToolCalling: false },
  'codellama:34b': { contextWindow: 16384, supportsToolCalling: false },
  'llama3.1:70b': { contextWindow: 131072, supportsToolCalling: true },
  'llama3.1:8b': { contextWindow: 131072, supportsToolCalling: true },
  'llama3.2:3b': { contextWindow: 131072, supportsToolCalling: true },
  'llama3.3:70b': { contextWindow: 131072, supportsToolCalling: true },
  'mistral:7b': { contextWindow: 32768, supportsToolCalling: true },
  'mixtral:8x7b': { contextWindow: 32768, supportsToolCalling: true },
  'phi-3:14b': { contextWindow: 4096, supportsToolCalling: false },
  'phi-4:14b': { contextWindow: 16384, supportsToolCalling: true },
  'starcoder2:15b': { contextWindow: 16384, supportsToolCalling: false },
  'granite-code:34b': { contextWindow: 8192, supportsToolCalling: false },
  'gemma2:27b': { contextWindow: 8192, supportsToolCalling: true },
  'command-r:35b': { contextWindow: 131072, supportsToolCalling: true },

  // ── Anthropic / Claude ─────────────────────────────────────────────────────
  'claude-opus-4-6': { contextWindow: 200000, supportsToolCalling: true, supportsCaching: true, supportsVision: true, provider: 'anthropic' },
  'claude-sonnet-4-6': { contextWindow: 200000, supportsToolCalling: true, supportsCaching: true, supportsVision: true, provider: 'anthropic' },
  'claude-sonnet-4-20250514': { contextWindow: 200000, supportsToolCalling: true, supportsCaching: true, supportsVision: true, provider: 'anthropic' },
  'claude-haiku-4-5-20251001': { contextWindow: 200000, supportsToolCalling: true, supportsCaching: true, supportsVision: true, provider: 'anthropic' },
  'claude-3-5-sonnet-20241022': { contextWindow: 200000, supportsToolCalling: true, supportsCaching: true, supportsVision: true, provider: 'anthropic' },
  'claude-3-5-haiku-20241022': { contextWindow: 200000, supportsToolCalling: true, supportsCaching: true, supportsVision: true, provider: 'anthropic' },

  // ── OpenAI ─────────────────────────────────────────────────────────────────
  'gpt-4o': { contextWindow: 128000, supportsToolCalling: true, supportsCaching: true, supportsVision: true, supportsJsonMode: true, provider: 'openai' },
  'gpt-4o-mini': { contextWindow: 128000, supportsToolCalling: true, supportsCaching: true, supportsVision: true, supportsJsonMode: true, provider: 'openai' },
  'gpt-4-turbo': { contextWindow: 128000, supportsToolCalling: true, supportsVision: true, supportsJsonMode: true, provider: 'openai' },
  'gpt-4.1': { contextWindow: 1047576, supportsToolCalling: true, supportsCaching: true, supportsVision: true, supportsJsonMode: true, provider: 'openai' },
  'gpt-4.1-mini': { contextWindow: 1047576, supportsToolCalling: true, supportsCaching: true, supportsVision: true, supportsJsonMode: true, provider: 'openai' },
  'gpt-4.1-nano': { contextWindow: 1047576, supportsToolCalling: true, supportsCaching: true, supportsVision: true, supportsJsonMode: true, provider: 'openai' },
  'o1': { contextWindow: 200000, supportsToolCalling: true, supportsCaching: true, provider: 'openai' },
  'o1-mini': { contextWindow: 128000, supportsToolCalling: true, supportsCaching: true, provider: 'openai' },
  'o3': { contextWindow: 200000, supportsToolCalling: true, supportsCaching: true, supportsVision: true, provider: 'openai' },
  'o3-mini': { contextWindow: 200000, supportsToolCalling: true, supportsCaching: true, provider: 'openai' },
  'o4-mini': { contextWindow: 200000, supportsToolCalling: true, supportsCaching: true, supportsVision: true, provider: 'openai' },
  'gpt-5.4': { contextWindow: 1000000, supportsToolCalling: true, supportsCaching: true, supportsVision: true, supportsJsonMode: true, provider: 'openai' },
  'gpt-5.4-mini': { contextWindow: 1000000, supportsToolCalling: true, supportsCaching: true, supportsVision: true, supportsJsonMode: true, provider: 'openai' },
  'gpt-5.4-nano': { contextWindow: 1000000, supportsToolCalling: true, supportsCaching: true, supportsVision: true, supportsJsonMode: true, provider: 'openai' },
  'gpt-5-codex': { contextWindow: 1000000, supportsToolCalling: true, supportsCaching: true, supportsVision: true, supportsJsonMode: true, provider: 'openai' },
  'gpt-5.4': { contextWindow: 1000000, supportsToolCalling: true, supportsCaching: true, supportsVision: true, supportsJsonMode: true, provider: 'openai' },
  'gpt-5.4-mini': { contextWindow: 1000000, supportsToolCalling: true, supportsCaching: true, supportsVision: true, supportsJsonMode: true, provider: 'openai' },
  'gpt-5.4-nano': { contextWindow: 1000000, supportsToolCalling: true, supportsCaching: true, supportsVision: true, supportsJsonMode: true, provider: 'openai' },
  'gpt-5-codex': { contextWindow: 1000000, supportsToolCalling: true, supportsCaching: true, supportsVision: true, supportsJsonMode: true, provider: 'openai' },

  // ── Google Gemini (OpenAI-compatible endpoint) ─────────────────────────────
  'gemini-2.5-pro': { contextWindow: 1048576, supportsToolCalling: true, supportsCaching: true, supportsVision: true, supportsJsonMode: true, provider: 'gemini' },
  'gemini-2.5-flash': { contextWindow: 1048576, supportsToolCalling: true, supportsCaching: true, supportsVision: true, supportsJsonMode: true, provider: 'gemini' },
  'gemini-2.0-flash': { contextWindow: 1048576, supportsToolCalling: true, supportsCaching: true, supportsVision: true, supportsJsonMode: true, provider: 'gemini' },
  'gemini-1.5-pro': { contextWindow: 2097152, supportsToolCalling: true, supportsCaching: true, supportsVision: true, supportsJsonMode: true, provider: 'gemini' },
  'gemini-1.5-flash': { contextWindow: 1048576, supportsToolCalling: true, supportsCaching: true, supportsVision: true, supportsJsonMode: true, provider: 'gemini' },

  // ── DeepSeek (OpenAI-compatible) ───────────────────────────────────────────
  'deepseek-chat': { contextWindow: 65536, supportsToolCalling: true, provider: 'deepseek' },
  'deepseek-reasoner': { contextWindow: 65536, supportsToolCalling: true, provider: 'deepseek' },

  // ── Groq (OpenAI-compatible, fast inference) ───────────────────────────────
  'llama-3.3-70b-versatile': { contextWindow: 131072, supportsToolCalling: true, provider: 'groq' },
  'llama-3.1-8b-instant': { contextWindow: 131072, supportsToolCalling: true, provider: 'groq' },
  'mixtral-8x7b-32768': { contextWindow: 32768, supportsToolCalling: true, provider: 'groq' },
  'gemma2-9b-it': { contextWindow: 8192, supportsToolCalling: true, provider: 'groq' },

  // ── Mistral (OpenAI-compatible) ────────────────────────────────────────────
  'mistral-large-latest': { contextWindow: 131072, supportsToolCalling: true, supportsJsonMode: true, provider: 'mistral' },
  'mistral-small-latest': { contextWindow: 131072, supportsToolCalling: true, supportsJsonMode: true, provider: 'mistral' },
  'codestral-latest': { contextWindow: 32768, supportsToolCalling: true, supportsJsonMode: true, provider: 'mistral' },

  // ── xAI / Grok (OpenAI-compatible) ─────────────────────────────────────────
  'grok-3': { contextWindow: 131072, supportsToolCalling: true, provider: 'xai' },
  'grok-3-mini': { contextWindow: 131072, supportsToolCalling: true, provider: 'xai' },
};

export function getModelInfo(model: string): ModelInfo {
  if (MODEL_REGISTRY[model]) return MODEL_REGISTRY[model];

  // Prefix match (e.g., "qwen2.5-coder" matches "qwen2.5-coder:32b")
  for (const [key, info] of Object.entries(MODEL_REGISTRY)) {
    if (key.startsWith(model) || model.startsWith(key.split(':')[0])) {
      return info;
    }
  }

  // Default: conservative 8K context, no native tool calling
  return { contextWindow: 8192, supportsToolCalling: false };
}

/** Detect provider from model name */
export function detectProvider(model: string): string | undefined {
  const info = getModelInfo(model);
  if (info.provider) return info.provider;

  // Heuristic detection from model name prefixes
  if (model.startsWith('claude')) return 'anthropic';
  if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4') || model.startsWith('gpt-5')) return 'openai';
  if (model.startsWith('gemini')) return 'gemini';
  if (model.startsWith('deepseek')) return 'deepseek';
  if (model.startsWith('grok')) return 'xai';
  if (model.startsWith('mistral') || model.startsWith('codestral')) return 'mistral';
  if (model.includes('groq') || model.startsWith('llama-')) return 'groq';

  return undefined; // local/ollama
}
