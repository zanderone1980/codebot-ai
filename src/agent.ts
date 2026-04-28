import * as readline from 'readline';
import { Message, ToolCall, AgentEvent, LLMProvider, Tool, ToolStreamEvents } from './types';
import { ToolRegistry } from './tools';
import { parseToolCalls } from './parser';
import { ContextManager } from './context/manager';
import { isFatalError } from './retry';
import { getModelInfo } from './providers/registry';
import { lastScreenshotData } from './tools/browser';
import { loadPlugins } from './plugins';
import { ToolCache } from './cache';
import { RateLimiter } from './rate-limiter';
import { ProviderRateLimiter } from './provider-rate-limiter';
import { AuditLogger } from './audit';
import { PolicyEnforcer, loadPolicy } from './policy';
import { TokenTracker } from './telemetry';
import { MetricsCollector } from './metrics';
import { RiskScorer, RiskAssessment } from './risk';
import { ConstitutionalLayer } from './constitutional';
import { AgentStateEngine } from './spark-soul';
import { UserProfile } from './user-profile';
import { validateToolArgs, repairToolCallMessages } from './agent/message-repair';
import { PreparedCall, ToolExecutorDeps, executeToolBatch, executeSingleTool, TOOL_TYPE_MAP } from './agent/tool-executor';
import { buildSystemPrompt } from './agent/prompt-builder';
import { ExecutionAuditor } from './execution-auditor';
import { CrossSessionLearning } from './cross-session';
import { ExperientialMemory } from './experiential-memory';
import { TaskStateStore } from './task-state';
import { escalatePermissionFromCapabilityLabels } from './capability-gating';
import type { CapabilityLabel } from './types';
import { classifyComplexity, selectModel, RouterConfig } from './router';
import { detectProvider } from './providers/registry';
import type { BudgetConfig } from './setup';
import { log } from './logger';

/** Permission callback type — risk and sandbox info are optional for backwards compat */
type AskPermissionFn = (
  tool: string,
  args: Record<string, unknown>,
  risk?: RiskAssessment,
  sandbox?: { sandbox: boolean; network: boolean },
) => Promise<boolean>;

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableSerialize(v)).join(',')}]`;
  }
  if (value && typeof value === 'object') {
    const entries = Object.entries(value as Record<string, unknown>)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, val]) => `${JSON.stringify(key)}:${stableSerialize(val)}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value);
}

function buildToolExecutionSignature(toolName: string, args: Record<string, unknown>): string {
  return `${toolName}:${stableSerialize(args)}`;
}

// Tool execution constants and logic moved to ./agent/tool-executor.ts

export class Agent {
  private provider: LLMProvider;
  private tools: ToolRegistry;
  private context: ContextManager;
  private messages: Message[] = [];
  private maxIterations: number;
  private autoApprove: boolean;
  /**
   * PR 11 — capability labels the user has explicitly opted into for
   * unattended bypass via `--allow-capability`. Empty / undefined ⇒ no
   * capability gate is bypassable in this session, i.e. the §7
   * invariant "every capability-driven gate prompts" holds. Validated
   * by `parseAllowCapabilityFlag` before construction; never includes
   * the four NEVER_ALLOWABLE labels.
   */
  private allowedCapabilities: ReadonlySet<CapabilityLabel>;
  private model: string;
  /** Default model — pinned at construction; the router compares against this on fallback. */
  private defaultModel: string;
  /** Provider family name (e.g. 'anthropic', 'openai'). Used by the router to refuse cross-provider switches. */
  private providerFamily: string;
  /** Optional model-router config (PR 5). Absent → routing OFF (byte-identical to pre-PR-5). */
  private routerConfig: RouterConfig | undefined;
  /** PR 6 — effective per-session cost cap in USD. 0 = no cap. Stricter of policy + user config. */
  private effectiveBudgetCapUsd: number = 0;
  /** PR 6 — sources of the effective cap, for audit transparency. */
  private budgetCapSources: { policyUsd: number; userUsd: number } = { policyUsd: 0, userUsd: 0 };
  /** PR 6 — fractional thresholds at which to emit `budget_warning`. */
  private budgetThresholds: number[] = [0.5, 0.75, 0.95];
  /** PR 6 — thresholds already crossed in this session (each fires once). */
  private budgetThresholdsCrossed: Set<number> = new Set();
  private cache: ToolCache;
  private rateLimiter: RateLimiter;
  private providerRateLimiter: ProviderRateLimiter;
  private auditLogger: AuditLogger;
  private policyEnforcer: PolicyEnforcer;
  private tokenTracker: TokenTracker;
  private metricsCollector: MetricsCollector;
  private riskScorer: RiskScorer;
  private constitutional: ConstitutionalLayer | null = null;
  private stateEngine: AgentStateEngine | null = null;
  private userProfile: UserProfile;
  private executionAuditor: ExecutionAuditor;
  private crossSession: CrossSessionLearning;
  private experientialMemory: ExperientialMemory;
  private taskState: TaskStateStore;
  private sessionToolCalls: Array<{ tool: string; success: boolean }> = [];
  private cordBlockedKeys: Set<string> = new Set();
  private static readonly MAX_SESSION_TOOL_CALLS = 500;
  private static readonly MAX_CORD_BLOCKED_KEYS = 200;
  private sessionStartedAt: string = new Date().toISOString();
  private sessionGoal: string = '';

  private projectRoot: string;
  private branchCreated: boolean = false;
  private lastExecutedTools: string[] = [];
  private askPermission: AskPermissionFn;
  private onMessage?: (message: Message) => void;
  private vaultMode?: { vaultPath: string; writable: boolean; networkAllowed: boolean };

