/**
 * Execution Auditor — monitors tool execution patterns and detects anomalies.
 *
 * Tracks every tool execution result, detects recurring failures,
 * infinite loops, and performance degradation. Creates autonomous
 * recovery tasks when patterns indicate a problem.
 *
 * Designed to wire into agent.ts tool execution flow.
 */

import { FixAction } from './self-monitor';

// ── Types ──

export interface ToolExecution {
  toolName: string;
  success: boolean;
  durationMs: number;
  errorMessage?: string;
  timestamp: string;
}

export interface AnomalyReport {
  type: 'repeated_failure' | 'loop_detected' | 'slow_execution' | 'error_cascade';
  severity: 'warning' | 'critical';
  description: string;
  toolName: string;
  evidence: string[];
  fixAction?: FixAction;
}

// ── Execution Auditor ──

export class ExecutionAuditor {
  private executions: ToolExecution[] = [];
  private maxHistory = 200;

  /** Consecutive failure threshold before triggering anomaly */
  private failureThreshold = 3;
  /** Number of identical calls to detect a loop */
  private loopThreshold = 5;
  /** Duration in ms considered "slow" */
  private slowThresholdMs = 30_000;

  /**
   * Record a tool execution result. Returns any anomalies detected.
   */
  record(execution: ToolExecution): AnomalyReport[] {
    this.executions.push(execution);
    if (this.executions.length > this.maxHistory) {
      this.executions = this.executions.slice(-this.maxHistory);
    }

    return this.detect();
  }

  /**
   * Run all anomaly detection checks on recent history.
   */
  detect(): AnomalyReport[] {
    const anomalies: AnomalyReport[] = [];

    const repeatedFailure = this.detectRepeatedFailure();
    if (repeatedFailure) anomalies.push(repeatedFailure);

    const loop = this.detectLoop();
    if (loop) anomalies.push(loop);

    const slowExec = this.detectSlowExecution();
    if (slowExec) anomalies.push(slowExec);

    const cascade = this.detectErrorCascade();
    if (cascade) anomalies.push(cascade);

    return anomalies;
  }

  /**
   * Get recent execution history.
   */
  getHistory(): ToolExecution[] {
    return [...this.executions];
  }

  /**
   * Get execution stats for a specific tool.
   */
  getToolStats(toolName: string): { total: number; failures: number; avgDurationMs: number } {
    const toolExecs = this.executions.filter(e => e.toolName === toolName);
    const failures = toolExecs.filter(e => !e.success).length;
    const avgDuration = toolExecs.length > 0
      ? toolExecs.reduce((sum, e) => sum + e.durationMs, 0) / toolExecs.length
      : 0;

    return { total: toolExecs.length, failures, avgDurationMs: Math.round(avgDuration) };
  }

  /**
   * Get a summary of all tool execution health.
   */
  summarize(): string {
    if (this.executions.length === 0) return 'No tool executions recorded.';

    const toolMap = new Map<string, { total: number; failures: number; totalMs: number }>();
    for (const exec of this.executions) {
      const stats = toolMap.get(exec.toolName) || { total: 0, failures: 0, totalMs: 0 };
      stats.total++;
      if (!exec.success) stats.failures++;
      stats.totalMs += exec.durationMs;
      toolMap.set(exec.toolName, stats);
    }

    const lines = [`Execution Audit (${this.executions.length} total calls):`];
    for (const [name, stats] of toolMap) {
      const avgMs = Math.round(stats.totalMs / stats.total);
      const failRate = stats.failures > 0 ? ` (${stats.failures} failed)` : '';
      lines.push(`  ${name}: ${stats.total} calls, avg ${avgMs}ms${failRate}`);
    }

    return lines.join('\n');
  }

  /**
   * Reset execution history (e.g., after a session ends).
   */
  reset(): void {
    this.executions = [];
  }

  // ── Anomaly Detectors ──

