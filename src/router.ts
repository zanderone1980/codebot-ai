/**
 * Model Router for CodeBot.
 *
 * Auto-selects the optimal model per turn based on task complexity.
 * Uses cheap/fast models for simple tasks and reasoning-capable models
 * for complex ones.
 *
 * Tiers (per §6 of `docs/personal-agent-infrastructure.md`):
 *   fast       — read_file, glob, grep, think, memory   (e.g. Haiku, gpt-4o-mini)
 *   strong     — edit_file, write_file, git, execute    (e.g. Sonnet, gpt-4-class flagship)
 *   reasoning  — multi-file refactor, code review,
 *                security audit, architecture           (e.g. Opus, o-series reasoning)
 *
 * The doc defines task classes and routing rules; specific model
 * identifiers live in `~/.codebot/config.json` under `router`. When new
 * model versions ship, only the config changes — this table doesn't.
 *
 * Pattern: stateless, fail-open. `selectModel` returns the default
 * model on any error or when `config.enabled === false`. The agent
 * loop additionally falls open to the default model when a tier
 * resolution would force a cross-provider switch (PR 5: same-provider
 * routing only; cross-provider routing is deferred).
 */

export type ModelTier = 'fast' | 'strong' | 'reasoning';

export interface RouterConfig {
  enabled: boolean;
  /** Model to use for fast/simple tasks (default tier for triage / summarize / browser-read). */
  fastModel?: string;
  /** Model to use for strong tasks (default tier for coding / drafting). */
  strongModel?: string;
  /** Model to use for reasoning tasks (default tier for code review / security / sensitive actions). */
  reasoningModel?: string;
}

/** Tools that are read-only or lightweight — safe to run on fast tier */
const FAST_TOOLS = new Set([
  'read_file', 'glob', 'grep', 'think', 'memory',
  'multi_search', 'code_analysis', 'diff_viewer',
  'image_info', 'pdf_extract', 'task_planner',
]);

/** Tools that modify state but are bounded — strong tier */
const STRONG_TOOLS = new Set([
  'edit_file', 'write_file', 'git', 'execute',
  'web_fetch', 'web_search', 'http_client',
  'database', 'test_runner', 'package_manager',
  'notification',
]);

/** Tools that require deep reasoning or are high-risk — reasoning tier */
const REASONING_TOOLS = new Set([
  'batch_edit', 'browser', 'ssh_remote', 'docker',
  'code_review', 'routine',
]);

/**
 * Classify the complexity of a user message.
 * Heuristic-based: looks at message length, keywords, and intent.
 */
export function classifyComplexity(userMessage: string, lastToolCalls?: string[]): ModelTier {
  const msg = userMessage.toLowerCase();
  const wordCount = msg.split(/\s+/).length;

  // ── Reasoning-tier indicators (keywords) ──
  const reasoningPatterns = [
    /refactor/i, /architect/i, /redesign/i, /security\s*(scan|audit|review)/i,
    /migrate/i, /optimize\s+(?:the|all|every)/i, /rewrite/i,
    /implement.*(?:system|feature|module)/i, /design\s+(?:a|the)/i,
    /fix.*(?:all|every|across)/i, /review.*(?:code|pr|pull)/i,
    /debug.*(?:complex|hard|tricky)/i, /multi.*file/i,
    /create.*(?:api|server|service|app|project)/i,
  ];
  if (reasoningPatterns.some(p => p.test(msg))) return 'reasoning';
  if (wordCount > 80) return 'reasoning'; // Long complex instructions

  // ── Check last tool calls BEFORE short-message heuristic ──
  // "continue" / "keep going" should inherit the tier from the last tools used
  if (lastToolCalls?.length) {
    const anyReasoning = lastToolCalls.some(tc => REASONING_TOOLS.has(tc));
    const allFast = lastToolCalls.every(tc => FAST_TOOLS.has(tc));
    if (anyReasoning) return 'reasoning';
    if (allFast) return 'fast';
    return 'strong';
  }

  // ── Strong-tier indicators (write operations, moderate tasks) ──
  const strongPatterns = [
    /^(edit|update|change|add|fix|modify|write|delete|remove|rename|move|install|run|test|build|commit|push|deploy)/i,
  ];
  if (strongPatterns.some(p => p.test(msg))) return 'strong';

  // ── Fast indicators ──
  const fastPatterns = [
    /^(read|show|cat|print|display|list|find|search|grep|glob)/i,
    /^what\s+(is|are|does)/i, /^how\s+(do|does|to)/i,
    /^(check|look|see)\s/i, /^(tell|explain|describe)/i,
    /\?((\s*$)|(\s+\w{0,5}$))/i, // Short questions
  ];
  if (fastPatterns.some(p => p.test(msg))) return 'fast';
  if (wordCount <= 8) return 'fast'; // Very short messages

  // ── Default: strong ──
  return 'strong';
}

/**
 * Get the recommended model tier based on tool calls in the last assistant response.
 * Called between agent iterations to downgrade/upgrade the model.
 */
export function classifyToolTier(toolNames: string[]): ModelTier {
  if (toolNames.length === 0) return 'strong';

  // If any tool is reasoning-tier, use reasoning
  if (toolNames.some(t => REASONING_TOOLS.has(t))) return 'reasoning';

  // If all tools are fast-tier, use fast
  if (toolNames.every(t => FAST_TOOLS.has(t))) return 'fast';

  return 'strong';
}

/**
 * Select the model for a given tier from the router config.
 * Falls back to the default model if no tier-specific model is configured.
 */
export function selectModel(tier: ModelTier, config: RouterConfig, defaultModel: string): string {
  if (!config.enabled) return defaultModel;

  switch (tier) {
    case 'fast':
      return config.fastModel || defaultModel;
    case 'strong':
      return config.strongModel || defaultModel;
    case 'reasoning':
      return config.reasoningModel || defaultModel;
    default:
      return defaultModel;
  }
}

/** Auto-detect tier models from the default model's provider family */
export function autoDetectTierModels(defaultModel: string): Partial<RouterConfig> {
  const model = defaultModel.toLowerCase();

  // Anthropic family
  if (model.includes('claude')) {
    return {
      fastModel: 'claude-3-5-haiku-20241022',
      strongModel: 'claude-sonnet-4-6',
      reasoningModel: 'claude-opus-4-6',
    };
  }

  // OpenAI family
  if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')) {
    return {
      fastModel: 'gpt-4o-mini',
      strongModel: 'gpt-4o',
      reasoningModel: 'o3',
    };
  }

  // Gemini family
  if (model.startsWith('gemini')) {
    return {
      fastModel: 'gemini-2.0-flash',
      strongModel: 'gemini-2.5-flash',
      reasoningModel: 'gemini-2.5-pro',
    };
  }

  // DeepSeek
  if (model.startsWith('deepseek')) {
    return {
      fastModel: 'deepseek-chat',
      strongModel: 'deepseek-chat',
      reasoningModel: 'deepseek-reasoner',
    };
  }

  // Groq
  if (model.includes('groq') || model.startsWith('llama-')) {
    return {
      fastModel: 'llama-3.1-8b-instant',
      strongModel: 'llama-3.3-70b-versatile',
      reasoningModel: 'llama-3.3-70b-versatile',
    };
  }

  // No auto-detection possible
  return {};
}
