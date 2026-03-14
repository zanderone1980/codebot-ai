import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { Orchestrator, AgentTask, AgentResult, generateTaskId, OrchestratorConfig } from './orchestrator';
import { MetricsCollector } from './metrics';
import { PolicyEnforcer } from './policy';

function makeOrchestrator(config?: Partial<OrchestratorConfig>, depth = 0): Orchestrator {
  return new Orchestrator(new PolicyEnforcer(), new MetricsCollector('test'), config, depth);
}

function makeTask(desc = 'Test task'): AgentTask {
  return { id: generateTaskId(), description: desc, context: ['src/test.ts'] };
}

const successExecutor = async (task: AgentTask) => ({
  output: `Done: ${task.description}`,
  toolCalls: ['read_file', 'edit_file'],
  filesModified: ['src/test.ts'],
});

describe('Orchestrator — getActiveCount tracking', () => {
  it('returns 0 when no children are running', () => {
    const orch = makeOrchestrator();
    assert.strictEqual(orch.getActiveCount(), 0);
  });

  it('active count returns to 0 after delegate completes', async () => {
    const orch = makeOrchestrator();
    await orch.delegate(makeTask(), successExecutor);
    assert.strictEqual(orch.getActiveCount(), 0);
  });
});

describe('Orchestrator — formatResultsSummary edge cases', () => {
  it('truncates long output in summary', async () => {
    const orch = makeOrchestrator();
    const longExecutor = async () => ({
      output: 'x'.repeat(600),
      toolCalls: [],
      filesModified: [],
    });
    await orch.delegate(makeTask('Long output task'), longExecutor);
    const summary = orch.formatResultsSummary(orch.getResults());
    assert.ok(summary.includes('...'));
  });

  it('shows timeout icon for timed out tasks', async () => {
    const orch = makeOrchestrator({ childTimeoutMs: 50 });
    const slowExecutor = async () => {
      await new Promise(r => setTimeout(r, 5000));
      return { output: '', toolCalls: [], filesModified: [] };
    };
    await orch.delegate(makeTask('Slow task'), slowExecutor);
    const summary = orch.formatResultsSummary(orch.getResults());
    assert.ok(summary.includes('timeout'));
  });
});

describe('Orchestrator — generateTaskId uniqueness', () => {
  it('generates 100 unique IDs', () => {
    const ids = new Set<string>();
    for (let i = 0; i < 100; i++) {
      ids.add(generateTaskId());
    }
    assert.strictEqual(ids.size, 100);
  });

  it('IDs have correct prefix format', () => {
    const id = generateTaskId();
    assert.ok(id.startsWith('task_'));
    const parts = id.split('_');
    assert.strictEqual(parts.length, 3);
    assert.ok(!isNaN(Number(parts[1])));
  });
});


describe('Orchestrator — config immutability', () => {
  it('getConfig returns a copy that cannot mutate internal state', () => {
    const orch = makeOrchestrator({ maxConcurrent: 5 });
    const config = orch.getConfig();
    config.maxConcurrent = 999;
    assert.strictEqual(orch.getConfig().maxConcurrent, 5);
  });

  it('getResults returns a copy', async () => {
    const orch = makeOrchestrator();
    await orch.delegate(makeTask(), successExecutor);
    const results = orch.getResults();
    results.push({} as any);
    assert.strictEqual(orch.getResults().length, 1);
  });
});

describe('Orchestrator — delegateAll with empty tasks', () => {
  it('returns empty results for empty task list', async () => {
    const orch = makeOrchestrator();
    const results = await orch.delegateAll([], successExecutor);
    assert.strictEqual(results.length, 0);
  });

  it('handles single task through delegateAll', async () => {
    const orch = makeOrchestrator();
    const results = await orch.delegateAll([makeTask('Solo')], successExecutor);
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].status, 'success');
    assert.ok(results[0].output.includes('Solo'));
  });
});
