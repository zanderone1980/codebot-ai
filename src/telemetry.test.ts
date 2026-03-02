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

describe('estimateRunCost', () => {
  // Import at top-level won't work since we're appending, so use dynamic import
  const { estimateRunCost } = require('./telemetry');

  it('returns a cost estimate for a simple task', () => {
    const est = estimateRunCost('fix the typo', 'gpt-4o', 'openai');
    assert.strictEqual(typeof est.estimatedCost, 'number');
    assert.ok(est.estimatedCost > 0, 'Cloud model cost should be positive');
    assert.strictEqual(est.confidence, 'high');
    assert.strictEqual(est.estimatedIterations, 3);
  });

  it('returns higher estimate for complex tasks', () => {
    const simple = estimateRunCost('fix typo', 'gpt-4o', 'openai');
    const complex = estimateRunCost(
      'refactor the entire authentication system to use JWT tokens instead of session cookies and update all middleware and add comprehensive tests for each endpoint including edge cases and error handling',
      'gpt-4o',
      'openai'
    );
    assert.ok(complex.estimatedCost > simple.estimatedCost, 'Complex should cost more');
    assert.ok(complex.estimatedIterations > simple.estimatedIterations);
    assert.ok(complex.estimatedToolCalls > simple.estimatedToolCalls);
  });

  it('returns medium confidence for medium tasks', () => {
    const est = estimateRunCost(
      'refactor the authentication module to use JSON Web Tokens instead of session cookies and then update the middleware layer to properly validate incoming tokens on every request',
      'gpt-4o',
      'openai'
    );
    assert.strictEqual(est.confidence, 'medium');
    assert.strictEqual(est.estimatedIterations, 8);
  });

  it('returns free for local models', () => {
    const est = estimateRunCost('fix the bug', 'llama3.2', 'ollama');
    assert.strictEqual(est.estimatedCost, 0);
  });

  it('returns free for lmstudio provider', () => {
    const est = estimateRunCost('write tests', 'qwen2.5-coder', 'lmstudio');
    assert.strictEqual(est.estimatedCost, 0);
  });

  it('handles unknown models with default pricing', () => {
    const est = estimateRunCost('do something', 'unknown-model-xyz', 'some-cloud');
    assert.ok(est.estimatedCost > 0, 'Unknown cloud model should still have a cost');
  });

  it('returns all required fields', () => {
    const est = estimateRunCost('build feature', 'gpt-4o', 'openai');
    assert.strictEqual(typeof est.estimatedInputTokens, 'number');
    assert.strictEqual(typeof est.estimatedOutputTokens, 'number');
    assert.strictEqual(typeof est.estimatedCost, 'number');
    assert.strictEqual(typeof est.estimatedToolCalls, 'number');
    assert.strictEqual(typeof est.estimatedIterations, 'number');
    assert.ok(['low', 'medium', 'high'].includes(est.confidence));
  });

  it('estimates different costs for different models', () => {
    const gpt4o = estimateRunCost('fix bug', 'gpt-4o', 'openai');
    const opus = estimateRunCost('fix bug', 'claude-opus-4-6', 'anthropic');
    // Both should have costs but they should differ
    assert.ok(gpt4o.estimatedCost > 0);
    assert.ok(opus.estimatedCost > 0);
    assert.notStrictEqual(gpt4o.estimatedCost, opus.estimatedCost);
  });
});
