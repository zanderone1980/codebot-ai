import { ToolCall, Tool } from '../types';
import { ToolCache } from '../cache';
import { RateLimiter } from '../rate-limiter';
import { AuditLogger } from '../audit';
import { TokenTracker } from '../telemetry';
import { MetricsCollector } from '../metrics';
import { AgentStateEngine } from '../spark-soul';
import { getRecoverySuggestion, formatRecoveryHint } from '../recovery';
import { sanitizeToolOutput } from './message-repair';

/** Tools that must run sequentially (e.g. browser shares a single CDP session) */
export const SEQUENTIAL_TOOLS = new Set(['browser']);

/** Map CodeBot tool names to CORD tool types */
export const TOOL_TYPE_MAP: Record<string, string> = {
  execute: 'exec', write_file: 'write', edit_file: 'edit', batch_edit: 'edit',
  read_file: 'read', browser: 'browser', web_fetch: 'network', http_client: 'network',
  web_search: 'network', git: 'exec', docker: 'exec', ssh_remote: 'exec',
  notification: 'message', database: 'exec',
};

/** Max concurrent parallel tool executions */
export const MAX_CONCURRENT_TOOLS = 4;

/** A validated, permission-resolved tool call ready for execution */
export interface PreparedCall {
  tc: ToolCall;
  tool: Tool;
  args: Record<string, unknown>;
  denied: boolean;
  error?: string;
}

/** Result of a single tool execution */
export type ToolOutput = { content: string; is_error?: boolean; durationMs?: number };

/** Dependencies injected from Agent for tool execution */
export interface ToolExecutorDeps {
  cache: ToolCache;
  rateLimiter: RateLimiter;
  metricsCollector: MetricsCollector;
  auditLogger: AuditLogger;
  tokenTracker: TokenTracker;
  stateEngine: AgentStateEngine | null;
  lastExecutedTools: string[];
  ensureBranch: () => Promise<string | null>;
  checkToolCapabilities: (toolName: string, args: Record<string, unknown>) => string | null;
}

/**
 * Execute a single prepared tool call with cache, rate limiting, metrics, and audit logging.
 */
export async function executeSingleTool(prep: PreparedCall, deps: ToolExecutorDeps): Promise<ToolOutput> {
  const toolName = prep.tc.function.name;
  const toolStartTime = Date.now();

  // Auto-branch on first write/edit when always_branch is enabled
  if (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'batch_edit') {
    const branchName = await deps.ensureBranch();
    if (branchName) {
      deps.auditLogger.log({ tool: 'git', action: 'execute', args: { branch: branchName }, result: 'auto-branch' });
    }
  }

  // Capability check: fine-grained resource restrictions
  const capBlock = deps.checkToolCapabilities(toolName, prep.args);
  if (capBlock) {
    deps.auditLogger.log({ tool: toolName, action: 'capability_block', args: prep.args, reason: capBlock });
    deps.metricsCollector.increment('security_blocks_total', { tool: toolName, type: 'capability' });
    return { content: `Error: ${capBlock}`, is_error: true };
  }

  // Check cache first
  if (prep.tool.cacheable) {
    const cacheKey = ToolCache.key(toolName, prep.args);
    const cached = deps.cache.get(cacheKey);
    if (cached !== null) {
      deps.metricsCollector.increment('cache_hits_total', { tool: toolName });
      return { content: cached };
    }
    deps.metricsCollector.increment('cache_misses_total', { tool: toolName });
  }

  // Rate limit
  await deps.rateLimiter.throttle(toolName);

  try {
    const rawOutput = await prep.tool.execute(prep.args);
    const output = sanitizeToolOutput(rawOutput);

    // Record tool latency
    const latencyMs = Date.now() - toolStartTime;
    deps.metricsCollector.observe('tool_latency_seconds', latencyMs / 1000, { tool: toolName });
    deps.metricsCollector.increment('tool_calls_total', { tool: toolName });

    // Audit log: successful execution
    deps.auditLogger.log({ tool: toolName, action: 'execute', args: prep.args, result: 'success' });

    // Telemetry: track tool calls and file modifications
    deps.tokenTracker.recordToolCall();
    deps.lastExecutedTools.push(toolName);
    if ((toolName === 'write_file' || toolName === 'edit_file' || toolName === 'batch_edit') && prep.args.path) {
      deps.tokenTracker.recordFileModified(prep.args.path as string);
      deps.metricsCollector.increment('files_written_total', { tool: toolName });
    }

    // Track commands executed
    if (toolName === 'execute') {
      deps.metricsCollector.increment('commands_executed_total');
    }

    // Store in cache for cacheable tools
    if (prep.tool.cacheable) {
      const ttl = ToolCache.TTL[toolName] || 30_000;
      deps.cache.set(ToolCache.key(toolName, prep.args), output, ttl);
    }

    // Invalidate cache on write operations
    if (toolName === 'write_file' || toolName === 'edit_file' || toolName === 'batch_edit') {
      const filePath = prep.args.path as string;
      if (filePath) deps.cache.invalidate(filePath);
    }

    // Audit log: check if tool returned a security block
    if (output.startsWith('Error: Blocked:') || output.startsWith('Error: CWD')) {
      deps.auditLogger.log({ tool: toolName, action: 'security_block', args: prep.args, reason: output });
      deps.metricsCollector.increment('security_blocks_total', { tool: toolName, type: 'security' });
    }

    // SPARK: record success
    if (deps.stateEngine) { try { deps.stateEngine.recordOutcome(toolName, prep.args, true, output, latencyMs); } catch {} }

    return { content: output, durationMs: latencyMs };
  } catch (err: unknown) {
    const errMsg = err instanceof Error ? err.message : String(err);
    // Record latency even on error
    const latencyMs = Date.now() - toolStartTime;
    deps.metricsCollector.observe('tool_latency_seconds', latencyMs / 1000, { tool: toolName });
    deps.metricsCollector.increment('errors_total', { tool: toolName });
    // Audit log: error
    deps.auditLogger.log({ tool: toolName, action: 'error', args: prep.args, result: 'error', reason: errMsg });

    // SPARK: record failure
    if (deps.stateEngine) { try { deps.stateEngine.recordOutcome(toolName, prep.args, false, errMsg, latencyMs); } catch {} }

    // Append recovery hint if a known pattern matches
    const recovery = getRecoverySuggestion(errMsg);
    const hint = recovery ? `\n${formatRecoveryHint(recovery)}` : '';
    return { content: `Error: ${errMsg}${hint}`, is_error: true, durationMs: latencyMs };
  }
}

/**
 * Execute a batch of prepared tool calls, respecting sequential constraints
 * and concurrency limits. Returns results in the same order as input.
 */
export async function executeToolBatch(
  prepared: PreparedCall[],
  deps: ToolExecutorDeps,
): Promise<ToolOutput[]> {
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

  // Execute parallel batch with concurrency limiter
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
      const p = executeSingleTool(item.prep, deps).then(result => {
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
    results[index] = await executeSingleTool(prep, deps);
  }

  return results;
}