  constructor(opts: {
    provider: LLMProvider;
    model: string;
    providerName?: string;
    maxIterations?: number;
    autoApprove?: boolean;
    projectRoot?: string;
    askPermission?: AskPermissionFn;
    onMessage?: (message: Message) => void;
    constitutional?: { enabled?: boolean; vigilEnabled?: boolean; hardBlockEnabled?: boolean };
    /**
     * Optional model-router config (PR 5 of personal-agent-infrastructure.md).
     * Absent or `enabled: false` → routing OFF, model stays at `opts.model`
     * for every turn (byte-identical to pre-PR-5 behavior).
     */
    routerConfig?: RouterConfig;
    /**
     * Optional budget config (PR 6 of personal-agent-infrastructure.md).
     * Absent or `perSessionCapUsd: 0` → no user-set cap. Combined with
     * `policy.limits.cost_limit_usd`: stricter (smaller, non-zero) wins.
     */
    budgetConfig?: BudgetConfig;
    /**
     * Override the AuditLogger's log directory. Tests pass an isolated
     * tempdir so they don't pollute the user's `~/.codebot/audit/`.
     * Production code omits this, falling back to the default vault
     * location. Honesty-pass discovery: pre-this-fix, every test that
     * did `new Agent(...)` wrote audit entries into the user's real
     * audit log, mixing test sessions with production sessions. See
     * §12 / §13 of the architecture doc.
     */
    auditDir?: string;
    /**
     * PR 11 — capability labels the user has explicitly allowlisted via
     * `--allow-capability`. Validated upstream (parseAllowCapabilityFlag).
     * If undefined or empty, every capability-driven gate continues to
     * require interactive approval per §7.
     */
    allowedCapabilities?: ReadonlySet<CapabilityLabel>;
    /**
     * Vault Mode — when set, the agent behaves as a read-only research
     * assistant over a folder of markdown notes rather than an
     * autonomous coding agent. The system prompt, tool set, and default
     * permissions all shift. See src/agent/vault-prompt.ts.
     */
    vaultMode?: {
      vaultPath: string;
      writable: boolean;
      networkAllowed: boolean;
    };
  }) {
    this.provider = opts.provider;
    this.model = opts.model;
    this.defaultModel = opts.model;
    // Provider family for cross-provider safety check. Use the explicit
    // providerName if given, otherwise infer from the model string.
    this.providerFamily = opts.providerName || detectProvider(opts.model) || 'unknown';
    this.routerConfig = opts.routerConfig;
    this.projectRoot = opts.projectRoot || process.cwd();
    this.vaultMode = opts.vaultMode;

    // Load policy FIRST — tools need it for filesystem/git enforcement
    this.policyEnforcer = new PolicyEnforcer(loadPolicy(this.projectRoot), this.projectRoot);

    this.tools = new ToolRegistry(this.projectRoot, this.policyEnforcer, { vaultMode: this.vaultMode });
    this.context = new ContextManager(opts.model, opts.provider);

    // Use policy-defined max iterations as default, CLI overrides
    this.maxIterations = opts.maxIterations || this.policyEnforcer.getMaxIterations();
    this.autoApprove = opts.autoApprove || false;
    this.allowedCapabilities = opts.allowedCapabilities ?? new Set<CapabilityLabel>();
    this.askPermission = opts.askPermission || defaultAskPermission;
    this.onMessage = opts.onMessage;
    this.cache = new ToolCache();
    this.rateLimiter = new RateLimiter();
    this.providerRateLimiter = new ProviderRateLimiter(opts.providerName || 'local');
    this.auditLogger = new AuditLogger(opts.auditDir);

    // PR 11 — emit a single session-start audit row recording which
    // capability labels (if any) the user opted into via
    // `--allow-capability`. The row hash-chains into the rest of the
    // session like any other audit entry, so a forensic reader can
    // answer "was this session running with a bypass allowlist?"
    // without reading config or argv. Empty allowlist still emits a
    // row — silent absence is what we explicitly fixed in §12.
    if (this.allowedCapabilities.size > 0) {
      this.auditLogger.log({
        tool: 'capability',
        action: 'capability_allow',
        args: { labels: [...this.allowedCapabilities].sort() },
        reason:
          'session-start allowlist via --allow-capability; bypasses ' +
          'capability-driven prompts only for these labels and only when ' +
          '--auto-approve is also set',
      });
    }

    // Token & cost tracking
    this.tokenTracker = new TokenTracker(opts.model, opts.providerName || 'unknown');
    this.metricsCollector = new MetricsCollector();
    this.riskScorer = new RiskScorer();
    // Initialize constitutional safety layer (CORD + VIGIL)
    if (opts.constitutional?.enabled !== false) {
      try {
        this.constitutional = new ConstitutionalLayer(opts.constitutional);
        this.constitutional.start();
      } catch (e) {
        log.warn(`[CodeBot] Failed to initialize constitutional layer: ${(e as Error).message}`);
      }
    }

    this.userProfile = new UserProfile();

    // Autonomy systems: execution auditing + cross-session learning
    this.executionAuditor = new ExecutionAuditor();
    this.crossSession = new CrossSessionLearning();
    this.experientialMemory = new ExperientialMemory();
    this.taskState = new TaskStateStore(this.projectRoot);

    // Initialize agent state engine
    try {
      this.stateEngine = new AgentStateEngine(this.projectRoot);
      if (!this.stateEngine.isActive) this.stateEngine = null;
    } catch (e) {
      log.warn(`[CodeBot] Failed to initialize state engine: ${(e as Error).message}`);
    }

    // PR 6 — Effective budget cap is the stricter (smaller, non-zero)
    // of policy.limits.cost_limit_usd and SavedConfig.budget.perSessionCapUsd.
    // Either source alone behaves as before; both set takes the min.
    const policyLimit = this.policyEnforcer.getCostLimitUsd();
    const userLimit = opts.budgetConfig?.perSessionCapUsd ?? 0;
    let effectiveLimit = 0;
    if (policyLimit > 0 && userLimit > 0) {
      effectiveLimit = Math.min(policyLimit, userLimit);
    } else if (policyLimit > 0) {
      effectiveLimit = policyLimit;
    } else if (userLimit > 0) {
      effectiveLimit = userLimit;
    }
    this.budgetCapSources = { policyUsd: policyLimit, userUsd: userLimit };
    this.effectiveBudgetCapUsd = effectiveLimit;
    if (effectiveLimit > 0) this.tokenTracker.setCostLimit(effectiveLimit);
    if (opts.budgetConfig?.warnThresholds) {
      // Validate: drop anything outside (0, 1] to keep audit semantics sane.
      this.budgetThresholds = opts.budgetConfig.warnThresholds
        .filter((t) => t > 0 && t <= 1)
        .sort((a, b) => a - b);
    }

    // Load plugins
    try {
      const plugins = loadPlugins(this.projectRoot);
      for (const plugin of plugins) {
        this.tools.register(plugin);
      }
    } catch (e) {
      log.warn(`[CodeBot] Failed to initialize plugins: ${(e as Error).message}`);
    }

    // Connectors, GraphicsTool, and AppConnectorTool are registered by ToolRegistry
    // constructor (tools/index.ts) — single source of truth for all 12 connectors.

    // Load skills as tools (independent of connectors)
    try {
      const { loadSkills, skillToTool } = require('./skills');
      const skills = loadSkills();
      for (const skill of skills) {
        // SECURITY — skill inner steps MUST replay the full gate chain.
        //
        // The original callback called `t.execute(args)` directly, which
        // meant a skill step running `execute`, `write_file`, `app`, etc.
        // bypassed schema validation, policy, risk, CORD, SPARK,
        // capability check, permission, and audit — a variant of the
        // same bypass POST /api/command/tool/run had. Any skill shipped
        // or user-defined could be a back-door to those layers.
        //
        // Routing through `runSingleTool` applies the same gates every
        // other tool call goes through. `interactivePrompt: true`
        // matches the agent-loop execution context (REPL readline or
        // dashboard-injected permission UI); the HTTP endpoint blocks
        // `skill_*` at the outer gate (see src/dashboard/command-api.ts)
        // so no HTTP request ever reaches this callback.
        const toolExec = async (name: string, args: Record<string, unknown>): Promise<string> => {
          if (!this.tools.get(name)) return `Error: tool "${name}" not found`;
          const outcome = await this.runSingleTool(name, args, { interactivePrompt: true });
          return outcome.result;
        };
        this.tools.register(skillToTool(skill, toolExec));
      }
    } catch (e) {
      log.warn(`[CodeBot] Failed to initialize skills: ${(e as Error).message}`);
    }

    this.refreshSystemPrompt();
  }

  /** Update auto-approve mode at runtime (e.g., from /auto command) */
  setAutoApprove(value: boolean) {
    this.autoApprove = value;
  }

  /** Replace the permission callback at runtime (e.g., from CLI to inject UI cards) */
  setAskPermission(fn: AskPermissionFn) {
    this.askPermission = fn;
  }

  /** Load messages from a previous session for resume */
  loadMessages(messages: Message[]) {
    this.messages = [...messages];
    this.refreshSystemPrompt();
  }

  /** Reset conversation state for a new chat */
  resetConversation() {
    this.messages = [];
    this.refreshSystemPrompt();
    this.cordBlockedKeys.clear();
    this.sessionToolCalls = [];
    this.sessionGoal = '';
    this.sessionStartedAt = new Date().toISOString();
  }

  /**
   * Hot-swap the LLM provider (e.g., when the dashboard model-picker changes).
   *
   * Also resets conversation state — there is no safe way to continue a
   * conversation across provider boundaries since message formats differ.
   * The dashboard always calls this as part of "new conversation" anyway.
   */
  setProvider(provider: LLMProvider, model: string, providerName?: string) {
    this.provider = provider;
    this.model = model;
    // PR 5: re-anchor the router's "default" to the new explicit choice.
    // Otherwise the router would keep falling back to a stale model from
    // the previous provider when the dashboard swaps mid-session.
    this.defaultModel = model;
    this.providerFamily = providerName || detectProvider(model) || 'unknown';
    // Context window varies by model — recreate to pick up the new value.
    this.context = new ContextManager(model, provider);
    // Rate-limiter and token tracker are per-provider/model metadata.
    this.providerRateLimiter = new ProviderRateLimiter(providerName || 'local');
    this.tokenTracker = new TokenTracker(model, providerName || 'unknown');
    this.resetConversation();
  }

