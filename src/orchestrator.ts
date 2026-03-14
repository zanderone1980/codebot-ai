/**
 * Multi-Agent Orchestrator for CodeBot v2.2.0-alpha
 *
 * Enables a parent agent to spawn child agents for parallel work.
 * Child agents get scoped context (specific files, specific task)
 * and inherit the parent's policy (can't exceed parent permissions).
 *
 * Architecture:
 *   Parent Agent ─── orchestrator ──┬── Child Agent A (file1.ts)
 *                                   ├── Child Agent B (file2.ts)
 *                                   └── Child Agent C (tests/)
 *
 * Design constraints:
 *   - Max depth: 1 (parent → child, no grandchildren in v1)
 *   - Policy inheritance: children can't exceed parent permissions
 *   - Fail-open: child errors don't crash the parent
 *   - Results merge back into parent conversation
 */

import { Message, LLMProvider, AgentEvent, Tool } from './types';
import { PolicyEnforcer } from './policy';
import { MetricsCollector } from './metrics';

// ── Types ──

export interface AgentTask {
  id: string;
  description: string;
  /** Scoped context: files, directories, or content the child should focus on */
  context?: string[];
  /** Optional: override model for this child */
  model?: string;
  /** Max iterations for the child agent */
  maxIterations?: number;
}

export interface AgentResult {
  taskId: string;
  description: string;
  status: 'success' | 'error' | 'timeout';
  /** Final text output from the child agent */
  output: string;
  /** Tool calls the child made */
  toolCalls: string[];
  /** Files modified by the child */
  filesModified: string[];
  /** Duration in ms */
  durationMs: number;
  /** Error message if status is 'error' */
  error?: string;
}

export interface OrchestratorConfig {
  /** Maximum concurrent child agents */
  maxConcurrent: number;
  /** Maximum child agents per parent turn */
  maxChildAgents: number;
  /** Default max iterations per child */
  defaultMaxIterations: number;
  /** Timeout per child in ms */
  childTimeoutMs: number;
}

const DEFAULT_CONFIG: OrchestratorConfig = {
  maxConcurrent: 3,
  maxChildAgents: 5,
  defaultMaxIterations: 20,
  childTimeoutMs: 120_000, // 2 minutes
};

// ── Orchestrator ──

export class Orchestrator {
  private config: OrchestratorConfig;
  private policyEnforcer: PolicyEnforcer;
  private metrics: MetricsCollector;
  private activeChildren: Map<string, { task: AgentTask; startTime: number }> = new Map();
  private results: AgentResult[] = [];
  private depth: number;

  constructor(
    policyEnforcer: PolicyEnforcer,
    metrics: MetricsCollector,
    config?: Partial<OrchestratorConfig>,
    depth = 0,
  ) {
    this.policyEnforcer = policyEnforcer;
    this.metrics = metrics;
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.depth = depth;
  }

  /** Check if spawning a child agent is allowed */
  canSpawn(): { allowed: boolean; reason?: string } {
    // Depth limit: no grandchildren
    if (this.depth >= 1) {
      return { allowed: false, reason: 'Maximum agent depth reached (no grandchildren in v1)' };
    }

    // Concurrency limit
    if (this.activeChildren.size >= this.config.maxConcurrent) {
      return { allowed: false, reason: `Maximum concurrent agents reached (${this.config.maxConcurrent})` };
    }

    // Total children limit
    const totalSpawned = this.results.length + this.activeChildren.size;
    if (totalSpawned >= this.config.maxChildAgents) {
      return { allowed: false, reason: `Maximum child agents per turn reached (${this.config.maxChildAgents})` };
    }

    return { allowed: true };
  }

