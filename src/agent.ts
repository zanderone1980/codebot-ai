import * as readline from 'readline';
import { Message, ToolCall, AgentEvent, LLMProvider, ToolSchema, Tool } from './types';
import { ToolRegistry } from './tools';
import { parseToolCalls } from './parser';
import { ContextManager } from './context/manager';
import { isFatalError } from './retry';
import { buildRepoMap } from './context/repo-map';
import { MemoryManager } from './memory';
import { getModelInfo } from './providers/registry';
import { loadPlugins } from './plugins';
import { ToolCache } from './cache';
import { RateLimiter } from './rate-limiter';
import { AuditLogger } from './audit';
import { PolicyEnforcer, loadPolicy } from './policy';
import { TokenTracker } from './telemetry';
import { MetricsCollector } from './metrics';
import { RiskScorer } from './risk';

/** Lightweight schema validation — returns error string or null if valid */
function validateToolArgs(args: Record<string, unknown>, schema: Record<string, unknown>): string | null {
  const props = schema.properties as Record<string, Record<string, unknown>> | undefined;
  const required = schema.required as string[] | undefined;

  if (!props) return null;

  // Check required fields exist
  if (required) {
    for (const field of required) {
      if (args[field] === undefined || args[field] === null) {
        return `missing required field '${field}'`;
      }
    }
  }

  // Check types match for provided fields
  for (const [key, value] of Object.entries(args)) {
    const propSchema = props[key];
    if (!propSchema) continue; // extra fields are OK

    const expectedType = propSchema.type as string | undefined;
    if (!expectedType) continue;

    const actualType = Array.isArray(value) ? 'array' : typeof value;

    if (expectedType === 'string' && actualType !== 'string') {
      return `field '${key}' expected string, got ${actualType}`;
    }
    if (expectedType === 'number' && actualType !== 'number') {
      return `field '${key}' expected number, got ${actualType}`;
    }
    if (expectedType === 'boolean' && actualType !== 'boolean') {
      return `field '${key}' expected boolean, got ${actualType}`;
    }
    if (expectedType === 'array' && !Array.isArray(value)) {
      return `field '${key}' expected array, got ${actualType}`;
    }
    if (expectedType === 'object' && (actualType !== 'object' || Array.isArray(value))) {
      return `field '${key}' expected object, got ${actualType}`;
    }
  }

  return null;
}