  /**
   * PR 5 — capability-router model selection. Called once per agent-loop
   * iteration. Reads `this.routerConfig`, `this.messages`, and
   * `this.lastExecutedTools` to decide whether to swap `this.model`.
   *
   * Failure modes — all fail-open:
   *   - routerConfig undefined or `enabled: false` → no-op.
   *   - latest user message empty / no recent tool calls → no-op.
   *   - desired tier model is the same as current → no-op.
   *   - desired tier model lives on a different provider family →
   *     fall open to current model, write `router:fallback` audit
   *     entry. (Same-provider only in PR 5; cross-provider deferred.)
   *   - any thrown error → caught, no model mutation, swallowed.
   *
   * Audit entries on success: `router:switch` with from/to/tier.
   */
  private maybeRouteModel(): void {
    if (!this.routerConfig || !this.routerConfig.enabled) return;

    try {
      const lastUserMsg = this.findLastUserMessage();
      if (!lastUserMsg) return;

      const tier = classifyComplexity(lastUserMsg, this.lastExecutedTools.slice(-5));
      const desiredModel = selectModel(tier, this.routerConfig, this.defaultModel);
      if (desiredModel === this.model) {
        // PR 11 — receipt-gap fix. Pre-PR-11 this was a silent return,
        // which made the question "did the router actually run this
        // turn?" unanswerable from the audit chain alone. The PR-brief
        // run on 2026-04-26 surfaced this: 4 model requests, router
        // enabled, zero `router:*` rows in the session. We could not
        // tell from logs whether the router fired and chose the
        // current model, or never fired at all. One row per turn is
        // small (~250 bytes) and gives the audit log the answer.
        this.auditLogger.log({
          tool: 'router',
          action: 'no_op',
          args: { tier, currentModel: this.model },
          reason: `tier "${tier}" already routes to current model "${this.model}"; no swap`,
          result: 'no_op',
        });
        return;
      }

      // Single-provider-family-only safety check (PR 5).
      const desiredFamily = detectProvider(desiredModel);
      if (desiredFamily && desiredFamily !== this.providerFamily) {
        this.auditLogger.log({
          tool: 'router',
          action: 'fallback',
          args: { tier, desiredModel, desiredFamily, currentFamily: this.providerFamily },
          reason: `cross-provider routing not supported in PR 5: tier "${tier}" wants ${desiredModel} (${desiredFamily}), current is ${this.providerFamily}; staying on ${this.model}`,
          result: 'fallback',
        });
        return;
      }

      // Same-provider switch — log the swap and update the model. The
      // existing provider object accepts model as a per-call argument
      // via `this.model`, so we don't re-instantiate. Cross-provider
      // re-instantiation is deferred to a later PR.
      const from = this.model;
      this.auditLogger.log({
        tool: 'router',
        action: 'switch',
        args: { tier, from, to: desiredModel },
        reason: `routed to "${tier}" tier`,
        result: 'success',
      });
      this.model = desiredModel;
    } catch (err) {
      // Fail open — never let the router crash the agent loop.
      log.warn(`[router] maybeRouteModel failed; staying on ${this.model}: ${(err as Error).message}`);
    }
  }

  private findLastUserMessage(): string | undefined {
    for (let i = this.messages.length - 1; i >= 0; i--) {
      const m = this.messages[i];
      if (m.role === 'user' && typeof m.content === 'string' && m.content.trim().length > 0) {
        return m.content;
      }
    }
    return undefined;
  }

  /**
   * PR 6 — emit `budget_warning` audits when session cost first crosses
   * each configured threshold (default 50/75/95% of effective cap).
   * Each threshold fires at most once per session.
   *
   * No-op when no cap is set, when thresholds are empty, or when all
   * thresholds have already been crossed.
   */
  private checkBudgetThresholds(): void {
    if (this.effectiveBudgetCapUsd <= 0) return;
    if (this.budgetThresholds.length === 0) return;
    const ratio = this.tokenTracker.getTotalCost() / this.effectiveBudgetCapUsd;
    for (const threshold of this.budgetThresholds) {
      if (ratio >= threshold && !this.budgetThresholdsCrossed.has(threshold)) {
        this.budgetThresholdsCrossed.add(threshold);
        this.auditLogger.log({
          tool: 'budget',
          action: 'budget_warning',
          args: {
            threshold,
            ratio,
            totalCostUsd: this.tokenTracker.getTotalCost(),
            effectiveCapUsd: this.effectiveBudgetCapUsd,
            remainingUsd: this.tokenTracker.getRemainingBudget(),
          },
          reason: `budget at ${(ratio * 100).toFixed(0)}% of effective cap ($${this.effectiveBudgetCapUsd.toFixed(2)})`,
          result: 'warn',
        });
      }
    }
  }

  /**
   * Toggle Vault Mode at runtime (called from the dashboard's
   * /api/command/vault endpoint). Pass a vaultMode object to enable,
   * or null/undefined to return to the standard coding-agent mode.
   *
   * Enabling does three things:
   *   1. chdir the process into the vault path so file tools operate
   *      there (matches the CLI --vault behavior)
   *   2. Rebuild ToolRegistry with vault gating (read-only by default,
   *      network off by default) so the agent literally cannot call
   *      disallowed tools — not just asked nicely not to
   *   3. Replace the system prompt via refreshSystemPrompt()
   *
   * Also resets the conversation since cross-mode message history is
   * incoherent (different tool set, different prompt semantics).
   */
  setVaultMode(vaultMode: { vaultPath: string; writable: boolean; networkAllowed: boolean } | null): void {
    if (vaultMode) {
      // chdir into the vault so read_file / grep / glob etc. resolve
      // relative paths correctly. Matches CLI --vault behavior.
      try { process.chdir(vaultMode.vaultPath); } catch { /* caller validated path; ignore */ }
      this.projectRoot = vaultMode.vaultPath;
      this.vaultMode = { ...vaultMode };
    } else {
      this.vaultMode = undefined;
      // Don't chdir back — caller may have moved on; leaving cwd alone
      // is safer than guessing where to put the user.
    }
    // Rebuild tools with new gating. Policy enforcer is preserved.
    this.tools = new ToolRegistry(this.projectRoot, this.policyEnforcer, { vaultMode: this.vaultMode });
    this.resetConversation();
  }

  /** Read-only accessor for the dashboard status endpoint. */
  getVaultMode(): { vaultPath: string; writable: boolean; networkAllowed: boolean } | null {
    return this.vaultMode ? { ...this.vaultMode } : null;
  }

