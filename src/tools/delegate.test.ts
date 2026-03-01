import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DelegateTool } from './delegate';
import { Orchestrator } from '../orchestrator';
import { MetricsCollector } from '../metrics';
import { PolicyEnforcer } from '../policy';

describe('DelegateTool — metadata (v2.2.0-alpha)', () => {
  it('has correct name and description', () => {
    const tool = new DelegateTool();
    assert.strictEqual(tool.name, 'delegate');
    assert.ok(tool.description.includes('child agent'));
    assert.strictEqual(tool.permission, 'prompt');
  });

  it('has task and tasks parameters', () => {
    const tool = new DelegateTool();
    const props = tool.parameters.properties as Record<string, Record<string, unknown>>;
    assert.ok(props.task, 'should have task parameter');
    assert.ok(props.tasks, 'should have tasks parameter');
    assert.ok(props.files, 'should have files parameter');
  });
});

describe('DelegateTool — execute (v2.2.0-alpha)', () => {
  it('returns error when orchestrator not set', async () => {
    const tool = new DelegateTool();
    const result = await tool.execute({ task: 'Do something' });
    assert.ok(result.includes('Error'));
    assert.ok(result.includes('not enabled'));
  });

  it('executes single task', async () => {
    const tool = new DelegateTool();
    const orch = new Orchestrator(
      new PolicyEnforcer(),
      new MetricsCollector('test'),
    );
    tool.setOrchestrator(orch);

    const result = await tool.execute({
      task: 'Fix the bug in auth.ts',
      files: ['src/auth.ts'],
    });

    assert.ok(result.includes('✅'));
    assert.ok(result.includes('Fix the bug in auth.ts'));
    assert.ok(result.includes('success'));
  });

  it('executes batch tasks', async () => {
    const tool = new DelegateTool();
    const orch = new Orchestrator(
      new PolicyEnforcer(),
      new MetricsCollector('test'),
    );
    tool.setOrchestrator(orch);

    const result = await tool.execute({
      tasks: [
        { task: 'Fix file A', files: ['a.ts'] },
        { task: 'Fix file B', files: ['b.ts'] },
      ],
    });

    assert.ok(result.includes('Fix file A'));
    assert.ok(result.includes('Fix file B'));
    assert.ok(result.includes('2 tasks'));
  });

  it('returns error with no task or tasks', async () => {
    const tool = new DelegateTool();
    const orch = new Orchestrator(
      new PolicyEnforcer(),
      new MetricsCollector('test'),
    );
    tool.setOrchestrator(orch);

    const result = await tool.execute({});
    assert.ok(result.includes('Error'));
  });

  it('returns error with empty tasks array', async () => {
    const tool = new DelegateTool();
    const orch = new Orchestrator(
      new PolicyEnforcer(),
      new MetricsCollector('test'),
    );
    tool.setOrchestrator(orch);

    const result = await tool.execute({ tasks: [] });
    assert.ok(result.includes('Error'));
    assert.ok(result.includes('No tasks'));
  });
});
