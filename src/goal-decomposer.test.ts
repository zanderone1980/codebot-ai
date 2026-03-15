import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { GoalDecomposer, GoalTree } from './goal-decomposer';
import { DecomposeGoalTool } from './tools/decompose-goal';

describe('GoalDecomposer', () => {
  it('decomposes a bug-fix goal into subtasks', () => {
    const d = new GoalDecomposer();
    const tree = d.decompose('Fix the login error in auth module');

    assert.ok(tree.nodes.size > 1, 'Should create subtasks');
    assert.strictEqual(tree.nodes.get(tree.rootId)!.depth, 0);

    // Root should be in_progress (has children)
    const root = tree.nodes.get(tree.rootId)!;
    assert.strictEqual(root.status, 'in_progress');
  });

  it('decomposes a feature-add goal', () => {
    const d = new GoalDecomposer();
    const tree = d.decompose('Add dark mode toggle to settings page');
    assert.ok(tree.nodes.size >= 4, 'Feature goals should have multiple steps');
  });

  it('decomposes a refactor goal', () => {
    const d = new GoalDecomposer();
    const tree = d.decompose('Refactor the database module for clarity');
    assert.ok(tree.nodes.size >= 3);
  });

  it('decomposes a test goal', () => {
    const d = new GoalDecomposer();
    const tree = d.decompose('Write tests for the payment module');
    assert.ok(tree.nodes.size >= 3);
  });

  it('decomposes a deploy goal', () => {
    const d = new GoalDecomposer();
    const tree = d.decompose('Deploy the application to production');
    assert.ok(tree.nodes.size >= 3);
  });

  it('decomposes a research goal', () => {
    const d = new GoalDecomposer();
    const tree = d.decompose('Investigate memory leak in worker process');
    assert.ok(tree.nodes.size >= 3);
  });

  it('returns single-node tree for unrecognized goals', () => {
    const d = new GoalDecomposer();
    const tree = d.decompose('Do something completely generic');
    // No strategy matches, should be just the root
    assert.strictEqual(tree.nodes.size, 1);
    const root = tree.nodes.get(tree.rootId)!;
    assert.strictEqual(root.status, 'ready');
  });

  it('respects maxDepth', () => {
    const d = new GoalDecomposer(1);
    const tree = d.decompose('Fix the login bug and add tests');
    for (const node of tree.nodes.values()) {
      assert.ok(node.depth <= 1, `Node depth ${node.depth} exceeds maxDepth 1`);
    }
  });

  it('getReady returns only leaf ready nodes', () => {
    const d = new GoalDecomposer();
    const tree = d.decompose('Fix the crash in parser module');
    const ready = d.getReady(tree);

    assert.ok(ready.length > 0, 'Should have at least one ready node');
    for (const node of ready) {
      assert.strictEqual(node.subtasks.length, 0, 'Ready nodes should be leaves');
      assert.strictEqual(node.status, 'ready');
    }
  });

  it('complete propagates up the tree', () => {
    const d = new GoalDecomposer(1); // depth 1 so subtasks are leaves
    const tree = d.decompose('Fix the authentication error');
    const root = tree.nodes.get(tree.rootId)!;

    // Complete all subtasks
    for (const childId of root.subtasks) {
      d.complete(tree, childId, 'Done');
    }

    assert.strictEqual(root.status, 'completed');
  });

  it('fail skips dependents', () => {
    const d = new GoalDecomposer(1);
    const tree = d.decompose('Fix the login bug');
    const root = tree.nodes.get(tree.rootId)!;

    // Get the first ready task and fail it
    const ready = d.getReady(tree);
    assert.ok(ready.length > 0);
    d.fail(tree, ready[0].id, 'Search found nothing');

    // Dependents should be skipped
    let skippedCount = 0;
    for (const node of tree.nodes.values()) {
      if (node.status === 'skipped') skippedCount++;
    }
    assert.ok(skippedCount > 0, 'Should have skipped dependent tasks');
  });

  it('isFinished returns true when root completes', () => {
    const d = new GoalDecomposer();
    const tree = d.decompose('Do something generic');
    assert.strictEqual(d.isFinished(tree), false);

    d.complete(tree, tree.rootId, 'Done');
    assert.strictEqual(d.isFinished(tree), true);
  });

  it('isFinished returns true when root fails', () => {
    const d = new GoalDecomposer(1);
    const tree = d.decompose('Fix the crash bug');
    const root = tree.nodes.get(tree.rootId)!;

    // Fail a subtask — root should fail too
    const ready = d.getReady(tree);
    d.fail(tree, ready[0].id, 'Failure');

    // Root fails because a child failed
    assert.strictEqual(root.status, 'failed');
    assert.strictEqual(d.isFinished(tree), true);
  });

  it('addSubtasks adds children to an existing node', () => {
    const d = new GoalDecomposer();
    const tree = d.decompose('Do something generic');
    const rootId = tree.rootId;

    const created = d.addSubtasks(tree, rootId, [
      { description: 'Step 1' },
      { description: 'Step 2', dependencies: ['0'] },
    ]);

    assert.strictEqual(created.length, 2);
    assert.strictEqual(tree.nodes.size, 3); // root + 2 children
    assert.ok(created[1].dependencies.includes(created[0].id));
  });

  it('addSubtasks throws at maxDepth', () => {
    const d = new GoalDecomposer(1);
    const tree = d.decompose('Fix the error in code');

    // Root is depth 0, children are depth 1 (at max)
    const root = tree.nodes.get(tree.rootId)!;
    const childId = root.subtasks[0];

    assert.throws(() => {
      d.addSubtasks(tree, childId, [{ description: 'Grandchild' }]);
    }, /max depth/);
  });

  it('summarize returns readable output', () => {
    const d = new GoalDecomposer();
    const tree = d.decompose('Fix the login error');
    const summary = d.summarize(tree);

    assert.ok(summary.includes('Fix the login error'));
    assert.ok(summary.includes('in_progress'));
    assert.ok(summary.includes('ready'));
  });

  it('serialize and deserialize round-trip', () => {
    const d = new GoalDecomposer();
    const tree = d.decompose('Add new feature to dashboard');
    d.complete(tree, d.getReady(tree)[0].id, 'Analyzed');

    const serialized = d.serialize(tree);
    const json = JSON.stringify(serialized);
    const parsed = JSON.parse(json);
    const restored = d.deserialize(parsed);

    assert.strictEqual(restored.rootId, tree.rootId);
    assert.strictEqual(restored.nodes.size, tree.nodes.size);
    assert.strictEqual(restored.originalGoal, tree.originalGoal);
  });

  it('preserves context through decomposition', () => {
    const d = new GoalDecomposer();
    const tree = d.decompose('Fix the crash in parser', ['src/parser.ts']);

    for (const node of tree.nodes.values()) {
      if (node.context) {
        assert.ok(node.context.includes('src/parser.ts'));
      }
    }
  });

  it('assigns tool hints to subtasks', () => {
    const d = new GoalDecomposer();
    const tree = d.decompose('Debug the authentication failure');

    let hasToolHint = false;
    for (const node of tree.nodes.values()) {
      if (node.toolHint) {
        hasToolHint = true;
        assert.strictEqual(typeof node.toolHint, 'string');
      }
    }
    assert.ok(hasToolHint, 'At least some nodes should have tool hints');
  });
});

