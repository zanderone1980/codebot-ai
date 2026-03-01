/**
 * Delegate Tool for CodeBot v2.2.0-alpha
 *
 * Allows the parent agent to spawn child agents for parallel work.
 * Each child gets a scoped task, inherits policy, and reports back.
 *
 * Usage:
 *   delegate({ task: "Refactor auth module", files: ["src/auth.ts"] })
 *   delegate({ tasks: [{ task: "Fix file1", files: [...] }, { task: "Fix file2", files: [...] }] })
 */

import { Tool } from '../types';
import { Orchestrator, AgentTask, AgentResult, generateTaskId } from '../orchestrator';

export class DelegateTool implements Tool {
  name = 'delegate';
  description = 'Spawn child agent(s) to handle subtasks in parallel. Use for multi-file operations, parallel refactoring, or independent tasks. Each child gets a scoped task description and optional file context. Results are collected and returned.';
  permission: Tool['permission'] = 'prompt';
  parameters = {
    type: 'object',
    properties: {
      task: {
        type: 'string',
        description: 'Single task description for a child agent (use for one task)',
      },
      files: {
        type: 'array',
        items: { type: 'string' },
        description: 'Files/directories the child should focus on (scoped context)',
      },
      tasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            task: { type: 'string', description: 'Task description' },
            files: { type: 'array', items: { type: 'string' }, description: 'Scoped files' },
          },
          required: ['task'],
        },
        description: 'Multiple tasks to run in parallel (use for batch delegation)',
      },
    },
  };

  private orchestrator: Orchestrator | null = null;

  /** Set the orchestrator instance (injected by Agent) */
  setOrchestrator(orchestrator: Orchestrator) {
    this.orchestrator = orchestrator;
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    if (!this.orchestrator) {
      return 'Error: Multi-agent orchestration is not enabled. Start with --router or configure orchestration in policy.';
    }

    // Single task mode
    if (args.task && typeof args.task === 'string') {
      const task: AgentTask = {
        id: generateTaskId(),
        description: args.task,
        context: args.files as string[] | undefined,
      };

      const check = this.orchestrator.canSpawn();
      if (!check.allowed) {
        return `Error: Cannot spawn child agent — ${check.reason}`;
      }

      // Execute with a stub executor (real implementation wired in Agent)
      const result = await this.orchestrator.delegate(task, this.createChildExecutor());
      return this.formatResult(result);
    }

    // Batch mode
    if (args.tasks && Array.isArray(args.tasks)) {
      const tasks: AgentTask[] = (args.tasks as Array<Record<string, unknown>>).map(t => ({
        id: generateTaskId(),
        description: t.task as string,
        context: t.files as string[] | undefined,
      }));

      if (tasks.length === 0) {
        return 'Error: No tasks provided.';
      }

      const results = await this.orchestrator.delegateAll(tasks, this.createChildExecutor());
      return this.orchestrator.formatResultsSummary(results);
    }

    return 'Error: Provide either "task" (string) for a single child agent, or "tasks" (array) for parallel delegation.';
  }

  /**
   * Create a child executor function.
   * In the real implementation, this creates a new Agent instance
   * with inherited policy and scoped context.
   *
   * For now, this returns a stub that simulates child execution.
   * The Agent class will override this with real execution.
   */
  private createChildExecutor(): (task: AgentTask) => Promise<{ output: string; toolCalls: string[]; filesModified: string[] }> {
    return async (task: AgentTask) => {
      // Stub: the real executor is injected by the Agent class
      return {
        output: `Child agent completed: ${task.description}`,
        toolCalls: [],
        filesModified: [],
      };
    };
  }

  private formatResult(result: AgentResult): string {
    const statusIcon = result.status === 'success' ? '✅' : result.status === 'timeout' ? '⏱' : '❌';
    let output = `${statusIcon} Child agent: ${result.description}\n`;
    output += `Status: ${result.status} (${result.durationMs}ms)\n`;

    if (result.toolCalls.length > 0) {
      output += `Tools: ${result.toolCalls.join(', ')}\n`;
    }
    if (result.filesModified.length > 0) {
      output += `Files modified: ${result.filesModified.join(', ')}\n`;
    }
    if (result.output) {
      output += `Output: ${result.output}\n`;
    }
    if (result.error) {
      output += `Error: ${result.error}\n`;
    }

    return output;
  }
}
