import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { TokenTracker } from './telemetry';

describe('TokenTracker', () => {
  it('records usage and calculates cost', () => {
    const tracker = new TokenTracker('gpt-4o', 'openai');
    const record = tracker.recordUsage(1000, 500);
    assert.strictEqual(record.inputTokens, 1000);
    assert.strictEqual(record.outputTokens, 500);
    assert.ok(record.costUsd > 0, 'Cost should be positive for cloud models');
  });

  it('aggregates total tokens', () => {
    const tracker = new TokenTracker('gpt-4o', 'openai');
    tracker.recordUsage(1000, 500);
    tracker.recordUsage(2000, 1000);
    assert.strictEqual(tracker.getTotalInputTokens(), 3000);
    assert.strictEqual(tracker.getTotalOutputTokens(), 1500);
  });

  it('tracks request count', () => {
    const tracker = new TokenTracker('gpt-4o', 'openai');
    tracker.recordUsage(100, 50);
    tracker.recordUsage(100, 50);
    tracker.recordUsage(100, 50);
    assert.strictEqual(tracker.getRequestCount(), 3);
  });

  it('reports free for local models', () => {
    const tracker = new TokenTracker('llama3.2', 'ollama');
    tracker.recordUsage(10000, 5000);
    assert.strictEqual(tracker.getTotalCost(), 0);
    assert.strictEqual(tracker.formatCost(), 'free (local model)');
  });

  it('enforces cost limit', () => {
    const tracker = new TokenTracker('gpt-4o', 'openai');
    tracker.setCostLimit(0.001); // Very low limit
    tracker.recordUsage(10000, 5000); // Should exceed limit
    assert.strictEqual(tracker.isOverBudget(), true);
  });

  it('not over budget when no limit set', () => {
    const tracker = new TokenTracker('gpt-4o', 'openai');
    tracker.recordUsage(1000000, 500000);
    assert.strictEqual(tracker.isOverBudget(), false);
  });

  it('generates correct summary', () => {
    const tracker = new TokenTracker('gpt-4o', 'openai', 'test-session');
    tracker.recordUsage(1000, 500);
    tracker.recordToolCall();
    tracker.recordToolCall();
    tracker.recordFileModified('/src/index.ts');
    tracker.recordFileModified('/src/app.ts');
    tracker.recordFileModified('/src/index.ts'); // duplicate

    const summary = tracker.getSummary();
    assert.strictEqual(summary.sessionId, 'test-session');
    assert.strictEqual(summary.model, 'gpt-4o');
    assert.strictEqual(summary.totalInputTokens, 1000);
    assert.strictEqual(summary.totalOutputTokens, 500);
    assert.strictEqual(summary.requestCount, 1);
    assert.strictEqual(summary.toolCalls, 2);
    assert.strictEqual(summary.filesModified, 2); // deduped
  });

  it('formatStatusLine returns a string', () => {
    const tracker = new TokenTracker('gpt-4o', 'openai');
    tracker.recordUsage(1000, 500);
    const status = tracker.formatStatusLine();
    assert.strictEqual(typeof status, 'string');
    assert.ok(status.includes('1,000'), `Should format input tokens: ${status}`);
  });

  it('formatUsageReport returns message for empty history', () => {
    const report = TokenTracker.formatUsageReport(30);
    assert.strictEqual(typeof report, 'string');
  });
});
