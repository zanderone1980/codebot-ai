import * as readline from 'readline';
import { Message, ToolCall, AgentEvent, LLMProvider, ToolSchema, Tool } from './types';
import { ToolRegistry } from './tools';
import { parseToolCalls } from './parser';
import { ContextManager } from './context/manager';
import { isFatalError } from './retry';
import { buildRepoMap } from './context/repo-map';
import { MemoryManager } from './memory';
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
import { ConstitutionalLayer, ConstitutionalResult } from './constitutional';
import { SparkSoul } from './spark-soul';
import { isLikelyDeveloper } from './intent';
import { UserProfile } from './user-profile';
import { getRecoverySuggestion, formatRecoveryHint } from './recovery';
import { validateToolArgs, sanitizeToolOutput, repairToolCallMessages } from './agent/message-repair';
import { buildSystemPrompt } from './agent/prompt-builder';

/** Permission callback type — risk and sandbox info are optional for backwards compat */
type AskPermissionFn = (
  tool: string,
  args: Record<string, unknown>,
  risk?: RiskAssessment,
  sandbox?: { sandbox: boolean; network: boolean },
) => Promise<boolean>;



const SEQUENTIAL_TOOLS = new Set(['browser']);

/** Map CodeBot tool names to CORD tool types */
const TOOL_TYPE_MAP: Record<string, string> = {
  execute: 'exec', write_file: 'write', edit_file: 'edit', batch_edit: 'edit',
  read_file: 'read', browser: 'browser', web_fetch: 'network', http_client: 'network',
  web_search: 'network', git: 'exec', docker: 'exec', ssh_remote: 'exec',
  notification: 'message', database: 'exec',
};