  async *run(userMessage: string, images?: import('./types').ImageAttachment[]): AsyncGenerator<AgentEvent> {
    const userMsg: Message = { role: 'user', content: userMessage };
    if (images && images.length > 0) userMsg.images = images;
    this.messages.push(userMsg);
    const tracksTask = this.taskState.beginTurn(userMessage);
    this.userProfile.learnFromMessage('user', userMessage);
    this.userProfile.flushIfDirty();
    const activeGoal = this.taskState.getActiveGoal();
    if (activeGoal) this.sessionGoal = activeGoal;
    else if (!this.sessionGoal) this.sessionGoal = userMessage.substring(0, 200);
    this.refreshSystemPrompt();
    this.onMessage?.(userMsg);

    if (!this.context.fitsInBudget(this.messages)) {
      try {
        const result = await this.context.compactWithSummary(this.messages);
        this.messages = result.messages;
        yield { type: 'compaction', text: result.summary || 'Context compacted to fit budget.' };
      } catch {
        this.messages = this.context.compact(this.messages, true);
        yield { type: 'compaction', text: 'Context compacted (summary unavailable).' };
      }
    }

    // Circuit breaker: track consecutive identical errors
    let consecutiveErrors = 0;
    let lastErrorMsg = '';

    for (let i = 0; i < this.maxIterations; i++) {
      // Validate message integrity: ensure every tool_call has a matching tool response
      // This prevents cascading 400 errors from OpenAI when a previous call failed
      this.messages = repairToolCallMessages(this.messages);
      this.refreshSystemPrompt();

      // Model router (PR 5 of personal-agent-infrastructure.md). When
      // `routerConfig?.enabled === true`, classify the latest user message
      // + recent tool calls into a tier and pick the configured model
      // for that tier. Falls open to the current model on any error or
      // if the desired model would force a cross-provider switch.
      // When `routerConfig` is absent or `enabled: false`, this block
      // is a complete no-op — `this.model` is never mutated.
      this.maybeRouteModel();

      // Budget guard (PR 6 of personal-agent-infrastructure.md). Pre-call
      // check: if the session has already reached the effective cap,
      // refuse to fire another model call. Threshold audits are emitted
      // here too so the user has visibility before exhaustion.
      //
      // Honest scope: this prevents *additional* calls once at/over cap.
      // It does not estimate the *next* call's cost in advance — that's
      // deferred (needs tokenizer + per-model output ceilings).
      this.checkBudgetThresholds();
      if (this.tokenTracker.isOverBudget()) {
        const cost = this.tokenTracker.getTotalCost();
        const cap = this.effectiveBudgetCapUsd;
        this.auditLogger.log({
          tool: 'budget',
          action: 'budget_block',
          args: {
            totalCostUsd: cost,
            effectiveCapUsd: cap,
            policyCapUsd: this.budgetCapSources.policyUsd,
            userCapUsd: this.budgetCapSources.userUsd,
          },
          reason: `budget exhausted: $${cost.toFixed(4)} ≥ $${cap.toFixed(2)}`,
          result: 'block',
        });
        const errorMessage = `Cost limit exceeded ($${cost.toFixed(4)} / $${cap.toFixed(2)}). Stopping. Raise the cap in ~/.codebot/config.json under \`budget.perSessionCapUsd\` or end the session.`;
        this.finishRun(false, errorMessage, tracksTask);
        yield { type: 'error', error: errorMessage };
        return;
      }

      const supportsTools = getModelInfo(this.model).supportsToolCalling;
      const toolSchemas = supportsTools ? this.tools.getSchemas() : undefined;

      let fullText = '';
      let toolCalls: ToolCall[] = [];
      let streamError: string | null = null;
      let streamTokenCount = 0;
      const streamStartTime = Date.now();
      let lastProgressTime = 0;

      // Stream LLM response — wrapped in try-catch for resilience
      try {
        await this.providerRateLimiter.acquire();
        for await (const event of this.provider.chat(this.messages, toolSchemas)) {
          switch (event.type) {
            case 'text':
              fullText += event.text || '';
              streamTokenCount += (event.text || '').length > 0 ? 1 : 0;
              yield { type: 'text', text: event.text };
              // Stream progress update every 500ms
              {
                const now = Date.now();
                if (now - lastProgressTime >= 500) {
                  const elapsedMs = now - streamStartTime;
                  const tps = elapsedMs > 0 ? Math.round((streamTokenCount / elapsedMs) * 1000) : 0;
                  yield {
                    type: 'stream_progress',
                    streamProgress: { tokensGenerated: streamTokenCount, tokensPerSecond: tps, elapsedMs },
                  };
                  lastProgressTime = now;
                }
              }
              break;
            case 'thinking':
              yield { type: 'thinking', text: event.text };
              break;
            case 'tool_call_end':
              if (event.toolCall) {
                toolCalls.push(event.toolCall as ToolCall);
              }
              break;
            case 'usage':
              // Track tokens and cost
              if (event.usage) {
                this.tokenTracker.recordUsage(event.usage.inputTokens || 0, event.usage.outputTokens || 0);
                // Attribute cost to last-executed tools (split evenly)
                if (this.lastExecutedTools.length > 0) {
                  const perTool = Math.ceil((event.usage.inputTokens || 0) / this.lastExecutedTools.length);
                  const perToolOut = Math.ceil((event.usage.outputTokens || 0) / this.lastExecutedTools.length);
                  for (const tn of this.lastExecutedTools) {
                    this.tokenTracker.recordToolCost(tn, perTool, perToolOut);
                  }
                  this.lastExecutedTools = [];
                }
                this.providerRateLimiter.recordTokens((event.usage.inputTokens || 0) + (event.usage.outputTokens || 0));
                this.metricsCollector.increment('llm_requests_total');
                this.metricsCollector.increment(
                  'llm_tokens_total',
                  { direction: 'input' },
                  event.usage.inputTokens || 0,
                );
                this.metricsCollector.increment(
                  'llm_tokens_total',
                  { direction: 'output' },
                  event.usage.outputTokens || 0,
                );

                // Prompt caching metrics (v2.1.6)
                if (event.usage.cacheCreationTokens) {
                  this.metricsCollector.increment('cache_creation_tokens_total', {}, event.usage.cacheCreationTokens);
                }
                if (event.usage.cacheReadTokens) {
                  this.metricsCollector.increment('cache_read_tokens_total', {}, event.usage.cacheReadTokens);
                  this.metricsCollector.increment('cache_hits_total', { source: 'prompt' });
                }
              }
              yield { type: 'usage', usage: event.usage };
              break;
            case 'error':
              streamError = event.error || 'Unknown provider error';
              break;
          }
        }
        this.providerRateLimiter.release();
      } catch (err: unknown) {
        this.providerRateLimiter.release();
        const msg = err instanceof Error ? err.message : String(err);
        streamError = `Stream error: ${msg}`;
      }

      if (streamError) {
        yield { type: 'error', error: streamError };

        // Fatal errors (missing API key, auth failure, billing, etc.) — stop immediately
        if (isFatalError(streamError)) {
          this.finishRun(false, streamError, tracksTask);
          return;
        }

        // Provider rate limit backoff on 429
        if (streamError.includes('429') || streamError.includes('rate limit') || streamError.includes('Rate limit')) {
          this.providerRateLimiter.backoff();
        }

        // Circuit breaker: stop after 3 consecutive identical errors
        if (streamError === lastErrorMsg) {
          consecutiveErrors++;
          if (consecutiveErrors >= 3) {
            const errorMessage = `Same error repeated ${consecutiveErrors} times — stopping. Fix the issue and try again.`;
            this.finishRun(false, errorMessage, tracksTask);
            yield { type: 'error', error: errorMessage };
            return;
          }
        } else {
          consecutiveErrors = 1;
          lastErrorMsg = streamError;
        }

        continue;
      }

      // Reset error tracking on success
      consecutiveErrors = 0;
      lastErrorMsg = '';

      // If no native tool calls, try parsing from text
      if (toolCalls.length === 0 && fullText) {
        toolCalls = parseToolCalls(fullText);
      }

      // Save assistant message
      const assistantMsg: Message = { role: 'assistant', content: fullText };
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls;
      }
      this.messages.push(assistantMsg);
      this.onMessage?.(assistantMsg);

      // No tool calls = conversation turn done
      if (toolCalls.length === 0) {
        this.finishRun(true, fullText || 'Completed successfully.', tracksTask);
        yield { type: 'done' };
        return;
      }

      // Post-tool-batch budget backstop. The pre-call check above already
      // catches the common case; this catches tools that themselves cost
      // (sub-LLM calls, MCP servers) and pushed us over within the
      // iteration. Same audit shape as the pre-call block.
      this.checkBudgetThresholds();
      if (this.tokenTracker.isOverBudget()) {
        const cost = this.tokenTracker.getTotalCost();
        const cap = this.effectiveBudgetCapUsd;
        this.auditLogger.log({
          tool: 'budget',
          action: 'budget_block',
          args: {
            totalCostUsd: cost,
            effectiveCapUsd: cap,
            policyCapUsd: this.budgetCapSources.policyUsd,
            userCapUsd: this.budgetCapSources.userUsd,
            origin: 'post-tool-batch',
          },
          reason: `budget exhausted (post-tool-batch): $${cost.toFixed(4)} ≥ $${cap.toFixed(2)}`,
          result: 'block',
        });
        const errorMessage = `Cost limit exceeded ($${cost.toFixed(4)} / $${cap.toFixed(2)}). Stopping. Raise the cap in ~/.codebot/config.json under \`budget.perSessionCapUsd\` or end the session.`;
        this.finishRun(false, errorMessage, tracksTask);
        yield { type: 'error', error: errorMessage };
        return;
      }

      // ── Phase 1: Validate & resolve permissions (sequential — needs user input) ──

      const prepared: PreparedCall[] = [];

      for (const tc of toolCalls) {
        const toolName = tc.function.name;

        // Parse JSON args up front — LLM-produced tool calls carry args as
        // a JSON string; _prepareToolCall expects an object.
        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          const tool = this.tools.get(toolName);
          prepared.push({
            tc,
            tool: (tool || null) as unknown as Tool,
            args: {},
            denied: false,
            error: `Error: Invalid JSON arguments for ${toolName}`,
          });
          continue;
        }

        const { prepared: p, riskAssessment } = await this._prepareToolCall(
          toolName,
          args,
          { interactivePrompt: true },
        );
        // Preserve the LLM-provided tool_call id so the downstream
        // tool-result message carries the correct tool_call_id for the
        // provider round-trip.
        p.tc = tc;

        // Yield a tool_call event only when the gate chain got as far as
        // computing a risk score — i.e. the tool exists, policy allowed
        // it, and args validated. Earlier bailouts (unknown tool, policy
        // block, schema error) go straight to a tool_result error, same
        // as before this refactor.
        if (riskAssessment) {
          yield {
            type: 'tool_call',
            toolCall: { name: toolName, args },
            risk: { score: riskAssessment.score, level: riskAssessment.level },
          };
        }

        prepared.push(p);
      }

