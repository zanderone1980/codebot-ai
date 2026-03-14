import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';
import { cacheGet, cacheSet, cacheHas, cacheClear, cachePurgeExpired, cacheStats } from './offline-cache';

describe('Offline Cache', () => {
  beforeEach(() => {
    cacheClear();
  });

  it('returns null for missing keys', () => {
    assert.strictEqual(cacheGet('nonexistent'), null);
  });

  it('stores and retrieves values', () => {
    cacheSet('test-key', 'test-value');
    assert.strictEqual(cacheGet('test-key'), 'test-value');
  });

  it('cacheHas returns true for existing keys', () => {
    cacheSet('exists', 'yes');
    assert.ok(cacheHas('exists'));
    assert.ok(!cacheHas('nope'));
  });

  it('respects TTL expiration', () => {
    cacheSet('short-lived', 'bye', 1); // 1ms TTL
    // Wait a tiny bit
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    assert.strictEqual(cacheGet('short-lived'), null);
  });

  it('cacheClear removes all entries', () => {
    cacheSet('a', '1');
    cacheSet('b', '2');
    const cleared = cacheClear();
    assert.ok(cleared >= 2);
    assert.strictEqual(cacheGet('a'), null);
    assert.strictEqual(cacheGet('b'), null);
  });

  it('cachePurgeExpired only removes expired entries', () => {
    cacheSet('fresh', 'keep-me', 60000);
    cacheSet('stale', 'remove-me', 1);
    const start = Date.now();
    while (Date.now() - start < 5) { /* spin */ }
    const purged = cachePurgeExpired();
    assert.ok(purged >= 1);
    assert.strictEqual(cacheGet('fresh'), 'keep-me');
  });

  it('cacheStats returns entry count and size', () => {
    cacheSet('stat-test', 'some data here');
    const stats = cacheStats();
    assert.ok(stats.entries >= 1);
    assert.ok(stats.totalBytes > 0);
  });

  it('handles unicode and special characters', () => {
    const value = 'こんにちは世界 🌍 <script>alert(1)</script>';
    cacheSet('unicode', value);
    assert.strictEqual(cacheGet('unicode'), value);
  });

  it('handles large values', () => {
    const big = 'x'.repeat(100000);
    cacheSet('big', big);
    assert.strictEqual(cacheGet('big'), big);
  });
});
