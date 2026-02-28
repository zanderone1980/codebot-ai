import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { RateLimiter } from './rate-limiter';

describe('RateLimiter', () => {
  it('does not throttle tools without limits', async () => {
    const limiter = new RateLimiter();
    const start = Date.now();
    await limiter.throttle('read_file'); // no limit configured
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 50, `Should not delay, took ${elapsed}ms`);
  });

  it('enforces minimum interval between calls', async () => {
    const limiter = new RateLimiter({ test_tool: 100 });

    await limiter.throttle('test_tool'); // first call — no wait
    const start = Date.now();
    await limiter.throttle('test_tool'); // second call — should wait ~100ms
    const elapsed = Date.now() - start;

    assert.ok(elapsed >= 80, `Should wait at least 80ms, waited ${elapsed}ms`);
  });

  it('does not throttle different tools against each other', async () => {
    const limiter = new RateLimiter({ tool_a: 200, tool_b: 200 });

    await limiter.throttle('tool_a');
    const start = Date.now();
    await limiter.throttle('tool_b'); // different tool — no wait
    const elapsed = Date.now() - start;

    assert.ok(elapsed < 50, `Different tools should not block each other, took ${elapsed}ms`);
  });

  it('has default limits for browser, web_fetch, web_search, execute', () => {
    const limiter = new RateLimiter();
    assert.strictEqual(limiter.getLimit('browser'), 200);
    assert.strictEqual(limiter.getLimit('web_fetch'), 500);
    assert.strictEqual(limiter.getLimit('web_search'), 1000);
    assert.strictEqual(limiter.getLimit('execute'), 100);
  });

  it('supports runtime limit updates', () => {
    const limiter = new RateLimiter();
    limiter.setLimit('custom_tool', 300);
    assert.strictEqual(limiter.getLimit('custom_tool'), 300);
  });

  it('reset clears tracking state', async () => {
    const limiter = new RateLimiter({ test_tool: 500 });
    await limiter.throttle('test_tool');

    limiter.reset();

    const start = Date.now();
    await limiter.throttle('test_tool'); // should not wait after reset
    const elapsed = Date.now() - start;
    assert.ok(elapsed < 50, `Should not wait after reset, took ${elapsed}ms`);
  });
});
