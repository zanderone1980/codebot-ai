/**
 * Model Router for CodeBot v2.1.6
 *
 * Auto-selects the optimal model per turn based on task complexity.
 * Uses cheap/fast models for simple tasks and powerful models for complex ones.
 *
 * Tiers:
 *   fast     — read_file, glob, grep, think, memory  (haiku, flash, grok-mini, gpt-4o-mini)
 *   standard — edit_file, write_file, git, execute    (sonnet, gpt-4o, gemini-pro)
 *   powerful — multi-file refactor, security scan, architecture  (opus, o3, gemini-2.5-pro)
 *
 * Pattern: stateless, fail-open (defaults to configured model on any error).
 */

export type ModelTier = 'fast' | 'standard' | 'powerful';

export interface RouterConfig {
  enabled: boolean;
  /** Model to use for fast/simple tasks */
  fastModel?: string;
  /** Model to use for standard tasks */
  standardModel?: string;
  /** Model to use for powerful/complex tasks */
  powerfulModel?: string;
}

/** Tools that are read-only or lightweight — safe to run on fast tier */
const FAST_TOOLS = new Set([
  'read_file', 'glob', 'grep', 'think', 'memory',
  'multi_search', 'code_analysis', 'diff_viewer',
  'image_info', 'pdf_extract', 'task_planner',
]);

/** Tools that modify state but are bounded — standard tier */
const STANDARD_TOOLS = new Set([
  'edit_file', 'write_file', 'git', 'execute',
  'web_fetch', 'web_search', 'http_client',
  'database', 'test_runner', 'package_manager',
  'notification',
]);

/** Tools that require deep reasoning or are high-risk — powerful tier */
const POWERFUL_TOOLS = new Set([
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

  // ── Powerful indicators (keywords) ──
  const powerfulPatterns = [
    /refactor/i, /architect/i, /redesign/i, /security\s*(scan|audit|review)/i,
    /migrate/i, /optimize\s+(?:the|all|every)/i, /rewrite/i,
    /implement.*(?:system|feature|module)/i, /design\s+(?:a|the)/i,
    /fix.*(?:all|every|across)/i, /review.*(?:code|pr|pull)/i,
    /debug.*(?:complex|hard|tricky)/i, /multi.*file/i,
    /create.*(?:api|server|service|app|project)/i,
  ];
  if (powerfulPatterns.some(p => p.test(msg))) return 'powerful';
  if (wordCount > 80) return 'powerful'; // Long complex instructions

  // ── Check last tool calls BEFORE short-message heuristic ──
  // "continue" / "keep going" should inherit the tier from the last tools used
  if (lastToolCalls?.length) {
    const anyPowerful = lastToolCalls.some(tc => POWERFUL_TOOLS.has(tc));
    const allFast = lastToolCalls.every(tc => FAST_TOOLS.has(tc));
    if (anyPowerful) return 'powerful';
    if (allFast) return 'fast';
    return 'standard';
  }

  // ── Standard indicators (write operations, moderate tasks) ──
  const standardPatterns = [
    /^(edit|update|change|add|fix|modify|write|delete|remove|rename|move|install|run|test|build|commit|push|deploy)/i,
  ];
  if (standardPatterns.some(p => p.test(msg))) return 'standard';

  // ── Fast indicators ──
  const fastPatterns = [
    /^(read|show|cat|print|display|list|find|search|grep|glob)/i,
    /^what\s+(is|are|does)/i, /^how\s+(do|does|to)/i,
    /^(check|look|see)\s/i, /^(tell|explain|describe)/i,
    /\?((\s*$)|(\s+\w{0,5}$))/i, // Short questions
  ];
  if (fastPatterns.some(p => p.test(msg))) return 'fast';
  if (wordCount <= 8) return 'fast'; // Very short messages

  // ── Default: standard ──
  return 'standard';
}

/**
 * Get the recommended model tier based on tool calls in the last assistant response.
 * Called between agent iterations to downgrade/upgrade the model.
 */
export function classifyToolTier(toolNames: string[]): ModelTier {
  if (toolNames.length === 0) return 'standard';

  // If any tool is powerful-tier, use powerful
  if (toolNames.some(t => POWERFUL_TOOLS.has(t))) return 'powerful';

  // If all tools are fast-tier, use fast
  if (toolNames.every(t => FAST_TOOLS.has(t))) return 'fast';

  return 'standard';
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
    case 'standard':
      return config.standardModel || defaultModel;
    case 'powerful':
      return config.powerfulModel || defaultModel;
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
      standardModel: 'claude-sonnet-4-6',
      powerfulModel: 'claude-opus-4-6',
    };
  }

  // OpenAI family
  if (model.startsWith('gpt-') || model.startsWith('o1') || model.startsWith('o3') || model.startsWith('o4')) {
    return {
      fastModel: 'gpt-4o-mini',
      standardModel: 'gpt-4o',
      powerfulModel: 'o3',
    };
  }

  // Gemini family
  if (model.startsWith('gemini')) {
    return {
      fastModel: 'gemini-2.0-flash',
      standardModel: 'gemini-2.5-flash',
      powerfulModel: 'gemini-2.5-pro',
    };
  }

  // DeepSeek
  if (model.startsWith('deepseek')) {
    return {
      fastModel: 'deepseek-chat',
      standardModel: 'deepseek-chat',
      powerfulModel: 'deepseek-reasoner',
    };
  }

  // Groq
  if (model.includes('groq') || model.startsWith('llama-')) {
    return {
      fastModel: 'llama-3.1-8b-instant',
      standardModel: 'llama-3.3-70b-versatile',
      powerfulModel: 'llama-3.3-70b-versatile',
    };
  }

  // No auto-detection possible
  return {};
}
