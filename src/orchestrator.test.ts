import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { Orchestrator, AgentTask, AgentResult, generateTaskId, OrchestratorConfig } from './orchestrator';
import { MetricsCollector } from './metrics';
import { PolicyEnforcer } from './policy';

function makeOrchestrator(config?: Partial<OrchestratorConfig>, depth = 0): Orchestrator {
  const policy = new PolicyEnforcer();
  const metrics = new MetricsCollector('test-session');
  return new Orchestrator(policy, metrics, config, depth);
}

function makeTask(desc = 'Test task'): AgentTask {
  return {
    id: generateTaskId(),
    description: desc,
    context: ['src/test.ts'],
  };
}

const successExecutor = async (task: AgentTask) => ({
  output: `Done: ${task.description}`,
  toolCalls: ['read_file', 'edit_file'],
  filesModified: ['src/test.ts'],
});

const errorExecutor = async () => {
  throw new Error('Child agent failed');
};

const slowExecutor = async () => {
  await new Promise(r => setTimeout(r, 5000));
  return { output: 'Done', toolCalls: [], filesModified: [] };
};

describe('Orchestrator — canSpawn (v2.2.0-alpha)', () => {
  it('allows spawning at depth 0', () => {
    const orch = makeOrchestrator({}, 0);
    assert.deepStrictEqual(orch.canSpawn(), { allowed: true });
  });

  it('blocks spawning at depth 1 (no grandchildren)', () => {
    const orch = makeOrchestrator({}, 1);
    const check = orch.canSpawn();
    assert.strictEqual(check.allowed, false);
    assert.ok(check.reason?.includes('depth'));
  });

  it('blocks when max concurrent reached', () => {
    const orch = makeOrchestrator({ maxConcurrent: 1 });
    // Start a long-running task
    const task = makeTask();
    orch.delegate(task, slowExecutor); // don't await — it's running

    const check = orch.canSpawn();
    assert.strictEqual(check.allowed, false);
    assert.ok(check.reason?.includes('concurrent'));
  });

  it('blocks when max child agents reached', () => {
    const orch = makeOrchestrator({ maxChildAgents: 1 });
    // Complete one task first
    return orch.delegate(makeTask(), successExecutor).then(() => {
      const check = orch.canSpawn();
      assert.strictEqual(check.allowed, false);
      assert.ok(check.reason?.includes('child agents per turn'));
    });
  });
});

describe('Orchestrator — delegate (v2.2.0-alpha)', () => {
  it('executes a task successfully', async () => {
    const orch = makeOrchestrator();
    const task = makeTask('Read and edit test.ts');
    const result = await orch.delegate(task, successExecutor);

    assert.strictEqual(result.taskId, task.id);
    assert.strictEqual(result.status, 'success');
    assert.ok(result.output.includes('Done'));
    assert.deepStrictEqual(result.toolCalls, ['read_file', 'edit_file']);
    assert.deepStrictEqual(result.filesModified, ['src/test.ts']);
    assert.ok(result.durationMs >= 0);
    assert.strictEqual(result.error, undefined);
  });

  it('handles executor errors gracefully', async () => {
    const orch = makeOrchestrator();
    const result = await orch.delegate(makeTask(), errorExecutor);

    assert.strictEqual(result.status, 'error');
    assert.ok(result.error?.includes('failed'));
    assert.strictEqual(result.output, '');
  });

  it('times out long-running tasks', async () => {
    const orch = makeOrchestrator({ childTimeoutMs: 100 });
    const result = await orch.delegate(makeTask(), slowExecutor);

    assert.strictEqual(result.status, 'timeout');
    assert.ok(result.error?.includes('timed out'));
  });

  it('returns error when canSpawn fails', async () => {
    const orch = makeOrchestrator({}, 1); // depth 1 — no spawning
    const result = await orch.delegate(makeTask(), successExecutor);

    assert.strictEqual(result.status, 'error');
    assert.ok(result.error?.includes('depth'));
  });

  it('tracks results', async () => {
    const orch = makeOrchestrator();
    await orch.delegate(makeTask('Task 1'), successExecutor);
    await orch.delegate(makeTask('Task 2'), successExecutor);

    const results = orch.getResults();
    assert.strictEqual(results.length, 2);
    assert.strictEqual(results[0].description, 'Task 1');
    assert.strictEqual(results[1].description, 'Task 2');
  });
});

