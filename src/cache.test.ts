import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { ToolCache } from './cache';

describe('ToolCache', () => {
  it('stores and retrieves cached values', () => {
    const cache = new ToolCache();
    cache.set('test:key', 'hello world', 5000);
    assert.strictEqual(cache.get('test:key'), 'hello world');
  });

  it('returns null for missing keys', () => {
    const cache = new ToolCache();
    assert.strictEqual(cache.get('nonexistent'), null);
  });

  it('expires entries after TTL', async () => {
    const cache = new ToolCache();
    cache.set('test:key', 'value', 50); // 50ms TTL
    assert.strictEqual(cache.get('test:key'), 'value');

    await new Promise(r => setTimeout(r, 80));
    assert.strictEqual(cache.get('test:key'), null);
  });

  it('invalidates entries matching pattern', () => {
    const cache = new ToolCache();
    cache.set('read_file:path="/src/foo.ts"', 'content1', 5000);
    cache.set('read_file:path="/src/bar.ts"', 'content2', 5000);
    cache.set('grep:pattern="test"', 'results', 5000);

    cache.invalidate('/src/foo.ts');

    assert.strictEqual(cache.get('read_file:path="/src/foo.ts"'), null);
    assert.strictEqual(cache.get('read_file:path="/src/bar.ts"'), 'content2');
    assert.strictEqual(cache.get('grep:pattern="test"'), 'results');
  });

  it('evicts LRU entries when size limit exceeded', () => {
    // 1000 byte cache — each entry key(2) + value(80) = ~82 bytes, fits under 10% of 1000
    const cache = new ToolCache(1000);
    // Fill up the cache well past capacity
    for (let i = 0; i < 15; i++) {
      cache.set(`k${i}`, 'x'.repeat(80), 5000);
    }
    // Oldest entries should have been evicted
    assert.strictEqual(cache.get('k0'), null, 'Oldest entry should be evicted');
    assert.strictEqual(cache.get('k1'), null, 'Second oldest should also be evicted');
    // Most recent entries should still exist
    assert.ok(cache.get('k14') !== null, 'Most recent entry should exist');
    assert.ok(cache.size < 15, `Should have fewer than 15 entries, has ${cache.size}`);
  });

  it('skips caching entries larger than 10% of max', () => {
    const cache = new ToolCache(100);
    cache.set('big', 'x'.repeat(50), 5000); // 50 bytes > 10% of 100
    assert.strictEqual(cache.get('big'), null);
    assert.strictEqual(cache.size, 0);
  });

  it('clears all entries', () => {
    const cache = new ToolCache();
    cache.set('k1', 'v1', 5000);
    cache.set('k2', 'v2', 5000);
    assert.strictEqual(cache.size, 2);

    cache.clear();
    assert.strictEqual(cache.size, 0);
    assert.strictEqual(cache.bytes, 0);
  });

  it('generates deterministic cache keys', () => {
    const key1 = ToolCache.key('read_file', { path: '/foo.ts', limit: 100 });
    const key2 = ToolCache.key('read_file', { limit: 100, path: '/foo.ts' });
    assert.strictEqual(key1, key2, 'Keys should be the same regardless of arg order');
  });

  it('has correct default TTLs defined', () => {
    assert.strictEqual(ToolCache.TTL.read_file, 30_000);
    assert.strictEqual(ToolCache.TTL.grep, 30_000);
    assert.strictEqual(ToolCache.TTL.glob, 30_000);
    assert.strictEqual(ToolCache.TTL.code_analysis, 60_000);
    assert.strictEqual(ToolCache.TTL.code_review, 60_000);
    assert.strictEqual(ToolCache.TTL.image_info, 60_000);
  });
});