      // ── Phase 2: Execute tools (parallel where possible) ──
      const executorDeps: ToolExecutorDeps = {
        cache: this.cache,
        rateLimiter: this.rateLimiter,
        metricsCollector: this.metricsCollector,
        auditLogger: this.auditLogger,
        tokenTracker: this.tokenTracker,
        stateEngine: this.stateEngine,
        lastExecutedTools: this.lastExecutedTools,
        ensureBranch: () => this.ensureBranch(),
        checkToolCapabilities: (t, a) => this.checkToolCapabilities(t, a),
        experientialMemory: this.experientialMemory,
        currentTask: this.sessionGoal,
      };
      const results = await executeToolBatch(prepared, executorDeps);

      // ── Phase 3: Push results in original order + yield events ──
      for (let idx = 0; idx < prepared.length; idx++) {
        const prep = prepared[idx];
        const output = results[idx] || { content: 'Error: execution failed', is_error: true };
        const toolName = prep.tc.function.name;

        const toolMsg: Message = { role: 'tool', content: output.content, tool_call_id: prep.tc.id };

        // Vision: attach screenshot images to tool messages for vision-capable LLMs (v2.1.6)
        if (toolName === 'browser' && prep.args.action === 'screenshot' && lastScreenshotData) {
          const modelInfo = getModelInfo(this.model);
          if (modelInfo.supportsVision) {
            toolMsg.images = [{ data: lastScreenshotData, mediaType: 'image/png' }];
          }
          // Clear the screenshot data via setter (ES module export can't be reassigned)
          const { setLastScreenshotData } = require('./tools/browser/connection');
          setLastScreenshotData(null);
        }

        this.messages.push(toolMsg);
        this.onMessage?.(toolMsg);

        if (prep.denied) {
          this.taskState.recordToolResult(toolName, false, 'Permission denied by user.', prep.args);
          yield { type: 'tool_result', toolResult: { name: toolName, result: 'Permission denied.' } };
          this.trackToolCall(toolName, false);
        } else {
          this.taskState.recordToolResult(toolName, !output.is_error, output.content, prep.args);
          yield {
            type: 'tool_result',
            toolResult: { name: toolName, result: output.content, is_error: output.is_error },
          };
          this.trackToolCall(toolName, !output.is_error);

          // Execution auditing: detect anomalies in tool execution patterns
          const anomalies = this.executionAuditor.record({
            toolName,
            success: !output.is_error,
            durationMs: output.durationMs || 0,
            errorMessage: output.is_error ? output.content : undefined,
            timestamp: new Date().toISOString(),
            signature: buildToolExecutionSignature(toolName, prep.args),
          });
          for (const anomaly of anomalies) {
            if (anomaly.severity === 'critical') {
              yield { type: 'error', error: `[ExecutionAuditor] ${anomaly.type}: ${anomaly.description}` };
            }
          }
        }
      }

