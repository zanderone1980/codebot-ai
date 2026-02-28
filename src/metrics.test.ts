import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { MetricsCollector } from './metrics';

describe('MetricsCollector', () => {
  // ── Counters ──

  it('increments a counter with default delta', () => {
    const mc = new MetricsCollector('test-session');
    mc.increment('tool_calls_total');
    assert.strictEqual(mc.getCounter('tool_calls_total'), 1);
  });

  it('increments a counter with custom delta', () => {
    const mc = new MetricsCollector();
    mc.increment('errors_total', undefined, 5);
    assert.strictEqual(mc.getCounter('errors_total'), 5);
  });

  it('increments a counter multiple times', () => {
    const mc = new MetricsCollector();
    mc.increment('tool_calls_total');
    mc.increment('tool_calls_total');
    mc.increment('tool_calls_total');
    assert.strictEqual(mc.getCounter('tool_calls_total'), 3);
  });

  it('supports labeled counters', () => {
    const mc = new MetricsCollector();
    mc.increment('tool_calls_total', { tool: 'read_file' });
    mc.increment('tool_calls_total', { tool: 'write_file' });
    mc.increment('tool_calls_total', { tool: 'read_file' });

    assert.strictEqual(mc.getCounter('tool_calls_total', { tool: 'read_file' }), 2);
    assert.strictEqual(mc.getCounter('tool_calls_total', { tool: 'write_file' }), 1);
    assert.strictEqual(mc.getCounter('tool_calls_total', { tool: 'execute' }), 0);
  });

  it('sorts labels for consistent key encoding', () => {
    const mc = new MetricsCollector();
    mc.increment('test', { b: '2', a: '1' });
    // Same labels in different order should match
    assert.strictEqual(mc.getCounter('test', { a: '1', b: '2' }), 1);
  });

  it('returns 0 for unknown counter', () => {
    const mc = new MetricsCollector();
    assert.strictEqual(mc.getCounter('nonexistent'), 0);
  });

  // ── Histograms ──

  it('records a single histogram observation', () => {
    const mc = new MetricsCollector();
    mc.observe('tool_latency_seconds', 0.150);
    const h = mc.getHistogram('tool_latency_seconds');
    assert.ok(h);
    assert.strictEqual(h.count, 1);
    assert.strictEqual(h.sum, 0.150);
    assert.strictEqual(h.min, 0.150);
    assert.strictEqual(h.max, 0.150);
  });

  it('records multiple histogram observations', () => {
    const mc = new MetricsCollector();
    mc.observe('latency', 0.1);
    mc.observe('latency', 0.2);
    mc.observe('latency', 0.5);
    mc.observe('latency', 1.0);

    const h = mc.getHistogram('latency');
    assert.ok(h);
    assert.strictEqual(h.count, 4);
    assert.strictEqual(h.min, 0.1);
    assert.strictEqual(h.max, 1.0);
    assert.ok(Math.abs(h.sum - 1.8) < 0.001);
  });

  it('supports labeled histograms', () => {
    const mc = new MetricsCollector();
    mc.observe('tool_latency', 0.1, { tool: 'read_file' });
    mc.observe('tool_latency', 0.5, { tool: 'execute' });
    mc.observe('tool_latency', 0.2, { tool: 'read_file' });

    const readH = mc.getHistogram('tool_latency', { tool: 'read_file' });
    assert.ok(readH);
    assert.strictEqual(readH.count, 2);

    const execH = mc.getHistogram('tool_latency', { tool: 'execute' });
    assert.ok(execH);
    assert.strictEqual(execH.count, 1);
  });

  it('returns null for unknown histogram', () => {
    const mc = new MetricsCollector();
    assert.strictEqual(mc.getHistogram('nonexistent'), null);
  });

  // ── Snapshot ──

  it('produces a valid snapshot', () => {
    const mc = new MetricsCollector('snap-test');
    mc.increment('requests', undefined, 10);
    mc.observe('latency', 0.5);

    const snap = mc.snapshot();
    assert.strictEqual(snap.sessionId, 'snap-test');
    assert.ok(snap.timestamp);
    assert.strictEqual(snap.counters.length, 1);
    assert.strictEqual(snap.counters[0].name, 'requests');
    assert.strictEqual(snap.counters[0].value, 10);
    assert.strictEqual(snap.histograms.length, 1);
    assert.strictEqual(snap.histograms[0].name, 'latency');
    assert.strictEqual(snap.histograms[0].count, 1);
  });

  it('snapshot includes labels', () => {
    const mc = new MetricsCollector();
    mc.increment('calls', { tool: 'read_file' }, 3);
    const snap = mc.snapshot();
    assert.strictEqual(snap.counters[0].labels.tool, 'read_file');
  });

  // ── Format Summary ──

  it('formatSummary returns a readable string', () => {
    const mc = new MetricsCollector();
    mc.increment('tool_calls_total', { tool: 'read_file' }, 5);
    mc.observe('tool_latency_seconds', 0.1, { tool: 'read_file' });
    mc.observe('tool_latency_seconds', 0.3, { tool: 'read_file' });

    const summary = mc.formatSummary();
    assert.ok(summary.includes('Metrics Summary'));
    assert.ok(summary.includes('tool_calls_total'));
    assert.ok(summary.includes('read_file'));
    assert.ok(summary.includes('tool_latency_seconds'));
    assert.ok(summary.includes('count=2'));
  });

  it('formatSummary handles empty metrics', () => {
    const mc = new MetricsCollector();
    const summary = mc.formatSummary();
    assert.ok(summary.includes('no metrics recorded'));
  });

  // ── Session ID ──

  it('generates a session ID if not provided', () => {
    const mc = new MetricsCollector();
    assert.ok(mc.getSessionId().length > 0);
  });

  it('uses provided session ID', () => {
    const mc = new MetricsCollector('my-session');
    assert.strictEqual(mc.getSessionId(), 'my-session');
  });

  // ── OTLP Export ──

  it('exportOtel does not throw when no endpoint set', () => {
    const mc = new MetricsCollector();
    mc.increment('test_counter');
    // Should not throw even without OTEL_EXPORTER_OTLP_ENDPOINT
    assert.doesNotThrow(() => mc.exportOtel());
  });

  it('exportOtel does not throw with invalid endpoint', () => {
    const original = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
    process.env.OTEL_EXPORTER_OTLP_ENDPOINT = 'http://invalid-host:99999';
    try {
      const mc = new MetricsCollector();
      mc.increment('test_counter');
      assert.doesNotThrow(() => mc.exportOtel());
    } finally {
      if (original === undefined) {
        delete process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      } else {
        process.env.OTEL_EXPORTER_OTLP_ENDPOINT = original;
      }
    }
  });

  // ── Edge Cases ──

  it('handles many observations without crashing', () => {
    const mc = new MetricsCollector();
    for (let i = 0; i < 2000; i++) {
      mc.observe('stress_test', Math.random());
    }
    const h = mc.getHistogram('stress_test');
    assert.ok(h);
    assert.strictEqual(h.count, 2000);
    // Buckets capped at MAX_BUCKETS (1000)
    assert.ok(h.buckets.length <= 1000);
  });

  it('handles concurrent counter increments', () => {
    const mc = new MetricsCollector();
    for (let i = 0; i < 100; i++) {
      mc.increment('concurrent', { worker: String(i % 4) });
    }
    let total = 0;
    for (let w = 0; w < 4; w++) {
      total += mc.getCounter('concurrent', { worker: String(w) });
    }
    assert.strictEqual(total, 100);
  });
});
