/**
 * Decompose Goal Tool — allows the agent to autonomously break down
 * high-level goals into executable subtask trees.
 *
 * Actions:
 *   - decompose: Break a goal into subtasks
 *   - status: Get current tree state
 *   - complete: Mark a subtask as done
 *   - fail: Mark a subtask as failed
 *   - add_subtasks: Add subtasks to an existing node (LLM-driven refinement)
 *   - next: Get the next ready subtask(s)
 */

import { Tool, CapabilityLabel } from '../types';
import { GoalDecomposer, GoalTree, SubtaskDraft } from '../goal-decomposer';

export class DecomposeGoalTool implements Tool {
  name = 'decompose_goal';
  description =
    'Autonomous goal decomposition: break high-level goals into dependency-ordered subtask trees, ' +
    'track progress, and get next ready tasks. Actions: decompose, status, complete, fail, add_subtasks, next.';
  permission: Tool['permission'] = 'auto';
  capabilities: CapabilityLabel[] = ['read-only'];
  parameters = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        enum: ['decompose', 'status', 'complete', 'fail', 'add_subtasks', 'next'],
        description: 'Action to perform',
      },
      goal: {
        type: 'string',
        description: '(decompose) The high-level goal to decompose',
      },
      context: {
        type: 'array',
        items: { type: 'string' },
        description: '(decompose) Relevant file paths or directories',
      },
      goal_id: {
        type: 'string',
        description: '(complete/fail/add_subtasks) The goal node ID',
      },
      output: {
        type: 'string',
        description: '(complete) Summary output from executing this goal',
      },
      error: {
        type: 'string',
        description: '(fail) Error message explaining the failure',
      },
      subtasks: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            description: { type: 'string' },
            tool_hint: { type: 'string' },
            dependencies: { type: 'array', items: { type: 'string' } },
          },
          required: ['description'],
        },
        description: '(add_subtasks) New subtask definitions to add',
      },
    },
    required: ['action'],
  };

  private decomposer: GoalDecomposer;
  private activeTree: GoalTree | null = null;

  constructor(maxDepth = 3) {
    this.decomposer = new GoalDecomposer(maxDepth);
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = args.action as string;

    switch (action) {
      case 'decompose':
        return this.handleDecompose(args);
      case 'status':
        return this.handleStatus();
      case 'complete':
        return this.handleComplete(args);
      case 'fail':
        return this.handleFail(args);
      case 'add_subtasks':
        return this.handleAddSubtasks(args);
      case 'next':
        return this.handleNext();
      default:
        return `Unknown action: ${action}. Use: decompose, status, complete, fail, add_subtasks, next.`;
    }
  }

  private handleDecompose(args: Record<string, unknown>): string {
    const goal = args.goal as string | undefined;
    if (!goal) return 'Error: "goal" is required for decompose action.';

    const context = args.context as string[] | undefined;
    this.activeTree = this.decomposer.decompose(goal, context);

    const ready = this.decomposer.getReady(this.activeTree);
    return [
      `Goal decomposed into ${this.activeTree.nodes.size} nodes.`,
      '',
      this.decomposer.summarize(this.activeTree),
      '',
      `${ready.length} task(s) ready to execute:`,
      ...ready.map(n => `  - [${n.id}] ${n.description}${n.toolHint ? ` (hint: ${n.toolHint})` : ''}`),
    ].join('\n');
  }

  private handleStatus(): string {
    if (!this.activeTree) return 'No active goal tree. Use "decompose" first.';
    const ready = this.decomposer.getReady(this.activeTree);
    const finished = this.decomposer.isFinished(this.activeTree);
    return [
      this.decomposer.summarize(this.activeTree),
      '',
      finished ? 'Goal tree is FINISHED.' : `${ready.length} task(s) ready.`,
    ].join('\n');
  }

  private handleComplete(args: Record<string, unknown>): string {
    if (!this.activeTree) return 'No active goal tree.';
    const goalId = args.goal_id as string | undefined;
    if (!goalId) return 'Error: "goal_id" is required for complete action.';

    const node = this.activeTree.nodes.get(goalId);
    if (!node) return `Error: Goal "${goalId}" not found.`;

    const output = args.output as string | undefined;
    this.decomposer.complete(this.activeTree, goalId, output);

    const ready = this.decomposer.getReady(this.activeTree);
    const finished = this.decomposer.isFinished(this.activeTree);

    const lines = [`Completed: ${node.description}`];
    if (finished) {
      lines.push('', 'All goals FINISHED!');
      lines.push('', this.decomposer.summarize(this.activeTree));
    } else {
      lines.push('', `${ready.length} task(s) now ready:`);
      for (const n of ready) {
        lines.push(`  - [${n.id}] ${n.description}${n.toolHint ? ` (hint: ${n.toolHint})` : ''}`);
      }
    }
    return lines.join('\n');
  }

  private handleFail(args: Record<string, unknown>): string {
    if (!this.activeTree) return 'No active goal tree.';
    const goalId = args.goal_id as string | undefined;
    if (!goalId) return 'Error: "goal_id" is required for fail action.';

    const node = this.activeTree.nodes.get(goalId);
    if (!node) return `Error: Goal "${goalId}" not found.`;

    const error = (args.error as string) || 'Unknown failure';
    this.decomposer.fail(this.activeTree, goalId, error);

    return [
      `Failed: ${node.description}`,
      `Reason: ${error}`,
      '',
      this.decomposer.summarize(this.activeTree),
    ].join('\n');
  }

  private handleAddSubtasks(args: Record<string, unknown>): string {
    if (!this.activeTree) return 'No active goal tree.';
    const goalId = args.goal_id as string | undefined;
    if (!goalId) return 'Error: "goal_id" is required for add_subtasks action.';

    const rawSubtasks = args.subtasks as Array<{ description: string; tool_hint?: string; dependencies?: string[] }> | undefined;
    if (!rawSubtasks || rawSubtasks.length === 0) {
      return 'Error: "subtasks" array is required with at least one entry.';
    }

    const drafts: SubtaskDraft[] = rawSubtasks.map(s => ({
      description: s.description,
      toolHint: s.tool_hint,
      dependencies: s.dependencies,
    }));

    try {
      const created = this.decomposer.addSubtasks(this.activeTree, goalId, drafts);
      const ready = this.decomposer.getReady(this.activeTree);

      return [
        `Added ${created.length} subtask(s) to ${goalId}:`,
        ...created.map(n => `  - [${n.id}] ${n.description}`),
        '',
        `${ready.length} task(s) now ready.`,
      ].join('\n');
    } catch (err: unknown) {
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }

  private handleNext(): string {
    if (!this.activeTree) return 'No active goal tree. Use "decompose" first.';

    if (this.decomposer.isFinished(this.activeTree)) {
      return 'Goal tree is FINISHED. No more tasks.';
    }

    const ready = this.decomposer.getReady(this.activeTree);
    if (ready.length === 0) {
      return 'No tasks ready. Check status — there may be blocked or in-progress tasks.';
    }

    // Mark first ready as in_progress
    ready[0].status = 'in_progress';

    return [
      `Next task:`,
      `  ID: ${ready[0].id}`,
      `  Description: ${ready[0].description}`,
      ready[0].toolHint ? `  Suggested tool: ${ready[0].toolHint}` : '',
      ready[0].context ? `  Context: ${ready[0].context.join(', ')}` : '',
      '',
      `${ready.length - 1} more task(s) queued after this.`,
    ].filter(Boolean).join('\n');
  }

  /** Expose tree for testing / serialization */
  getActiveTree(): GoalTree | null {
    return this.activeTree;
  }
}