  /**
   * Delegate a task to a child agent.
   * Returns a promise that resolves when the child completes.
   *
   * The actual Agent execution is handled by the caller — this method
   * manages lifecycle, tracking, and policy enforcement.
   */
  async delegate(
    task: AgentTask,
    executor: (task: AgentTask) => Promise<{ output: string; toolCalls: string[]; filesModified: string[] }>,
  ): Promise<AgentResult> {
    const check = this.canSpawn();
    if (!check.allowed) {
      return {
        taskId: task.id,
        description: task.description,
        status: 'error',
        output: '',
        toolCalls: [],
        filesModified: [],
        durationMs: 0,
        error: check.reason,
      };
    }

    const startTime = Date.now();
    this.activeChildren.set(task.id, { task, startTime });
    this.metrics.increment('child_agents_spawned_total');

    const spanId = this.metrics.startSpan(`child-agent:${task.id}`, {
      'task.description': task.description,
      'task.id': task.id,
    });

    try {
      // Execute with timeout
      const timeoutMs = this.config.childTimeoutMs;
      const executionPromise = executor(task);
      const timeoutPromise = new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error(`Child agent timed out after ${timeoutMs}ms`)), timeoutMs),
      );

      const result = await Promise.race([executionPromise, timeoutPromise]);
      const durationMs = Date.now() - startTime;

      this.metrics.endSpan(spanId);
      this.metrics.observe('child_agent_duration_seconds', durationMs / 1000, { status: 'success' });
      this.metrics.increment('child_agents_completed_total', { status: 'success' });

      const agentResult: AgentResult = {
        taskId: task.id,
        description: task.description,
        status: 'success',
        output: result.output,
        toolCalls: result.toolCalls,
        filesModified: result.filesModified,
        durationMs,
      };

      this.results.push(agentResult);
      return agentResult;
    } catch (err: unknown) {
      const durationMs = Date.now() - startTime;
      const errorMsg = err instanceof Error ? err.message : String(err);
      const isTimeout = errorMsg.includes('timed out');

      this.metrics.endSpan(spanId, errorMsg);
      this.metrics.observe('child_agent_duration_seconds', durationMs / 1000, { status: isTimeout ? 'timeout' : 'error' });
      this.metrics.increment('child_agents_completed_total', { status: isTimeout ? 'timeout' : 'error' });

      const agentResult: AgentResult = {
        taskId: task.id,
        description: task.description,
        status: isTimeout ? 'timeout' : 'error',
        output: '',
        toolCalls: [],
        filesModified: [],
        durationMs,
        error: errorMsg,
      };

      this.results.push(agentResult);
      return agentResult;
    } finally {
      this.activeChildren.delete(task.id);
    }
  }

  /**
   * Delegate multiple tasks in parallel (up to maxConcurrent).
   * Returns results in the same order as tasks.
   */
  async delegateAll(
    tasks: AgentTask[],
    executor: (task: AgentTask) => Promise<{ output: string; toolCalls: string[]; filesModified: string[] }>,
  ): Promise<AgentResult[]> {
    const results: AgentResult[] = [];

    // Process in batches of maxConcurrent
    for (let i = 0; i < tasks.length; i += this.config.maxConcurrent) {
      const batch = tasks.slice(i, i + this.config.maxConcurrent);
      const batchResults = await Promise.allSettled(
        batch.map(task => this.delegate(task, executor)),
      );

      for (const result of batchResults) {
        if (result.status === 'fulfilled') {
          results.push(result.value);
        } else {
          // Should not happen since delegate catches errors, but just in case
          results.push({
            taskId: 'unknown',
            description: 'Unknown task',
            status: 'error',
            output: '',
            toolCalls: [],
            filesModified: [],
            durationMs: 0,
            error: result.reason?.message || 'Unknown error',
          });
        }
      }
    }

    return results;
  }

  /**
   * Format child results into a message for the parent agent's context.
   */
  formatResultsSummary(results: AgentResult[]): string {
    if (results.length === 0) return 'No child agent results.';

    const lines = [`## Child Agent Results (${results.length} tasks)\n`];

    for (const r of results) {
      const statusIcon = r.status === 'success' ? '✅' : r.status === 'timeout' ? '⏱' : '❌';
      lines.push(`### ${statusIcon} ${r.description}`);
      lines.push(`- Status: ${r.status} (${r.durationMs}ms)`);

      if (r.toolCalls.length > 0) {
        lines.push(`- Tools used: ${r.toolCalls.join(', ')}`);
      }
      if (r.filesModified.length > 0) {
        lines.push(`- Files modified: ${r.filesModified.join(', ')}`);
      }
      if (r.output) {
        const truncated = r.output.length > 500 ? r.output.substring(0, 500) + '...' : r.output;
        lines.push(`- Output: ${truncated}`);
      }
      if (r.error) {
        lines.push(`- Error: ${r.error}`);
      }
      lines.push('');
    }

    return lines.join('\n');
  }

  /** Get all completed results */
  getResults(): AgentResult[] {
    return [...this.results];
  }

  /** Get number of active children */
  getActiveCount(): number {
    return this.activeChildren.size;
  }

  /** Get orchestrator config */
  getConfig(): OrchestratorConfig {
    return { ...this.config };
  }
}

/**
 * Generate a unique task ID
 */
export function generateTaskId(): string {
  return `task_${Date.now()}_${Math.random().toString(36).substring(2, 8)}`;
}