/** Max concurrent parallel tool executions */
const MAX_CONCURRENT_TOOLS = 4;

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
  private sparkSoul: SparkSoul | null = null;
  private userProfile: UserProfile;

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
      } catch { /* cord-engine not available — continue without constitutional layer */ }
    }

    this.userProfile = new UserProfile();

    // Initialize SPARK soul
    try {
      this.sparkSoul = new SparkSoul(this.projectRoot);
      if (!this.sparkSoul.isActive) this.sparkSoul = null;
    } catch {}

    const costLimit = this.policyEnforcer.getCostLimitUsd();
    if (costLimit > 0) this.tokenTracker.setCostLimit(costLimit);

    // Load plugins
    try {
      const plugins = loadPlugins(this.projectRoot);
      for (const plugin of plugins) {
        this.tools.register(plugin);
      }
    } catch { /* plugins unavailable */ }

    // Load app connectors and skills
    try {
      const { VaultManager } = require('./vault');
      const { ConnectorRegistry } = require('./connectors/registry');
      const { GitHubConnector } = require('./connectors/github');
      const { SlackConnector } = require('./connectors/slack');
      const { JiraConnector } = require('./connectors/jira');
      const { LinearConnector } = require('./connectors/linear');
      const { OpenAIImagesConnector } = require('./connectors/openai-images');
      const { ReplicateConnector } = require('./connectors/replicate');
      const { AppConnectorTool } = require('./tools/app-connector');
      const { loadSkills, skillToTool } = require('./skills');

      const vault = new VaultManager();
      const connectorRegistry = new ConnectorRegistry(vault);
      connectorRegistry.register(new GitHubConnector());
      connectorRegistry.register(new SlackConnector());
      connectorRegistry.register(new JiraConnector());
      connectorRegistry.register(new LinearConnector());
      connectorRegistry.register(new OpenAIImagesConnector());
      connectorRegistry.register(new ReplicateConnector());

      const { GraphicsTool } = require('./tools/graphics');
      this.tools.register(new AppConnectorTool(vault, connectorRegistry));
      this.tools.register(new GraphicsTool());

      // Register skills as tools
      const skills = loadSkills();
      for (const skill of skills) {
        const toolExec = async (name: string, args: Record<string, unknown>) => {
          const t = this.tools.get(name);
          if (!t) return `Error: tool "${name}" not found`;
          return t.execute(args);
        };
        this.tools.register(skillToTool(skill, toolExec));
      }
    } catch { /* connectors/skills unavailable */ }

    const supportsTools = getModelInfo(opts.model).supportsToolCalling;
    this.messages.push({
      role: 'system',
      content: buildSystemPrompt({ projectRoot: this.projectRoot, supportsTools, tools: this.tools, userProfile: this.userProfile, sparkSoul: this.sparkSoul, messages: this.messages }),
    });
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
    this.messages = messages;
  }

  async *run(userMessage: string): AsyncGenerator<AgentEvent> {
    const userMsg: Message = { role: 'user', content: userMessage };
    this.messages.push(userMsg);
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
                  yield { type: 'stream_progress', streamProgress: { tokensGenerated: streamTokenCount, tokensPerSecond: tps, elapsedMs } };
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
                this.tokenTracker.recordUsage(
                  event.usage.inputTokens || 0,
                  event.usage.outputTokens || 0,
                );
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
                this.metricsCollector.increment('llm_tokens_total', { direction: 'input' }, event.usage.inputTokens || 0);
                this.metricsCollector.increment('llm_tokens_total', { direction: 'output' }, event.usage.outputTokens || 0);

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
            yield { type: 'error', error: `Same error repeated ${consecutiveErrors} times — stopping. Fix the issue and try again.` };
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
        if (this.sparkSoul) { try { this.sparkSoul.finalizeSession(); } catch {} }
        yield { type: 'done' };
        return;
      }

      // Cost budget check: stop if over limit
      if (this.tokenTracker.isOverBudget()) {
        yield { type: 'error', error: `Cost limit exceeded ($${this.tokenTracker.getTotalCost().toFixed(4)} / $${this.policyEnforcer.getCostLimitUsd().toFixed(2)}). Stopping.` };
        return;
      }

      // ── Phase 1: Validate & resolve permissions (sequential — needs user input) ──
      interface PreparedCall {
        tc: ToolCall;
        tool: Tool;
        args: Record<string, unknown>;
        denied: boolean;
        error?: string;
      }

      const prepared: PreparedCall[] = [];

      for (const tc of toolCalls) {
        const toolName = tc.function.name;
        const tool = this.tools.get(toolName);

        if (!tool) {
          prepared.push({ tc, tool: null as unknown as Tool, args: {}, denied: false, error: `Error: Unknown tool "${toolName}"` });
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
        yield { type: 'tool_call', toolCall: { name: toolName, args }, risk: { score: riskAssessment.score, level: riskAssessment.level } };

        // Log risk breakdown for high-risk calls
        if (riskAssessment.score > 50) {
          const breakdown = riskAssessment.factors.map(f => `${f.name}=${f.rawScore}`).join(', ');
          this.auditLogger.log({ tool: toolName, action: 'execute', args, result: `risk:${riskAssessment.score}`, reason: breakdown });
        }

        // Constitutional safety check (CORD + VIGIL)
        if (this.constitutional) {
          const cordResult = this.constitutional.evaluateAction({
            tool: toolName, args, type: TOOL_TYPE_MAP[toolName] || 'unknown',
          });

          if (cordResult.decision === 'BLOCK') {
            this.auditLogger.log({ tool: toolName, action: 'constitutional_block', args, reason: cordResult.explanation || 'Constitutional violation' });
            this.metricsCollector.increment('security_blocks_total', { tool: toolName, type: 'constitutional' });
            prepared.push({ tc, tool, args, denied: false, error: `Error: Blocked by constitutional safety: ${cordResult.explanation || 'violation detected'}` });
            continue;
          }

          if (cordResult.decision === 'CHALLENGE') {
            effectivePermission = 'always-ask';
          }
        }

        // SPARK adaptive safety — learned judgment overrides autoApprove
        let sparkChallenged = false;
        if (this.sparkSoul) {
          try {
            const sparkResult = this.sparkSoul.evaluateTool(toolName, args);
            if (sparkResult.decision === 'BLOCK') {
              prepared.push({ tc, tool, args, denied: false, error: 'Error: Blocked by SPARK: ' + sparkResult.reason });
              continue;
            }
            if (sparkResult.decision === 'CHALLENGE') {
              effectivePermission = 'always-ask';
              sparkChallenged = true;
            }
          } catch {}
        }

        // Permission check: policy override > tool default
        // autoApprove bypasses ALL permission levels (autonomous/dashboard mode)
        // EXCEPTION: SPARK's learned CHALLENGE overrides autoApprove — the system
        // has learned from repeated failures that this category needs human review
        const needsPermission = sparkChallenged || (!this.autoApprove && (
          effectivePermission === 'always-ask' ||
          effectivePermission === 'prompt'
        ));

        let denied = false;
        if (needsPermission) {
          const approved = await this.askPermission(toolName, args, riskAssessment, { sandbox: this.policyEnforcer.getSandboxMode() === 'docker', network: this.policyEnforcer.isNetworkAllowed() });
          if (!approved) {
            denied = true;
            this.auditLogger.log({ tool: toolName, action: 'deny', args, reason: 'User denied permission' });
            this.metricsCollector.increment('permission_denials_total', { tool: toolName });
          }
        }

        prepared.push({ tc, tool, args, denied });
      }

      // ── Phase 2: Execute tools (parallel where possible) ──
      type ToolOutput = { content: string; is_error?: boolean };
      const results: ToolOutput[] = new Array(prepared.length);

      // Immediately resolve errors and denials
      const toExecute: { index: number; prep: PreparedCall }[] = [];
      for (let idx = 0; idx < prepared.length; idx++) {
        const prep = prepared[idx];
        if (prep.error) {
          results[idx] = { content: prep.error, is_error: true };
        } else if (prep.denied) {
          results[idx] = { content: 'Permission denied by user.' };
        } else {
          toExecute.push({ index: idx, prep });
        }
      }

      // Split into parallel-safe and sequential (browser) groups
      const parallelBatch: typeof toExecute = [];
      const sequentialBatch: typeof toExecute = [];
      for (const item of toExecute) {
        if (SEQUENTIAL_TOOLS.has(item.prep.tc.function.name)) {
          sequentialBatch.push(item);
        } else {
          parallelBatch.push(item);
        }
      }

      // Helper to execute a single tool with cache + rate limiting + metrics
      const executeTool = async (prep: PreparedCall): Promise<ToolOutput> => {
        const toolName = prep.tc.function.name;
        const toolStartTime = Date.now();

        // Auto-branch on first write/edit when always_branch is enabled (v1.8.0)
        if (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'batch_edit') {
          const branchName = await this.ensureBranch();
          if (branchName) {
            this.auditLogger.log({ tool: 'git', action: 'execute', args: { branch: branchName }, result: 'auto-branch' });
          }
        }

        // Capability check: fine-grained resource restrictions (v1.8.0)
        const capBlock = this.checkToolCapabilities(toolName, prep.args);
        if (capBlock) {
          this.auditLogger.log({ tool: toolName, action: 'capability_block', args: prep.args, reason: capBlock });
          this.metricsCollector.increment('security_blocks_total', { tool: toolName, type: 'capability' });
          return { content: `Error: ${capBlock}`, is_error: true };
        }

        // Check cache first
        if (prep.tool.cacheable) {
          const cacheKey = ToolCache.key(toolName, prep.args);
          const cached = this.cache.get(cacheKey);
          if (cached !== null) {
            this.metricsCollector.increment('cache_hits_total', { tool: toolName });
            return { content: cached };
          }
          this.metricsCollector.increment('cache_misses_total', { tool: toolName });
        }

        // Rate limit
        await this.rateLimiter.throttle(toolName);

        try {
          const rawOutput = await prep.tool.execute(prep.args);
          const output = sanitizeToolOutput(rawOutput);

          // Record tool latency
          const latencyMs = Date.now() - toolStartTime;
          this.metricsCollector.observe('tool_latency_seconds', latencyMs / 1000, { tool: toolName });
          this.metricsCollector.increment('tool_calls_total', { tool: toolName });

          // Audit log: successful execution
          this.auditLogger.log({ tool: toolName, action: 'execute', args: prep.args, result: 'success' });

          // Telemetry: track tool calls and file modifications
          this.tokenTracker.recordToolCall();
          this.lastExecutedTools.push(toolName);
          if ((toolName === 'write_file' || toolName === 'edit_file' || toolName === 'batch_edit') && prep.args.path) {
            this.tokenTracker.recordFileModified(prep.args.path as string);
            this.metricsCollector.increment('files_written_total', { tool: toolName });
          }

          // Track commands executed
          if (toolName === 'execute') {
            this.metricsCollector.increment('commands_executed_total');
          }

          // Store in cache for cacheable tools
          if (prep.tool.cacheable) {
            const ttl = ToolCache.TTL[toolName] || 30_000;
            this.cache.set(ToolCache.key(toolName, prep.args), output, ttl);
          }

          // Invalidate cache on write operations
          if (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'batch_edit') {
            const filePath = prep.args.path as string;
            if (filePath) this.cache.invalidate(filePath);
          }

          // Audit log: check if tool returned a security block
          if (output.startsWith('Error: Blocked:') || output.startsWith('Error: CWD')) {
            this.auditLogger.log({ tool: toolName, action: 'security_block', args: prep.args, reason: output });
            this.metricsCollector.increment('security_blocks_total', { tool: toolName, type: 'security' });
          }

          // SPARK: record success
          if (this.sparkSoul) { try { this.sparkSoul.recordOutcome(toolName, prep.args, true, output, latencyMs); } catch {} }

          return { content: output };
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          // Record latency even on error
          const latencyMs = Date.now() - toolStartTime;
          this.metricsCollector.observe('tool_latency_seconds', latencyMs / 1000, { tool: toolName });
          this.metricsCollector.increment('errors_total', { tool: toolName });
          // Audit log: error
          this.auditLogger.log({ tool: toolName, action: 'error', args: prep.args, result: 'error', reason: errMsg });

          // SPARK: record failure
          if (this.sparkSoul) { try { this.sparkSoul.recordOutcome(toolName, prep.args, false, errMsg, latencyMs); } catch {} }

          // Append recovery hint if a known pattern matches
          const recovery = getRecoverySuggestion(errMsg);
          const hint = recovery ? `\n${formatRecoveryHint(recovery)}` : '';
          return { content: `Error: ${errMsg}${hint}`, is_error: true };
        }
      };

      // Execute parallel batch with concurrency limiter (max MAX_CONCURRENT_TOOLS at once)
      if (parallelBatch.length > 0) {
        let running = 0;
        const queue = [...parallelBatch];
        const waiters: Array<() => void> = [];
        const allDone: Promise<void>[] = [];

        for (const item of queue) {
          if (running >= MAX_CONCURRENT_TOOLS) {
            await new Promise<void>(resolve => waiters.push(resolve));
          }
          running++;
          const p = executeTool(item.prep).then(result => {
            results[item.index] = result;
            running--;
            if (waiters.length > 0) waiters.shift()!();
          });
          allDone.push(p);
        }
        await Promise.allSettled(allDone);
      }

      // Execute sequential batch one at a time
      for (const { index, prep } of sequentialBatch) {
        results[index] = await executeTool(prep);
      }

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
          // Clear the screenshot data reference (module-level export)
          const browserModule = require('./tools/browser');
          browserModule.lastScreenshotData = null;
        }

        this.messages.push(toolMsg);
        this.onMessage?.(toolMsg);

        if (prep.denied) {
          yield { type: 'tool_result', toolResult: { name: toolName, result: 'Permission denied.' } };
        } else {
          yield { type: 'tool_result', toolResult: { name: toolName, result: output.content, is_error: output.is_error } };
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

    if (this.sparkSoul) { try { this.sparkSoul.finalizeSession(); } catch {} }
    yield { type: 'error', error: `Max iterations (${this.maxIterations}) reached.` };
  }

  clearHistory() {
    const system = this.messages[0];
    this.messages = system?.role === 'system' ? [system] : [];
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
        cwd: this.projectRoot, encoding: 'utf-8', timeout: 5000,
      }).trim();

      if (currentBranch !== 'main' && currentBranch !== 'master') {
        this.branchCreated = true;
        return null; // Already on a feature branch
      }

      // Generate branch name from first user message
      const firstUserMsg = this.messages.find(m => m.role === 'user');
      const prefix = this.policyEnforcer.getBranchPrefix();
      const timestamp = new Date().toISOString().replace(/[:.]/g, '-').substring(0, 19);
      const slug = this.sanitizeSlug(firstUserMsg?.content || 'task');
      const branchName = `${prefix}${timestamp}-${slug}`;

      execSync(`git checkout -b "${branchName}"`, {
        cwd: this.projectRoot, encoding: 'utf-8', timeout: 10000,
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
    return message
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, '')
      .replace(/\s+/g, '-')
      .substring(0, 30)
      .replace(/-+$/, '') || 'task';
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
      } catch { /* invalid URL handled by the tool itself */ }
    }

    return null;
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

  const userResponse = new Promise<boolean>(resolve => {
    rl.question(`\n⚡ ${tool}\n${summary}\nAllow? [y/N] (${PERMISSION_TIMEOUT_MS / 1000}s timeout) `, answer => {
      rl.close();
      resolve(answer.toLowerCase().startsWith('y'));
    });
  });

  const timeout = new Promise<boolean>(resolve => {
    setTimeout(() => {
      rl.close();
      process.stdout.write('\n⏱ Permission timed out — denied by default.\n');
      resolve(false);
    }, PERMISSION_TIMEOUT_MS);
  });

  return Promise.race([userResponse, timeout]);
}