  private detectRepeatedFailure(): AnomalyReport | null {
    const recent = this.executions.slice(-this.failureThreshold);
    if (recent.length < this.failureThreshold) return null;

    // Check if all recent executions of the same tool failed
    const lastTool = recent[recent.length - 1].toolName;
    const sameTool = recent.filter(e => e.toolName === lastTool);
    if (sameTool.length < this.failureThreshold) return null;

    const allFailed = sameTool.every(e => !e.success);
    if (!allFailed) return null;

    const errors = sameTool.map(e => e.errorMessage || 'unknown').slice(-3);

    return {
      type: 'repeated_failure',
      severity: 'critical',
      description: `Tool "${lastTool}" has failed ${sameTool.length} consecutive times`,
      toolName: lastTool,
      evidence: errors,
      fixAction: {
        description: `Investigate repeated "${lastTool}" failures: ${errors[0]}`,
        tool: 'think',
        args: {
          thought: `The "${lastTool}" tool has failed ${sameTool.length} times in a row. ` +
            `Errors: ${errors.join('; ')}. Consider an alternative approach.`,
        },
        risk: 0.2,
      },
    };
  }

  // Tools that legitimately make many sequential calls with varying actions
  private static LOOP_EXEMPT_TOOLS = new Set(['browser']);

  private detectLoop(): AnomalyReport | null {
    if (this.executions.length < this.loopThreshold) return null;

    const recent = this.executions.slice(-this.loopThreshold);
    // Skip loop detection for tools that naturally need many sequential calls
    if (ExecutionAuditor.LOOP_EXEMPT_TOOLS.has(recent[0].toolName)) return null;
    // Check if the same tool+args pattern repeats
    const signatures = recent.map(e => `${e.toolName}:${e.success}`);
    const uniqueSigs = new Set(signatures);

    if (uniqueSigs.size === 1) {
      const toolName = recent[0].toolName;
      return {
        type: 'loop_detected',
        severity: 'critical',
        description: `Possible infinite loop: "${toolName}" called ${this.loopThreshold} times with same pattern`,
        toolName,
        evidence: signatures,
        fixAction: {
          description: `Break loop — stop calling "${toolName}" and try a different approach`,
          tool: 'think',
          args: {
            thought: `Detected loop: "${toolName}" called ${this.loopThreshold} times identically. ` +
              `Stop and try a different strategy.`,
          },
          risk: 0.1,
        },
      };
    }

    return null;
  }

  private detectSlowExecution(): AnomalyReport | null {
    if (this.executions.length === 0) return null;

    const last = this.executions[this.executions.length - 1];
    if (last.durationMs < this.slowThresholdMs) return null;

    return {
      type: 'slow_execution',
      severity: 'warning',
      description: `Tool "${last.toolName}" took ${Math.round(last.durationMs / 1000)}s (threshold: ${this.slowThresholdMs / 1000}s)`,
      toolName: last.toolName,
      evidence: [`Duration: ${last.durationMs}ms`],
    };
  }

  private detectErrorCascade(): AnomalyReport | null {
    const window = this.executions.slice(-10);
    if (window.length < 5) return null;

    const failures = window.filter(e => !e.success);
    if (failures.length < 4) return null; // 40%+ failure rate in last 10

    const toolNames = [...new Set(failures.map(e => e.toolName))];
    if (toolNames.length < 2) return null; // Multiple tools failing = cascade

    return {
      type: 'error_cascade',
      severity: 'critical',
      description: `Error cascade: ${failures.length}/10 recent calls failed across ${toolNames.length} tools`,
      toolName: toolNames.join(', '),
      evidence: failures.map(e => `${e.toolName}: ${e.errorMessage || 'failed'}`),
      fixAction: {
        description: 'Multiple tools failing — check system health (API, disk, network)',
        tool: 'think',
        args: {
          thought: `Error cascade detected: ${toolNames.join(', ')} all failing. ` +
            `This suggests a systemic issue (API down, disk full, network issue). ` +
            `Run health check before continuing.`,
        },
        risk: 0.3,
      },
    };
  }
}
