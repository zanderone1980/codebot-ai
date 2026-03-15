import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { Orchestrator, OrchestratorConfig, AgentTask } from './orchestrator';

describe('Orchestrator', () => {
  function makeOrchestrator(overrides?: Partial<OrchestratorConfig>, depth = 0) {
    const policy = { checkToolCall: () => ({ allowed: true }), isToolAllowed: () => true } as any;
    const metrics = { recordEvent: () => {}, getMetrics: () => ({}) } as any;
    return new Orchestrator(policy, metrics, overrides, depth);
  }

  it('creates with default config', () => {
    const orch = makeOrchestrator();
    assert.ok(orch);
  });

  it('creates with custom config', () => {
    const orch = makeOrchestrator({ maxConcurrent: 5, maxChildAgents: 10 });
    assert.ok(orch);
  });

  it('getResults returns empty array initially', () => {
    const orch = makeOrchestrator();
    assert.deepStrictEqual(orch.getResults(), []);
  });

  it('getActiveCount returns 0 initially', () => {
    const orch = makeOrchestrator();
    assert.strictEqual(orch.getActiveCount(), 0);
  });

  it('canSpawn rejects at max depth', () => {
    const orch = makeOrchestrator({ maxDepth: 2 }, 2);
    const result = orch.canSpawn();
    assert.strictEqual(result.allowed, false);
    assert.ok(result.reason?.includes('depth'));
  });

  it('canSpawn allows at depth 0', () => {
    const orch = makeOrchestrator({}, 0);
    const result = orch.canSpawn();
    assert.strictEqual(result.allowed, true);
  });

  it('respects maxConcurrent setting', () => {
    const orch = makeOrchestrator({ maxConcurrent: 2 });
    const result = orch.canSpawn();
    assert.strictEqual(result.allowed, true);
  });

  it('config merges with defaults', () => {
    const orch = makeOrchestrator({ maxConcurrent: 7 });
    assert.ok(orch);
  });
});