      // Compact after tool results if needed
      if (!this.context.fitsInBudget(this.messages)) {
        try {
          const result = await this.context.compactWithSummary(this.messages);
          this.messages = result.messages;
          yield { type: 'compaction', text: result.summary || 'Context compacted.' };
        } catch {
          this.messages = this.context.compact(this.messages, true);
          yield { type: 'compaction', text: 'Context compacted (summary unavailable).' };
        }
      }
    }

    const errorMessage = `Max iterations (${this.maxIterations}) reached.`;
    this.finishRun(false, errorMessage, tracksTask);
    yield { type: 'error', error: errorMessage };
  }

  clearHistory() {
    this.resetConversation();
  }

  forceCompact(): { before: number; after: number } {
    const before = this.messages.length;
    this.messages = this.context.compact(this.messages, true);
    return { before, after: this.messages.length };
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  /** Get the token tracker for session summary / CLI display */
  getTokenTracker(): TokenTracker {
    return this.tokenTracker;
  }

  /**
   * PR 6 — effective budget cap (USD). 0 = no cap. Stricter of policy +
   * user config, computed at construction. Public so the CLI banner /
   * dashboard can render it.
   */
  getEffectiveBudgetCapUsd(): number {
    return this.effectiveBudgetCapUsd;
  }

  /**
   * Validate + gate a single tool call through the full security chain:
   *   schema validation → policy allow-list → risk scoring → CORD
   *   (constitutional) → SPARK → permission.
   *
   * Returns a PreparedCall (with `denied` or `error` set when blocked) and
   * the RiskAssessment (or null if we bailed before scoring — unknown
   * tool, policy block, schema error). Audit entries for policy /
   * constitutional / permission denials are written before return.
   *
   * Shared by the agent loop (`run()` Phase 1) and public `runSingleTool`
   * so dashboard / IPC / script callers replay the exact same gates as
   * autonomous-loop tool calls. Before 2026-04-23 the dashboard tool
   * runner called `tool.execute(args)` directly on the registry entry,
   * skipping this chain entirely — that bypass is what `runSingleTool`
   * closes.
   *
   * @param opts.interactivePrompt — when false, tools that would require
   *   a permission prompt (`always-ask` / `prompt` / SPARK challenge)
   *   are auto-denied (fail-closed). Dashboard HTTP callers must pass
   *   false because there is no user to prompt over the wire.
   */
  private async _prepareToolCall(
    toolName: string,
    args: Record<string, unknown>,
    opts: { interactivePrompt: boolean },
  ): Promise<{ prepared: PreparedCall; riskAssessment: RiskAssessment | null }> {
    const tc: ToolCall = {
      id: `call_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`,
      type: 'function',
      function: { name: toolName, arguments: JSON.stringify(args) },
    };

    const tool = this.tools.get(toolName);
    if (!tool) {
      return {
        prepared: {
          tc,
          tool: null as unknown as Tool,
          args,
          denied: false,
          error: `Error: Unknown tool "${toolName}"`,
        },
        riskAssessment: null,
      };
    }

    // Policy allow-list
    const policyCheck = this.policyEnforcer.isToolAllowed(toolName);
    if (!policyCheck.allowed) {
      this.auditLogger.log({ tool: toolName, action: 'policy_block', args, reason: policyCheck.reason });
      return {
        prepared: { tc, tool, args, denied: false, error: `Error: ${policyCheck.reason}` },
        riskAssessment: null,
      };
    }

    // Schema validation
    const validationError = validateToolArgs(args, tool.parameters);
    if (validationError) {
      return {
        prepared: { tc, tool, args, denied: false, error: `Error: ${validationError} for ${toolName}` },
        riskAssessment: null,
      };
    }

    // Risk scoring
    const policyPermission = this.policyEnforcer.getToolPermission(toolName);
    let effectivePermission = policyPermission || tool.permission;

    // Capability label escalation (PR 4 — §7 of personal-agent-infrastructure.md).
    // Each label declares a required gate (auto / prompt / always-ask).
    // Multiple labels combine to the strictest. If the strictest exceeds
    // what policy or the tool already declared, escalate. Monotonic up
    // only — never weakens what policy or the tool already requires.
    //
    // `capabilityChallenged` is set when the escalation actually moved
    // the gate UP. Later, in the permission decision, this flag forces
    // a prompt even when `autoApprove` would otherwise bypass — that's
    // §7's "always-ask means every call, every time" invariant for
    // capability-driven escalations. (The legacy static `permission:
    // 'always-ask'` keeps its current autoApprove-bypassable behavior
    // for now; that's a deliberate narrower scope for PR 4.)
    //
    // PR 11 — two refinements:
    //   1. Use `tool.effectiveCapabilities(args)` when the tool exposes
    //      it (currently only `app`), so dispatch tools score the real
    //      sub-action's labels rather than the worst-case union over
    //      every action they can dispatch to. The `app` tool's static
    //      union includes `send-on-behalf` and `delete-data`, which
    //      forced every read action through `always-ask` — exactly the
    //      bug the PR-brief run surfaced.
    //   2. The `capabilityChallenged` flag only stays true if at least
    //      one triggering label is NOT in `--allow-capability`. Labels
    //      the user has explicitly opted into for this session no longer
    //      count toward the immunity flag. NEVER_ALLOWABLE labels can
    //      never reach this set — `parseAllowCapabilityFlag` rejects
    //      them at startup — so this code path cannot weaken
    //      move-money / spend-money / send-on-behalf / delete-data.
    const callCapabilities = tool.effectiveCapabilities?.(args) ?? tool.capabilities;
    const capEscalation = escalatePermissionFromCapabilityLabels(
      effectivePermission,
      callCapabilities,
    );
    let capabilityChallenged = false;
    let capabilityTriggeringLabels: string[] = [];
    let unallowedTriggeringLabels: string[] = [];
    if (capEscalation.escalated) {
      effectivePermission = capEscalation.permission;
      capabilityTriggeringLabels = capEscalation.triggeringLabels.slice();
      // PR 11 — subtract user-allowlisted labels. If anything triggering
      // remains, the call still requires interactive approval.
      unallowedTriggeringLabels = capabilityTriggeringLabels.filter(
        (l) => !this.allowedCapabilities.has(l as CapabilityLabel),
      );
      capabilityChallenged = unallowedTriggeringLabels.length > 0;
    }

    const riskAssessment = this.riskScorer.assess(toolName, args, effectivePermission);

    if (riskAssessment.score > 50) {
      const breakdown = riskAssessment.factors.map((f) => `${f.name}=${f.rawScore}`).join(', ');
      this.auditLogger.log({
        tool: toolName,
        action: 'execute',
        args,
        result: `risk:${riskAssessment.score}`,
        reason: breakdown,
      });
    }

    // CORD retry prevention — previously blocked tool+args combo denies
    // immediately without re-invoking the constitutional layer.
    const blockKey = `${toolName}:${JSON.stringify(args)}`;
    if (this.cordBlockedKeys.has(blockKey)) {
      return {
        prepared: { tc, tool, args, denied: true, error: 'Blocked by safety policy.' },
        riskAssessment,
      };
    }

    // Constitutional (CORD + VIGIL)
    if (this.constitutional) {
      const cordResult = this.constitutional.evaluateAction({
        tool: toolName,
        args,
        type: TOOL_TYPE_MAP[toolName] || 'unknown',
      });

      if (cordResult.decision === 'BLOCK') {
        this.trackCordBlock(blockKey);
        this.auditLogger.log({
          tool: toolName,
          action: 'constitutional_block',
          args,
          reason: cordResult.explanation || 'Constitutional violation',
        });
        this.metricsCollector.increment('security_blocks_total', { tool: toolName, type: 'constitutional' });
        return {
          prepared: { tc, tool, args, denied: true, error: 'Blocked by safety policy.' },
          riskAssessment,
        };
      }

      if (cordResult.decision === 'CHALLENGE') {
        effectivePermission = 'always-ask';
      }
    }

    // SPARK adaptive safety — learned judgment overrides autoApprove
    let sparkChallenged = false;
    if (this.stateEngine) {
      try {
        const sparkResult = this.stateEngine.evaluateTool(toolName, args);
        if (sparkResult.decision === 'BLOCK') {
          return {
            prepared: { tc, tool, args, denied: false, error: 'Error: Blocked by SPARK: ' + sparkResult.reason },
            riskAssessment,
          };
        }
        if (sparkResult.decision === 'CHALLENGE') {
          effectivePermission = 'always-ask';
          sparkChallenged = true;
        }
      } catch (e) {
        log.warn(`[CodeBot] Failed to initialize state engine: ${(e as Error).message}`);
      }
    }

    // Permission: policy override > tool default.
    // autoApprove bypasses `always-ask`/`prompt` EXCEPT when:
    //   - SPARK raised a CHALLENGE (learned override), or
    //   - capability labels escalated the gate (§7 — capability-driven
    //     `always-ask` is immune to `autoApprove` per PR 4).
    const needsPermission =
      sparkChallenged ||
      capabilityChallenged ||
      (!this.autoApprove && (effectivePermission === 'always-ask' || effectivePermission === 'prompt'));

    let denied = false;
    if (needsPermission) {
      // PR 11 — when the user said `--auto-approve` and the only reason
      // we still need permission is a capability-label gate that the
      // user did NOT allowlist, fail fast with a precise audit row
      // instead of timing out at a phantom prompt. Sitting at a 30s
      // timeout for a script-piped invocation was indistinguishable
      // from "User denied permission" in the audit, which was wrong:
      // the user never had a chance to deny anything; the policy did.
      const blockedByUnallowedCapability =
        this.autoApprove &&
        capabilityChallenged &&
        !sparkChallenged &&
        unallowedTriggeringLabels.length > 0;

      if (blockedByUnallowedCapability) {
        const reason =
          `blocked: required capability labels [${unallowedTriggeringLabels.join(', ')}] ` +
          `are not permitted by --allow-capability in unattended mode`;
        this.auditLogger.log({
          tool: toolName,
          action: 'deny',
          args,
          reason,
        });
        this.metricsCollector.increment('permission_denials_total', { tool: toolName });
        denied = true;
      } else if (!opts.interactivePrompt) {
        // Non-interactive caller (dashboard HTTP, IPC, scripts) — fail
        // closed instead of trying to prompt a user that isn't there.
        const denyReason = capabilityChallenged
          ? `capability labels require ${effectivePermission}: ${capabilityTriggeringLabels.join(', ')}`
          : 'Non-interactive caller; tool requires permission prompt';
        this.auditLogger.log({
          tool: toolName,
          action: 'deny',
          args,
          reason: denyReason,
        });
        this.metricsCollector.increment('permission_denials_total', { tool: toolName });
        denied = true;
      } else {
        const approved = await this.askPermission(toolName, args, riskAssessment, {
          sandbox: this.policyEnforcer.getSandboxMode() === 'docker',
          network: this.policyEnforcer.isNetworkAllowed(),
        });
        if (!approved) {
          denied = true;
          // Interactive denial path — could be a real "n" or a timeout.
          // We don't have a signal that distinguishes them today (the
          // askPermission contract returns a single bool), so the
          // existing wording stands. PR 11 deliberately scopes the
          // wording change to the unattended-policy-block case where
          // the user provably had no chance to respond.
          this.auditLogger.log({ tool: toolName, action: 'deny', args, reason: 'User denied permission' });
          this.metricsCollector.increment('permission_denials_total', { tool: toolName });
        }
      }
    }

    return { prepared: { tc, tool, args, denied }, riskAssessment };
  }

  /**
   * Public single-tool entry point for non-LLM callers (dashboard HTTP,
   * IPC, scripts). Replays the full security chain — schema, policy,
   * risk, CORD, SPARK, permission, audit — then executes the tool and
   * returns the result.
   *
   * Dashboard tool-runner callsites must route through this method
   * instead of `agent.getToolRegistry().get(name).execute(args)` — the
   * latter completely skips the gate chain and was the bypass fixed in
   * the 2026-04-23 security work.
   *
   * @param opts.interactivePrompt — defaults to false. Callers that can
   *   block for an async user prompt may set this true; dashboard HTTP
   *   should leave it false so always-ask tools fail closed.
   */
  async runSingleTool(
    toolName: string,
    args: Record<string, unknown>,
    opts: { interactivePrompt?: boolean } = {},
  ): Promise<{
    result: string;
    is_error: boolean;
    blocked: boolean;
    reason?: string;
    durationMs?: number;
  }> {
    const { prepared } = await this._prepareToolCall(
      toolName,
      args ?? {},
      { interactivePrompt: opts.interactivePrompt ?? false },
    );

    if (prepared.error) {
      return {
        result: prepared.error,
        is_error: true,
        blocked: prepared.denied,
        reason: prepared.error,
      };
    }
    if (prepared.denied) {
      return {
        result: 'Error: Blocked by safety policy.',
        is_error: true,
        blocked: true,
        reason: 'Denied by policy / CORD / SPARK / permission gate',
      };
    }

    const deps: ToolExecutorDeps = {
      cache: this.cache,
      rateLimiter: this.rateLimiter,
      metricsCollector: this.metricsCollector,
      auditLogger: this.auditLogger,
      tokenTracker: this.tokenTracker,
      stateEngine: this.stateEngine,
      lastExecutedTools: this.lastExecutedTools,
      ensureBranch: () => this.ensureBranch(),
      checkToolCapabilities: (t, a) => this.checkToolCapabilities(t, a),
      experientialMemory: this.experientialMemory,
      currentTask: this.sessionGoal,
    };

    const output = await executeSingleTool(prepared, deps);
    return {
      result: output.content,
      is_error: !!output.is_error,
      blocked: false,
      durationMs: output.durationMs,
    };
  }

  /**
   * Streaming single-tool entry point for non-LLM callers (dashboard
   * SSE, IPC, scripts). Runs the full gate chain via `_prepareToolCall`,
   * then — if allowed — invokes the tool's `stream()` method. Tools
   * without `stream()` are rejected (only `execute` implements it today).
   *
   * Audit semantics — `_prepareToolCall` writes entries only for
   * BLOCKS (policy/constitutional/capability/permission), not for
   * allows. So `runStreamingTool` writes `exec_start` after the gate
   * passes (the allow evidence), then `exec_complete` on process close
   * with the 512-byte tails, or `exec_error` if `stream()` throws.
   *
   * Tail size is fixed at 512 bytes per stream inside the tool; never
   * logs full output.
   */
  async runStreamingTool(
    toolName: string,
    args: Record<string, unknown>,
    events: ToolStreamEvents,
    opts: { interactivePrompt?: boolean; streamTimeoutMs?: number } = {},
  ): Promise<
    | { blocked: true; reason: string; errorCode?: string }
    | { blocked: false; error: true; errorCode: string; reason: string }
    | { blocked: false; error: false; exitCode: number; stdoutTail: string; stderrTail: string; timedOut: boolean }
  > {
    const { prepared } = await this._prepareToolCall(
      toolName,
      args ?? {},
      { interactivePrompt: opts.interactivePrompt ?? false },
    );

    if (prepared.error) {
      if (prepared.denied) {
        return { blocked: true, reason: prepared.error };
      }
      return {
        blocked: false,
        error: true,
        errorCode: 'gate_error',
        reason: prepared.error,
      };
    }
    if (prepared.denied) {
      return { blocked: true, reason: 'Denied by policy / CORD / SPARK / permission gate' };
    }

    const tool = prepared.tool;
    if (typeof tool.stream !== 'function') {
      return {
        blocked: false,
        error: true,
        errorCode: 'not_streamable',
        reason: `Tool "${toolName}" does not support streaming execution.`,
      };
    }

    // Fine-grained capability check — the buffered path runs this
    // inside executeSingleTool() (src/agent/tool-executor.ts:79), but
    // `_prepareToolCall` does NOT. Without this call, a policy like
    //   tools.capabilities.execute.shell_commands: ['npm']
    // would block `npm install` via the buffered tool runner but let
    // `git status` stream through /api/command/exec unchecked. Mirror
    // the exact contract: audit `capability_block`, bump the same
    // metric tag the buffered path uses, return a blocked outcome.
    const capBlock = this.checkToolCapabilities(toolName, args);
    if (capBlock) {
      this.auditLogger.log({ tool: toolName, action: 'capability_block', args, reason: capBlock });
      this.metricsCollector.increment('security_blocks_total', { tool: toolName, type: 'capability' });
      return { blocked: true, reason: capBlock, errorCode: 'capability_block' };
    }

    // Allow evidence — `_prepareToolCall` doesn't audit allows, so we
    // write exec_start here. This is the authoritative record that the
    // gate chain approved this specific args payload for streaming.
    this.auditLogger.log({
      tool: toolName,
      action: 'exec_start',
      args,
      reason: 'streaming execution approved by gate chain',
    });

    const startedAt = Date.now();
    try {
      const result = await tool.stream(args, events, { timeoutMs: opts.streamTimeoutMs });
      this.auditLogger.log({
        tool: toolName,
        action: 'exec_complete',
        args,
        result: `exit:${result.exitCode}${result.timedOut ? ' timed_out' : ''}`,
        reason: `stdout_tail=${JSON.stringify(result.stdoutTail)} stderr_tail=${JSON.stringify(result.stderrTail)} duration_ms=${Date.now() - startedAt}`,
      });
      return {
        blocked: false,
        error: false,
        exitCode: result.exitCode,
        stdoutTail: result.stdoutTail,
        stderrTail: result.stderrTail,
        timedOut: result.timedOut,
      };
    } catch (err: unknown) {
      const e = err as { code?: string; message?: string };
      const code = e.code || 'stream_error';
      const reason = e.message || 'streaming exec failed';
      this.auditLogger.log({
        tool: toolName,
        action: 'exec_error',
        args,
        reason: `code=${code} message=${reason} duration_ms=${Date.now() - startedAt}`,
      });
      return { blocked: false, error: true, errorCode: code, reason };
    }
  }

  /** Get the policy enforcer for inspection */
  getPolicyEnforcer(): PolicyEnforcer {
    return this.policyEnforcer;
  }

  /** Get the audit logger for verification */
  getAuditLogger(): AuditLogger {
    return this.auditLogger;
  }

  /** Get the metrics collector for session metrics */
  getMetrics(): MetricsCollector {
    return this.metricsCollector;
  }

  /** Get the provider rate limiter for utilization display */
  getProviderRateLimiter(): ProviderRateLimiter {
    return this.providerRateLimiter;
  }

  /** Get the tool registry for direct tool listing/execution */
  getToolRegistry(): ToolRegistry {
    return this.tools;
  }

  /** Get the risk scorer for risk assessment history */
  getRiskScorer(): RiskScorer {
    return this.riskScorer;
  }

  /** Get the constitutional layer for security metrics */
  getConstitutional(): ConstitutionalLayer | null {
    return this.constitutional;
  }

  /**
   * Auto-create a feature branch when always_branch is enabled and on main/master.
   * Called before the first write/edit operation. Fail-open: if branching fails, continue.
   */
  private async ensureBranch(): Promise<string | null> {
    if (this.branchCreated) return null;
    if (!this.policyEnforcer.shouldAlwaysBranch()) return null;

    try {
      const { execSync } = require('child_process');
      const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd: this.projectRoot,
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();

      if (currentBranch !== 'main' && currentBranch !== 'master') {
        this.branchCreated = true;
        return null; // Already on a feature branch
      }

      // Generate branch name from first user message
      const firstUserMsg = this.messages.find((m) => m.role === 'user');
      const prefix = this.policyEnforcer.getBranchPrefix();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
      const slug = this.sanitizeSlug(firstUserMsg?.content || 'task');
      const branchName = `${prefix}${timestamp}-${slug}`;

      execSync(`git checkout -b "${branchName}"`, {
        cwd: this.projectRoot,
        encoding: 'utf-8',
        timeout: 10000,
      });

      this.branchCreated = true;
      return branchName;
    } catch {
      // Don't block the operation if branching fails (not in a git repo, etc.)
      this.branchCreated = true; // Don't retry
      return null;
    }
  }

  /** Sanitize user message into a branch-safe slug. */
  private sanitizeSlug(message: string): string {
    return (
      message
        .toLowerCase()
        .replace(/[^a-z0-9\s-]/g, '')
        .replace(/\s+/g, '-')
        .substring(0, 30)
        .replace(/-+$/, '') || 'task'
    );
  }

  /** Check capability-based restrictions before tool execution. Returns reason string or null. */
  private checkToolCapabilities(toolName: string, args: Record<string, unknown>): string | null {
    // fs_write check for write/edit tools
    if ((toolName === 'write_file' || toolName === 'edit_file' || toolName === 'batch_edit') && args.path) {
      const check = this.policyEnforcer.checkCapability(toolName, 'fs_write', args.path as string);
      if (!check.allowed) return check.reason || 'Capability blocked';
    }

    // shell_commands check for execute tool
    if (toolName === 'execute' && args.command) {
      const check = this.policyEnforcer.checkCapability(toolName, 'shell_commands', args.command as string);
      if (!check.allowed) return check.reason || 'Capability blocked';
    }

    // net_access check for web tools
    if ((toolName === 'web_fetch' || toolName === 'http_client') && args.url) {
      try {
        const domain = new URL(args.url as string).hostname;
        const check = this.policyEnforcer.checkCapability(toolName, 'net_access', domain);
        if (!check.allowed) return check.reason || 'Capability blocked';
      } catch {
        /* invalid URL handled by the tool itself */
      }
    }

    return null;
  }

  /** Track tool call with bounded growth */
  private trackToolCall(tool: string, success: boolean): void {
    if (this.sessionToolCalls.length >= Agent.MAX_SESSION_TOOL_CALLS) {
      this.sessionToolCalls = this.sessionToolCalls.slice(-Math.floor(Agent.MAX_SESSION_TOOL_CALLS / 2));
    }
    this.sessionToolCalls.push({ tool, success });
  }

  /** Track CORD blocked key with bounded growth */
  private trackCordBlock(key: string): void {
    if (this.cordBlockedKeys.size >= Agent.MAX_CORD_BLOCKED_KEYS) {
      const entries = Array.from(this.cordBlockedKeys);
      this.cordBlockedKeys = new Set(entries.slice(-Math.floor(Agent.MAX_CORD_BLOCKED_KEYS / 2)));
    }
    this.cordBlockedKeys.add(key);
  }

  private refreshSystemPrompt(): void {
    const supportsTools = getModelInfo(this.model).supportsToolCalling;
    const conversation = this.messages[0]?.role === 'system' ? this.messages.slice(1) : [...this.messages];
    const systemMessage: Message = {
      role: 'system',
      content: buildSystemPrompt({
        projectRoot: this.projectRoot,
        supportsTools,
        tools: this.tools,
        userProfile: this.userProfile,
        stateEngine: this.stateEngine,
        messages: conversation,
        crossSession: this.crossSession,
        experientialMemory: this.experientialMemory,
        taskState: this.taskState,
        vaultMode: this.vaultMode
          ? { ...this.vaultMode }
          : undefined,
      }),
    };

    if (this.messages[0]?.role === 'system') this.messages[0] = systemMessage;
    else this.messages.unshift(systemMessage);
  }

  private finalizeStateEngine(): void {
    if (!this.stateEngine) return;
    try {
      this.stateEngine.finalizeSession();
    } catch (e) {
      log.warn(`[CodeBot] Failed to finalize state engine: ${(e as Error).message}`);
    }
  }

  private finishRun(success: boolean, summary: string, tracksTask: boolean): void {
    const normalizedSummary = summary.trim() || (success ? 'Completed successfully.' : 'Stopped before completion.');
    const activeGoal = this.taskState.getActiveGoal();
    if (activeGoal) this.sessionGoal = activeGoal;
    if (tracksTask) {
      this.taskState.completeActiveTask(normalizedSummary, success);
    }
    this.userProfile.flushIfDirty(true);
    this.finalizeStateEngine();
    this.recordSessionEpisode(success, normalizedSummary);
  }

  /** Record cross-session episode when session ends */
  private recordSessionEpisode(success: boolean, outcomeSummary = ''): void {
    try {
      const summary = this.tokenTracker.getSummary();
      const outcomes = [outcomeSummary, ...this.taskState.getOutcomeHints()]
        .map((outcome) => outcome.trim())
        .filter(Boolean)
        .filter((outcome, index, all) => all.indexOf(outcome) === index)
        .slice(0, 4);
      const episode = this.crossSession.buildEpisode({
        sessionId: summary.startTime,
        projectRoot: this.projectRoot,
        startedAt: this.sessionStartedAt,
        goal: this.sessionGoal,
        toolCalls: this.sessionToolCalls,
        success,
        outcomes:
          outcomes.length > 0
            ? outcomes
            : [success ? 'Session completed successfully' : 'Session ended (max iterations or error)'],
        tokenUsage: { input: summary.totalInputTokens, output: summary.totalOutputTokens },
      });
      this.crossSession.recordEpisode(episode);
      try {
        this.experientialMemory.decayAndConsolidate();
      } catch {}
    } catch {
      /* cross-session recording should never crash the agent */
    }
  }
}

const PERMISSION_TIMEOUT_MS = 30_000;

async function defaultAskPermission(tool: string, args: Record<string, unknown>): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const summary = Object.entries(args)
    .map(([k, v]) => {
      const val = typeof v === 'string' ? (v.length > 80 ? v.substring(0, 80) + '...' : v) : JSON.stringify(v);
      return `  ${k}: ${val}`;
    })
    .join('\n');

  let timerId: ReturnType<typeof setTimeout> | undefined;

  const userResponse = new Promise<boolean>((resolve) => {
    rl.question(`\n⚡ ${tool}\n${summary}\nAllow? [y/N] (${PERMISSION_TIMEOUT_MS / 1000}s timeout) `, (answer) => {
      if (timerId) clearTimeout(timerId);
      rl.close();
      resolve(answer.toLowerCase().startsWith('y'));
    });
  });

  const timeout = new Promise<boolean>((resolve) => {
    timerId = setTimeout(() => {
      rl.close();
      process.stdout.write('\n⏱ Permission timed out — denied by default.\n');
      resolve(false);
    }, PERMISSION_TIMEOUT_MS);
  });

  return Promise.race([userResponse, timeout]);
}
