import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { ExecutionAuditor, ToolExecution, AnomalyReport } from './execution-auditor';

function makeExec(opts: Partial<ToolExecution> = {}): ToolExecution {
  return {
    toolName: opts.toolName || 'test_tool',
    success: opts.success ?? true,
    durationMs: opts.durationMs ?? 100,
    errorMessage: opts.errorMessage,
    timestamp: opts.timestamp || new Date().toISOString(),
  };
}

describe('ExecutionAuditor', () => {
  it('records executions and returns them', () => {
    const auditor = new ExecutionAuditor();
    auditor.record(makeExec());
    auditor.record(makeExec());
    assert.strictEqual(auditor.getHistory().length, 2);
  });

  it('detects repeated failures', () => {
    const auditor = new ExecutionAuditor();
    for (let i = 0; i < 3; i++) {
      auditor.record(makeExec({ success: false, errorMessage: 'ECONNREFUSED' }));
    }
    const anomalies = auditor.detect();
    const failure = anomalies.find(a => a.type === 'repeated_failure');
    assert.ok(failure, 'Should detect repeated failure');
    assert.strictEqual(failure!.severity, 'critical');
    assert.ok(failure!.fixAction);
  });

  it('does not flag repeated failure below threshold', () => {
    const auditor = new ExecutionAuditor();
    auditor.record(makeExec({ success: false }));
    auditor.record(makeExec({ success: false }));
    // Only 2 failures, threshold is 3
    const anomalies = auditor.detect();
    const failure = anomalies.find(a => a.type === 'repeated_failure');
    assert.ok(!failure);
  });

  it('detects loop patterns', () => {
    const auditor = new ExecutionAuditor();
    for (let i = 0; i < 5; i++) {
      auditor.record(makeExec({ toolName: 'grep', success: true }));
    }
    const anomalies = auditor.detect();
    const loop = anomalies.find(a => a.type === 'loop_detected');
    assert.ok(loop, 'Should detect loop');
    assert.ok(loop!.fixAction);
  });

  it('does not flag loop with mixed tools', () => {
    const auditor = new ExecutionAuditor();
    auditor.record(makeExec({ toolName: 'grep' }));
    auditor.record(makeExec({ toolName: 'read_file' }));
    auditor.record(makeExec({ toolName: 'grep' }));
    auditor.record(makeExec({ toolName: 'edit_file' }));
    auditor.record(makeExec({ toolName: 'grep' }));
    const anomalies = auditor.detect();
    const loop = anomalies.find(a => a.type === 'loop_detected');
    assert.ok(!loop);
  });

  it('detects slow execution', () => {
    const auditor = new ExecutionAuditor();
    auditor.record(makeExec({ durationMs: 45_000 }));
    const anomalies = auditor.detect();
    const slow = anomalies.find(a => a.type === 'slow_execution');
    assert.ok(slow, 'Should detect slow execution');
    assert.strictEqual(slow!.severity, 'warning');
  });

  it('does not flag normal speed execution', () => {
    const auditor = new ExecutionAuditor();
    auditor.record(makeExec({ durationMs: 500 }));
    const anomalies = auditor.detect();
    const slow = anomalies.find(a => a.type === 'slow_execution');
    assert.ok(!slow);
  });

  it('detects error cascade across tools', () => {
    const auditor = new ExecutionAuditor();
    // Mix of failing tools
    for (let i = 0; i < 4; i++) {
      auditor.record(makeExec({
        toolName: i % 2 === 0 ? 'grep' : 'execute',
        success: false,
        errorMessage: 'failed',
      }));
    }
    // Add some successful calls to reach window of 10
    for (let i = 0; i < 6; i++) {
      auditor.record(makeExec({ success: true }));
    }
    // Re-record failures to be in the last 10
    const auditor2 = new ExecutionAuditor();
    for (let i = 0; i < 6; i++) {
      auditor2.record(makeExec({ success: true }));
    }
    for (let i = 0; i < 4; i++) {
      auditor2.record(makeExec({
        toolName: i % 2 === 0 ? 'grep' : 'execute',
        success: false,
        errorMessage: 'failed',
      }));
    }
    const anomalies = auditor2.detect();
    const cascade = anomalies.find(a => a.type === 'error_cascade');
    assert.ok(cascade, 'Should detect error cascade');
    assert.strictEqual(cascade!.severity, 'critical');
  });

  it('getToolStats returns correct stats', () => {
    const auditor = new ExecutionAuditor();
    auditor.record(makeExec({ toolName: 'grep', durationMs: 100 }));
    auditor.record(makeExec({ toolName: 'grep', durationMs: 200, success: false }));
    auditor.record(makeExec({ toolName: 'read_file', durationMs: 50 }));

    const grepStats = auditor.getToolStats('grep');
    assert.strictEqual(grepStats.total, 2);
    assert.strictEqual(grepStats.failures, 1);
    assert.strictEqual(grepStats.avgDurationMs, 150);

    const readStats = auditor.getToolStats('read_file');
    assert.strictEqual(readStats.total, 1);
    assert.strictEqual(readStats.failures, 0);
  });

  it('summarize returns formatted output', () => {
    const auditor = new ExecutionAuditor();
    auditor.record(makeExec({ toolName: 'grep' }));
    auditor.record(makeExec({ toolName: 'read_file' }));
    const summary = auditor.summarize();
    assert.ok(summary.includes('grep'));
    assert.ok(summary.includes('read_file'));
    assert.ok(summary.includes('calls'));
  });

  it('summarize handles empty history', () => {
    const auditor = new ExecutionAuditor();
    assert.ok(auditor.summarize().includes('No tool executions'));
  });

  it('reset clears history', () => {
    const auditor = new ExecutionAuditor();
    auditor.record(makeExec());
    auditor.record(makeExec());
    assert.strictEqual(auditor.getHistory().length, 2);
    auditor.reset();
    assert.strictEqual(auditor.getHistory().length, 0);
  });

  it('history stays bounded', () => {
    const auditor = new ExecutionAuditor();
    for (let i = 0; i < 250; i++) {
      auditor.record(makeExec());
    }
    assert.ok(auditor.getHistory().length <= 200);
  });

  it('record returns anomalies inline', () => {
    const auditor = new ExecutionAuditor();
    // Fill with failures to trigger anomaly
    for (let i = 0; i < 2; i++) {
      auditor.record(makeExec({ success: false }));
    }
    const anomalies = auditor.record(makeExec({ success: false }));
    assert.ok(Array.isArray(anomalies));
    assert.ok(anomalies.length > 0);
  });
});
