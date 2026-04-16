import * as readline from 'readline';
import { Message, ToolCall, AgentEvent, LLMProvider, Tool } from './types';
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
import { PreparedCall, ToolExecutorDeps, executeToolBatch, TOOL_TYPE_MAP } from './agent/tool-executor';
import { buildSystemPrompt } from './agent/prompt-builder';
import { ExecutionAuditor } from './execution-auditor';
import { CrossSessionLearning } from './cross-session';
import { ExperientialMemory } from './experiential-memory';
import { TaskStateStore } from './task-state';

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
  private model: string;
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
  }) {
    this.provider = opts.provider;
    this.model = opts.model;
    this.projectRoot = opts.projectRoot || process.cwd();

    // Load policy FIRST — tools need it for filesystem/git enforcement
    this.policyEnforcer = new PolicyEnforcer(loadPolicy(this.projectRoot), this.projectRoot);

    this.tools = new ToolRegistry(this.projectRoot, this.policyEnforcer);
    this.context = new ContextManager(opts.model, opts.provider);

    // Use policy-defined max iterations as default, CLI overrides
    this.maxIterations = opts.maxIterations || this.policyEnforcer.getMaxIterations();
    this.autoApprove = opts.autoApprove || false;
    this.askPermission = opts.askPermission || defaultAskPermission;
    this.onMessage = opts.onMessage;
    this.cache = new ToolCache();
    this.rateLimiter = new RateLimiter();
    this.providerRateLimiter = new ProviderRateLimiter(opts.providerName || 'local');
    this.auditLogger = new AuditLogger();

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
        console.warn(`[CodeBot] Failed to initialize constitutional layer: ${(e as Error).message}`);
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
      console.warn(`[CodeBot] Failed to initialize state engine: ${(e as Error).message}`);
    }

    const costLimit = this.policyEnforcer.getCostLimitUsd();
    if (costLimit > 0) this.tokenTracker.setCostLimit(costLimit);

    // Load plugins
    try {
      const plugins = loadPlugins(this.projectRoot);
      for (const plugin of plugins) {
        this.tools.register(plugin);
      }
    } catch (e) {
      console.warn(`[CodeBot] Failed to initialize plugins: ${(e as Error).message}`);
    }

    // Connectors, GraphicsTool, and AppConnectorTool are registered by ToolRegistry
    // constructor (tools/index.ts) — single source of truth for all 12 connectors.

    // Load skills as tools (independent of connectors)
    try {
      const { loadSkills, skillToTool } = require('./skills');
      const skills = loadSkills();
      for (const skill of skills) {
        const toolExec = async (name: string, args: Record<string, unknown>) => {
          const t = this.tools.get(name);
          if (!t) return `Error: tool "${name}" not found`;
          return t.execute(args);
        };
        this.tools.register(skillToTool(skill, toolExec));
      }
    } catch (e) {
      console.warn(`[CodeBot] Failed to initialize skills: ${(e as Error).message}`);
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
    // Context window varies by model — recreate to pick up the new value.
    this.context = new ContextManager(model, provider);
    // Rate-limiter and token tracker are per-provider/model metadata.
    this.providerRateLimiter = new ProviderRateLimiter(providerName || 'local');
    this.tokenTracker = new TokenTracker(model, providerName || 'unknown');
    this.resetConversation();
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

      // Cost budget check: stop if over limit
      if (this.tokenTracker.isOverBudget()) {
        const errorMessage = `Cost limit exceeded ($${this.tokenTracker.getTotalCost().toFixed(4)} / $${this.policyEnforcer.getCostLimitUsd().toFixed(2)}). Stopping.`;
        this.finishRun(false, errorMessage, tracksTask);
        yield { type: 'error', error: errorMessage };
        return;
      }

      // ── Phase 1: Validate & resolve permissions (sequential — needs user input) ──

      const prepared: PreparedCall[] = [];

      for (const tc of toolCalls) {
        const toolName = tc.function.name;
        const tool = this.tools.get(toolName);

        if (!tool) {
          prepared.push({
            tc,
            tool: null as unknown as Tool,
            args: {},
            denied: false,
            error: `Error: Unknown tool "${toolName}"`,
          });
          continue;
        }

        // Policy check: is this tool allowed?
        const policyCheck = this.policyEnforcer.isToolAllowed(toolName);
        if (!policyCheck.allowed) {
          this.auditLogger.log({ tool: toolName, action: 'policy_block', args: {}, reason: policyCheck.reason });
          prepared.push({ tc, tool, args: {}, denied: false, error: `Error: ${policyCheck.reason}` });
          continue;
        }

        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          prepared.push({ tc, tool, args: {}, denied: false, error: `Error: Invalid JSON arguments for ${toolName}` });
          continue;
        }

        // Arg validation against schema
        const validationError = validateToolArgs(args, tool.parameters);
        if (validationError) {
          prepared.push({ tc, tool, args, denied: false, error: `Error: ${validationError} for ${toolName}` });
          continue;
        }

        // Compute risk score before execution
        const policyPermission = this.policyEnforcer.getToolPermission(toolName);
        let effectivePermission = policyPermission || tool.permission;
        const riskAssessment = this.riskScorer.assess(toolName, args, effectivePermission);
        yield {
          type: 'tool_call',
          toolCall: { name: toolName, args },
          risk: { score: riskAssessment.score, level: riskAssessment.level },
        };

        // Log risk breakdown for high-risk calls
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

        // Constitutional safety check (CORD + VIGIL)
        // Retry prevention: if the same tool+args were already blocked, deny immediately
        const blockKey = `${toolName}:${JSON.stringify(args)}`;
        if (this.cordBlockedKeys.has(blockKey)) {
          prepared.push({ tc, tool, args, denied: true, error: 'Blocked by safety policy.' });
          continue;
        }
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
            prepared.push({ tc, tool, args, denied: true, error: `Blocked by safety policy.` });
            continue;
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
              prepared.push({ tc, tool, args, denied: false, error: 'Error: Blocked by SPARK: ' + sparkResult.reason });
              continue;
            }
            if (sparkResult.decision === 'CHALLENGE') {
              effectivePermission = 'always-ask';
              sparkChallenged = true;
            }
          } catch (e) {
            console.warn(`[CodeBot] Failed to initialize state engine: ${(e as Error).message}`);
          }
        }

        // Permission check: policy override > tool default
        // autoApprove bypasses ALL permission levels (autonomous/dashboard mode)
        // EXCEPTION: SPARK's learned CHALLENGE overrides autoApprove — the system
        // has learned from repeated failures that this category needs human review
        const needsPermission =
          sparkChallenged ||
          (!this.autoApprove && (effectivePermission === 'always-ask' || effectivePermission === 'prompt'));

        let denied = false;
        if (needsPermission) {
          const approved = await this.askPermission(toolName, args, riskAssessment, {
            sandbox: this.policyEnforcer.getSandboxMode() === 'docker',
            network: this.policyEnforcer.isNetworkAllowed(),
          });
          if (!approved) {
            denied = true;
            this.auditLogger.log({ tool: toolName, action: 'deny', args, reason: 'User denied permission' });
            this.metricsCollector.increment('permission_denials_total', { tool: toolName });
          }
        }

        prepared.push({ tc, tool, args, denied });
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
      console.warn(`[CodeBot] Failed to finalize state engine: ${(e as Error).message}`);
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