describe('DecomposeGoalTool', () => {
  it('has correct metadata', () => {
    const tool = new DecomposeGoalTool();
    assert.strictEqual(tool.name, 'decompose_goal');
    assert.strictEqual(tool.permission, 'auto');
    assert.ok(tool.description.includes('decomposition'));
  });

  it('decompose action creates a tree', async () => {
    const tool = new DecomposeGoalTool();
    const result = await tool.execute({
      action: 'decompose',
      goal: 'Fix the login bug in auth.ts',
      context: ['src/auth.ts'],
    });

    assert.ok(result.includes('decomposed'));
    assert.ok(result.includes('ready'));
    assert.ok(tool.getActiveTree() !== null);
  });

  it('status action shows tree state', async () => {
    const tool = new DecomposeGoalTool();
    await tool.execute({ action: 'decompose', goal: 'Fix the crash' });
    const result = await tool.execute({ action: 'status' });
    assert.ok(result.includes('Fix the crash'));
  });

  it('next action returns ready task', async () => {
    const tool = new DecomposeGoalTool();
    await tool.execute({ action: 'decompose', goal: 'Fix the error in login' });
    const result = await tool.execute({ action: 'next' });
    assert.ok(result.includes('Next task'));
    assert.ok(result.includes('ID:'));
  });

  it('complete action marks task done', async () => {
    const tool = new DecomposeGoalTool();
    await tool.execute({ action: 'decompose', goal: 'Do something generic' });
    const tree = tool.getActiveTree()!;
    const rootId = tree.rootId;

    const result = await tool.execute({
      action: 'complete',
      goal_id: rootId,
      output: 'All done',
    });
    assert.ok(result.includes('Completed'));
    assert.ok(result.includes('FINISHED'));
  });

  it('fail action marks task failed', async () => {
    const tool = new DecomposeGoalTool();
    await tool.execute({ action: 'decompose', goal: 'Do something generic' });
    const tree = tool.getActiveTree()!;

    const result = await tool.execute({
      action: 'fail',
      goal_id: tree.rootId,
      error: 'Could not complete',
    });
    assert.ok(result.includes('Failed'));
    assert.ok(result.includes('Could not complete'));
  });

  it('add_subtasks action adds children', async () => {
    const tool = new DecomposeGoalTool();
    await tool.execute({ action: 'decompose', goal: 'Do something generic' });
    const tree = tool.getActiveTree()!;

    const result = await tool.execute({
      action: 'add_subtasks',
      goal_id: tree.rootId,
      subtasks: [
        { description: 'Sub A' },
        { description: 'Sub B', dependencies: ['0'] },
      ],
    });
    assert.ok(result.includes('Added 2 subtask'));
  });

  it('returns error for unknown action', async () => {
    const tool = new DecomposeGoalTool();
    const result = await tool.execute({ action: 'bogus' });
    assert.ok(result.includes('Unknown action'));
  });

  it('returns error when no tree exists', async () => {
    const tool = new DecomposeGoalTool();
    const result = await tool.execute({ action: 'status' });
    assert.ok(result.includes('No active goal tree'));
  });

  it('returns error for missing goal in decompose', async () => {
    const tool = new DecomposeGoalTool();
    const result = await tool.execute({ action: 'decompose' });
    assert.ok(result.includes('required'));
  });

  it('handles full lifecycle: decompose → next → complete → next → complete', async () => {
    const tool = new DecomposeGoalTool(1); // depth 1 for simpler tree
    await tool.execute({ action: 'decompose', goal: 'Research the codebase layout' });

    // Get first task
    let next = await tool.execute({ action: 'next' });
    assert.ok(next.includes('Next task'));

    // Extract ID from the "ID: goal_..." line
    const idMatch = next.match(/ID:\s+(goal_\S+)/);
    assert.ok(idMatch, 'Should find goal ID in next output');

    // Complete it
    await tool.execute({ action: 'complete', goal_id: idMatch![1], output: 'Found files' });

    // Get next
    next = await tool.execute({ action: 'next' });
    // Either there's another task or we're finished
    assert.ok(next.includes('Next task') || next.includes('FINISHED') || next.includes('ready'));
  });
});
