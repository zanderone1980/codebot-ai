/**
 * Task runner — headless autonomous task execution with structured audit output.
 * Used by the --task CLI flag for CI/automation workflows.
 */

import { Agent } from './agent';
import { LLMProvider, AgentEvent } from './types';
import * as fs from 'fs';
import * as path from 'path';

export interface TaskOptions {
  task: string;
  provider: LLMProvider;
  model: string;
  providerName: string;
  projectRoot: string;
  auditLogPath?: string;
  outputFormat?: 'json' | 'text' | 'sarif';
  maxCost?: number;
  preset?: string;
}

export interface TaskResult {
  task: string;
  status: 'completed' | 'failed' | 'cost_exceeded' | 'max_iterations';
  startedAt: string;
  completedAt: string;
  toolCalls: Array<{ tool: string; success: boolean; }>;
  filesModified: string[];
  summary: string;
  cost: { input_tokens: number; output_tokens: number; estimated_usd: number };
  errors: string[];
}

export async function runTask(opts: TaskOptions): Promise<TaskResult> {
  const startedAt = new Date().toISOString();
  const toolCalls: Array<{ tool: string; success: boolean }> = [];
  const filesModified: string[] = [];
  const errors: string[] = [];
  let summary = '';
  let lastAssistantText = '';

  // Create agent with auto-approve for headless execution
  const agent = new Agent({
    provider: opts.provider,
    model: opts.model,
    providerName: opts.providerName,
    maxIterations: 50,
    autoApprove: true,
  });

  // Apply preset if specified
  if (opts.preset) {
    try {
      const pe = (agent as any).policyEnforcer;
      if (pe && pe.applyPreset) pe.applyPreset(opts.preset);
    } catch { /* preset unavailable */ }
  }

  // Apply max cost override
  if (opts.maxCost) {
    try {
      const tt = (agent as any).tokenTracker;
      if (tt && tt.setCostLimit) tt.setCostLimit(opts.maxCost);
    } catch { /* token tracker unavailable */ }
  }

  process.stderr.write(`\n  CodeBot Task Runner\n  Task: ${opts.task}\n  Model: ${opts.model}\n\n`);

  let status: TaskResult['status'] = 'completed';

  try {
    for await (const event of agent.run(opts.task)) {
      const ev = event as AgentEvent & { toolResult?: any; text?: string; error?: string };
      switch (ev.type) {
        case 'text':
          lastAssistantText = ev.text || '';
          break;
        case 'tool_result':
          if (ev.toolResult) {
            const tc = { tool: ev.toolResult.name || 'unknown', success: !ev.toolResult.is_error };
            toolCalls.push(tc);
            process.stderr.write(`  [${tc.success ? '✓' : '✗'}] ${tc.tool}\n`);
            // Track file modifications
            if (['write_file', 'edit_file', 'batch_edit'].includes(tc.tool) && tc.success) {
              filesModified.push(tc.tool);
            }
          }
          break;
        case 'error':
          errors.push(ev.error || 'Unknown error');
          if (ev.error?.includes('Cost limit')) status = 'cost_exceeded';
          else if (ev.error?.includes('Max iterations')) status = 'max_iterations';
          else status = 'failed';
          break;
        case 'done':
          status = 'completed';
          break;
      }
    }
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(msg);
    status = 'failed';
  }

  summary = lastAssistantText || (status === 'completed' ? 'Task completed successfully.' : `Task ${status}.`);
  const completedAt = new Date().toISOString();

  const result: TaskResult = {
    task: opts.task,
    status,
    startedAt,
    completedAt,
    toolCalls,
    filesModified: [...new Set(filesModified)],
    summary: summary.substring(0, 2000),
    cost: { input_tokens: 0, output_tokens: 0, estimated_usd: 0 },
    errors,
  };

  // Try to get token usage
  try {
    const tt = (agent as any).tokenTracker;
    if (tt) {
      const s = tt.getSummary();
      result.cost = { input_tokens: s.totalInputTokens || 0, output_tokens: s.totalOutputTokens || 0, estimated_usd: tt.getTotalCost() || 0 };
    }
  } catch { /* token tracker unavailable */ }

  // Output results
  const format = opts.outputFormat || 'text';
  if (format === 'json') {
    const output = JSON.stringify(result, null, 2);
    if (opts.auditLogPath) {
      fs.mkdirSync(path.dirname(path.resolve(opts.auditLogPath)), { recursive: true });
      fs.writeFileSync(opts.auditLogPath, output + '\n');
      process.stderr.write(`\n  Audit log written to: ${opts.auditLogPath}\n`);
    } else {
      process.stdout.write(output + '\n');
    }
  } else if (format === 'sarif') {
    const sarif = toSarif(result);
    const output = JSON.stringify(sarif, null, 2);
    if (opts.auditLogPath) {
      fs.mkdirSync(path.dirname(path.resolve(opts.auditLogPath)), { recursive: true });
      fs.writeFileSync(opts.auditLogPath, output + '\n');
    } else {
      process.stdout.write(output + '\n');
    }
  } else {
    // Text summary to stderr
    process.stderr.write(`\n  ── Task Result ──\n`);
    process.stderr.write(`  Status: ${status}\n`);
    process.stderr.write(`  Tools: ${toolCalls.length} calls (${toolCalls.filter(t => t.success).length} succeeded)\n`);
    process.stderr.write(`  Cost: $${result.cost.estimated_usd.toFixed(4)}\n`);
    if (errors.length > 0) process.stderr.write(`  Errors: ${errors.join('; ')}\n`);
    process.stderr.write(`  Duration: ${((new Date(completedAt).getTime() - new Date(startedAt).getTime()) / 1000).toFixed(1)}s\n\n`);
  }

  return result;
}

function toSarif(result: TaskResult): object {
  return {
    $schema: 'https://raw.githubusercontent.com/oasis-tcs/sarif-spec/master/Schemata/sarif-schema-2.1.0.json',
    version: '2.1.0',
    runs: [{
      tool: { driver: { name: 'CodeBot', version: '2.9.0', informationUri: 'https://github.com/Ascendral/codebot-ai' } },
      results: result.errors.map((err, i) => ({
        ruleId: 'task-error',
        level: 'error',
        message: { text: err },
        ruleIndex: i,
      })),
      invocations: [{
        executionSuccessful: result.status === 'completed',
        startTimeUtc: result.startedAt,
        endTimeUtc: result.completedAt,
      }],
    }],
  };
}