describe('Orchestrator — delegateAll (v2.2.0-alpha)', () => {
  it('executes multiple tasks in parallel', async () => {
    const orch = makeOrchestrator({ maxConcurrent: 3 });
    const tasks = [makeTask('Task A'), makeTask('Task B'), makeTask('Task C')];

    const results = await orch.delegateAll(tasks, successExecutor);

    assert.strictEqual(results.length, 3);
    for (const r of results) {
      assert.strictEqual(r.status, 'success');
    }
  });

  it('batches tasks when exceeding maxConcurrent', async () => {
    const orch = makeOrchestrator({ maxConcurrent: 2, maxChildAgents: 10 });
    const tasks = [
      makeTask('Task 1'), makeTask('Task 2'),
      makeTask('Task 3'), makeTask('Task 4'),
    ];

    const results = await orch.delegateAll(tasks, successExecutor);

    assert.strictEqual(results.length, 4);
    for (const r of results) {
      assert.strictEqual(r.status, 'success');
    }
  });

  it('handles mixed success and error', async () => {
    const orch = makeOrchestrator({ maxConcurrent: 3, maxChildAgents: 10 });
    let callCount = 0;
    const mixedExecutor = async (task: AgentTask) => {
      callCount++;
      if (callCount === 2) throw new Error('Second task failed');
      return { output: 'Done', toolCalls: [], filesModified: [] };
    };

    const tasks = [makeTask('A'), makeTask('B'), makeTask('C')];
    const results = await orch.delegateAll(tasks, mixedExecutor);

    assert.strictEqual(results.length, 3);
    assert.strictEqual(results[0].status, 'success');
    assert.strictEqual(results[1].status, 'error');
    assert.strictEqual(results[2].status, 'success');
  });
});

describe('Orchestrator — formatResultsSummary', () => {
  it('formats successful results', async () => {
    const orch = makeOrchestrator();
    await orch.delegate(makeTask('Fix auth'), successExecutor);
    const summary = orch.formatResultsSummary(orch.getResults());

    assert.ok(summary.includes('Fix auth'));
    assert.ok(summary.includes('success'));
    assert.ok(summary.includes('read_file'));
  });

  it('formats empty results', () => {
    const orch = makeOrchestrator();
    const summary = orch.formatResultsSummary([]);
    assert.ok(summary.includes('No child agent results'));
  });

  it('includes error details', async () => {
    const orch = makeOrchestrator();
    await orch.delegate(makeTask('Bad task'), errorExecutor);
    const summary = orch.formatResultsSummary(orch.getResults());

    assert.ok(summary.includes('failed'));
    assert.ok(summary.includes('❌'));
  });
});

describe('Orchestrator — metrics tracking', () => {
  it('tracks spawned and completed agents', async () => {
    const metrics = new MetricsCollector('test');
    const orch = new Orchestrator(new PolicyEnforcer(), metrics);

    await orch.delegate(makeTask(), successExecutor);
    await orch.delegate(makeTask(), errorExecutor);

    assert.strictEqual(metrics.getCounter('child_agents_spawned_total'), 2);
    assert.strictEqual(metrics.getCounter('child_agents_completed_total', { status: 'success' }), 1);
    assert.strictEqual(metrics.getCounter('child_agents_completed_total', { status: 'error' }), 1);
  });

  it('records child agent duration', async () => {
    const metrics = new MetricsCollector('test');
    const orch = new Orchestrator(new PolicyEnforcer(), metrics);

    await orch.delegate(makeTask(), successExecutor);

    const hist = metrics.getHistogram('child_agent_duration_seconds', { status: 'success' });
    assert.ok(hist, 'should have duration histogram');
    assert.strictEqual(hist!.count, 1);
    assert.ok(hist!.sum >= 0);
  });
});

describe('Orchestrator — generateTaskId', () => {
  it('generates unique IDs', () => {
    const id1 = generateTaskId();
    const id2 = generateTaskId();
    assert.notStrictEqual(id1, id2);
    assert.ok(id1.startsWith('task_'));
    assert.ok(id2.startsWith('task_'));
  });
});

describe('Orchestrator — config defaults', () => {
  it('uses default config when none provided', () => {
    const orch = makeOrchestrator();
    const config = orch.getConfig();
    assert.strictEqual(config.maxConcurrent, 3);
    assert.strictEqual(config.maxChildAgents, 5);
    assert.strictEqual(config.defaultMaxIterations, 20);
    assert.strictEqual(config.childTimeoutMs, 120000);
  });

  it('merges partial config with defaults', () => {
    const orch = makeOrchestrator({ maxConcurrent: 10 });
    const config = orch.getConfig();
    assert.strictEqual(config.maxConcurrent, 10);
    assert.strictEqual(config.maxChildAgents, 5); // default
  });
});