/** Tools that use shared global state and must not run concurrently */
const SEQUENTIAL_TOOLS = new Set(['browser']);

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
  private auditLogger: AuditLogger;
  private policyEnforcer: PolicyEnforcer;
  private tokenTracker: TokenTracker;
  private metricsCollector: MetricsCollector;
  private riskScorer: RiskScorer;
  private branchCreated: boolean = false;
  private askPermission: (tool: string, args: Record<string, unknown>) => Promise<boolean>;
  private onMessage?: (message: Message) => void;

  constructor(opts: {
    provider: LLMProvider;
    model: string;
    providerName?: string;
    maxIterations?: number;
    autoApprove?: boolean;
    askPermission?: (tool: string, args: Record<string, unknown>) => Promise<boolean>;
    onMessage?: (message: Message) => void;
  }) {
    this.provider = opts.provider;
    this.model = opts.model;

    // Load policy FIRST — tools need it for filesystem/git enforcement
    this.policyEnforcer = new PolicyEnforcer(loadPolicy(process.cwd()), process.cwd());

    this.tools = new ToolRegistry(process.cwd(), this.policyEnforcer);
    this.context = new ContextManager(opts.model, opts.provider);

    // Use policy-defined max iterations as default, CLI overrides
    this.maxIterations = opts.maxIterations || this.policyEnforcer.getMaxIterations();
    this.autoApprove = opts.autoApprove || false;
    this.askPermission = opts.askPermission || defaultAskPermission;
    this.onMessage = opts.onMessage;
    this.cache = new ToolCache();
    this.rateLimiter = new RateLimiter();
    this.auditLogger = new AuditLogger();

    // Token & cost tracking
    this.tokenTracker = new TokenTracker(opts.model, opts.providerName || 'unknown');
    this.metricsCollector = new MetricsCollector();
    this.riskScorer = new RiskScorer();
    const costLimit = this.policyEnforcer.getCostLimitUsd();
    if (costLimit > 0) this.tokenTracker.setCostLimit(costLimit);

    // Load plugins
    try {
      const plugins = loadPlugins(process.cwd());
      for (const plugin of plugins) {
        this.tools.register(plugin);
      }
    } catch { /* plugins unavailable */ }

    const supportsTools = getModelInfo(opts.model).supportsToolCalling;
    this.messages.push({
      role: 'system',
      content: this.buildSystemPrompt(supportsTools),
    });
  }

  /** Update auto-approve mode at runtime (e.g., from /auto command) */
  setAutoApprove(value: boolean) {
    this.autoApprove = value;
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
      this.repairToolCallMessages();

      const supportsTools = getModelInfo(this.model).supportsToolCalling;
      const toolSchemas = supportsTools ? this.tools.getSchemas() : undefined;

      let fullText = '';
      let toolCalls: ToolCall[] = [];
      let streamError: string | null = null;

      // Stream LLM response — wrapped in try-catch for resilience
      try {
        for await (const event of this.provider.chat(this.messages, toolSchemas)) {
          switch (event.type) {
            case 'text':
              fullText += event.text || '';
              yield { type: 'text', text: event.text };
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
                this.metricsCollector.increment('llm_requests_total');
                this.metricsCollector.increment('llm_tokens_total', { direction: 'input' }, event.usage.inputTokens || 0);
                this.metricsCollector.increment('llm_tokens_total', { direction: 'output' }, event.usage.outputTokens || 0);
              }
              yield { type: 'usage', usage: event.usage };
              break;
            case 'error':
              streamError = event.error || 'Unknown provider error';
              break;
          }
        }
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        streamError = `Stream error: ${msg}`;
      }

      if (streamError) {
        yield { type: 'error', error: streamError };

        // Fatal errors (missing API key, auth failure, billing, etc.) — stop immediately
        if (isFatalError(streamError)) {
          return;
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
        const effectivePermission = policyPermission || tool.permission;
        const riskAssessment = this.riskScorer.assess(toolName, args, effectivePermission);
        yield { type: 'tool_call', toolCall: { name: toolName, args }, risk: { score: riskAssessment.score, level: riskAssessment.level } };

        // Log risk breakdown for high-risk calls
        if (riskAssessment.score > 50) {
          const breakdown = riskAssessment.factors.map(f => `${f.name}=${f.rawScore}`).join(', ');
          this.auditLogger.log({ tool: toolName, action: 'execute', args, result: `risk:${riskAssessment.score}`, reason: breakdown });
        }

        // Permission check: policy override > tool default
        const needsPermission =
          effectivePermission === 'always-ask' ||
          (effectivePermission === 'prompt' && !this.autoApprove);

        let denied = false;
        if (needsPermission) {
          const approved = await this.askPermission(toolName, args);
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
          const output = await prep.tool.execute(prep.args);

          // Record tool latency
          const latencyMs = Date.now() - toolStartTime;
          this.metricsCollector.observe('tool_latency_seconds', latencyMs / 1000, { tool: toolName });
          this.metricsCollector.increment('tool_calls_total', { tool: toolName });

          // Audit log: successful execution
          this.auditLogger.log({ tool: toolName, action: 'execute', args: prep.args, result: 'success' });

          // Telemetry: track tool calls and file modifications
          this.tokenTracker.recordToolCall();
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

          return { content: output };
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          // Record latency even on error
          const latencyMs = Date.now() - toolStartTime;
          this.metricsCollector.observe('tool_latency_seconds', latencyMs / 1000, { tool: toolName });
          this.metricsCollector.increment('errors_total', { tool: toolName });
          // Audit log: error
          this.auditLogger.log({ tool: toolName, action: 'error', args: prep.args, result: 'error', reason: errMsg });
          return { content: `Error: ${errMsg}`, is_error: true };
        }
      };

      // Execute parallel batch concurrently
      if (parallelBatch.length > 0) {
        const promises = parallelBatch.map(async ({ index, prep }) => {
          results[index] = await executeTool(prep);
        });
        await Promise.allSettled(promises);
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

  /** Get the risk scorer for risk assessment history */
  getRiskScorer(): RiskScorer {
    return this.riskScorer;
  }

  /**
   * Validate and repair message history to prevent OpenAI 400 errors.
   * Handles three types of corruption:
   *  1. Orphaned tool messages — tool_call_id doesn't match any preceding assistant's tool_calls
   *  2. Duplicate tool responses — multiple tool messages for the same tool_call_id
   *  3. Missing tool responses — assistant has tool_calls but no matching tool response
   *
   * This runs before every LLM call to self-heal from stream errors, compaction artifacts,
   * or session resume corruption.
   */
  private repairToolCallMessages(): void {
    // Phase 1: Collect all valid tool_call_ids from assistant messages (in order)
    const validToolCallIds = new Set<string>();
    for (const msg of this.messages) {
      if (msg.role === 'assistant' && msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          validToolCallIds.add(tc.id);
        }
      }
    }

    // Phase 2: Remove orphaned tool messages and duplicates
    const seenToolResponseIds = new Set<string>();
    this.messages = this.messages.filter(msg => {
      if (msg.role !== 'tool') return true;

      const tcId = msg.tool_call_id;

      // No tool_call_id at all — malformed, remove
      if (!tcId) return false;

      // Orphaned: tool_call_id doesn't match any assistant's tool_calls
      if (!validToolCallIds.has(tcId)) return false;

      // Duplicate: already have a response for this tool_call_id
      if (seenToolResponseIds.has(tcId)) return false;

      seenToolResponseIds.add(tcId);
      return true;
    });

    // Phase 3: Add missing tool responses (assistant has tool_calls but no tool response)
    const toolResponseIds = new Set<string>();
    for (const msg of this.messages) {
      if (msg.role === 'tool' && msg.tool_call_id) {
        toolResponseIds.add(msg.tool_call_id);
      }
    }

    for (let i = 0; i < this.messages.length; i++) {
      const msg = this.messages[i];
      if (msg.role === 'assistant' && msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          if (!toolResponseIds.has(tc.id)) {
            const repairMsg: Message = {
              role: 'tool',
              content: 'Error: tool call was not executed (interrupted).',
              tool_call_id: tc.id,
            };
            // Insert after the assistant message and any existing tool responses
            let insertAt = i + 1;
            while (insertAt < this.messages.length && this.messages[insertAt].role === 'tool') {
              insertAt++;
            }
            this.messages.splice(insertAt, 0, repairMsg);
            toolResponseIds.add(tc.id);
          }
        }
      }
    }
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
      const cwd = process.cwd();

      const currentBranch = execSync('git rev-parse --abbrev-ref HEAD', {
        cwd, encoding: 'utf-8', timeout: 5000,
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
        cwd, encoding: 'utf-8', timeout: 10000,
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

  private buildSystemPrompt(supportsTools: boolean): string {
    let repoMap = '';
    try {
      repoMap = buildRepoMap(process.cwd());
    } catch {
      repoMap = 'Project structure: (unable to scan)';
    }

    // Load persistent memory
    let memoryBlock = '';
    try {
      const memory = new MemoryManager(process.cwd());
      memoryBlock = memory.getContextBlock();
    } catch {
      // memory unavailable
    }

    let prompt = `You are CodeBot, a fully autonomous AI agent. You help with ANY task: coding, research, sending emails, posting on social media, web automation, and anything else that can be accomplished with a computer.

CRITICAL IDENTITY — you MUST follow this:
- Your name is CodeBot.
- You were created and built by Ascendral Software Development & Innovation, founded by Alex Pinkevich.
- You are NOT made by OpenAI, Google, Anthropic, or any other AI company. You are made by Ascendral.
- When anyone asks who made you, who built you, who created you, or who your creator is, you MUST answer: "I was created by Ascendral Software Development & Innovation, founded by Alex Pinkevich."
- Never claim to be made by or affiliated with OpenAI, GPT, Claude, Gemini, or any LLM provider. You are CodeBot by Ascendral.

CORE BEHAVIOR — ACTION FIRST:
- NEVER just explain how to do something. Actually DO IT using your tools.
- When asked to check, fix, run, or do anything — immediately start executing commands and taking action.
- Do not ask "what OS are you using?" — detect it yourself with commands like "uname -a" or "sw_vers".
- Do not say "I can guide you" or "here are the steps." Instead, RUN the steps yourself.
- If a task requires multiple commands, run them all. Show the user results, not instructions.
- Only ask the user a question if there's a genuine ambiguity you cannot resolve yourself (e.g., "which of these 3 accounts?").
- Be concise and direct. Say what you're doing, do it, show the result.

Rules:
- When given a goal, break it into steps and execute them using your tools immediately.
- Always read files before editing them. Prefer editing over rewriting entire files.
- Use the memory tool to save important context, user preferences, and patterns you learn. Memory persists across sessions.
- After completing social media posts, emails, or research tasks, log the outcome to memory (file: "outcomes") for future learning.
- Before doing social media or email tasks, read your memory files for any saved skills or style guides.

Skills:
- System tasks: use the execute tool to run shell commands — check disk space, CPU usage, memory, processes, network, installed software, system health, anything the OS supports.
- Web browsing: use the browser tool to navigate, click, type, find elements by text, scroll, press keys, hover, and manage tabs.
- Research: use web_search for quick lookups, then browser for deep reading of specific pages.
- Social media: navigate to the platform, find the compose area with find_by_text, type your content, and submit.
- Email: navigate to Gmail/email, compose and send messages through the browser interface.
- Routines: use the routine tool to schedule recurring tasks (daily posts, email checks, etc.).

${repoMap}${memoryBlock}`;

    if (!supportsTools) {
      prompt += `

To use tools, wrap calls in XML tags:
<tool_call>{"name": "tool_name", "arguments": {"arg1": "value1"}}</tool_call>

Available tools:
${this.tools.all().map(t => `- ${t.name}: ${t.description}`).join('\n')}`;
    }

    return prompt;
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
