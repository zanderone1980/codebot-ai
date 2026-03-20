import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';

import { RateLimiter } from './rate-limiter';
import { validateLicenseKey, handleRequest, _resetRateLimiter } from './worker';
import { RateLimitConfig, Env, KVNamespace } from './types';

// ── License Validation Tests ──

describe('validateLicenseKey', () => {
  it('rejects null/undefined/empty', () => {
    assert.strictEqual(validateLicenseKey(null).valid, false);
    assert.strictEqual(validateLicenseKey(undefined).valid, false);
    assert.strictEqual(validateLicenseKey('').valid, false);
  });

  it('rejects keys shorter than minimum length', () => {
    const result = validateLicenseKey('cb_short');
    assert.strictEqual(result.valid, false);
    assert.ok(result.error?.includes('format'));
  });

  it('rejects keys without cb_ prefix', () => {
    const result = validateLicenseKey('xx_free_abcdefghijklmnop');
    assert.strictEqual(result.valid, false);
    assert.ok(result.error?.includes('prefix'));
  });

  it('accepts valid free-tier key', () => {
    const result = validateLicenseKey('cb_free_abcdefghijklmnop');
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.tier, 'free');
  });

  it('accepts valid pro-tier key', () => {
    const result = validateLicenseKey('cb_pro_abcdefghijklmnop');
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.tier, 'pro');
  });

  it('accepts valid team-tier key', () => {
    const result = validateLicenseKey('cb_team_abcdefghijklmnop');
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.tier, 'team');
  });

  it('accepts valid enterprise-tier key', () => {
    const result = validateLicenseKey('cb_enterprise_abcdefghijklmnop');
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.tier, 'enterprise');
  });

  it('defaults unknown tier segment to free', () => {
    const result = validateLicenseKey('cb_unknown_abcdefghijklmnop');
    assert.strictEqual(result.valid, true);
    assert.strictEqual(result.tier, 'free');
  });
});

// ── Rate Limiter Tests ──

describe('RateLimiter', () => {
  let limiter: RateLimiter;
  const config: RateLimitConfig = { maxRequests: 3, windowSeconds: 60 };
  const NOW = 1_700_000_000_000;

  beforeEach(() => {
    limiter = new RateLimiter();
  });

  it('allows requests under the limit', async () => {
    const r1 = await limiter.checkWithConfig('key1', config, NOW);
    assert.strictEqual(r1.allowed, true);
    assert.strictEqual(r1.remaining, 2);
  });

  it('tracks count across calls', async () => {
    await limiter.checkWithConfig('key1', config, NOW);
    const r2 = await limiter.checkWithConfig('key1', config, NOW + 1000);
    assert.strictEqual(r2.allowed, true);
    assert.strictEqual(r2.remaining, 1);
  });

  it('blocks when limit is reached', async () => {
    await limiter.checkWithConfig('key1', config, NOW);
    await limiter.checkWithConfig('key1', config, NOW + 1000);
    await limiter.checkWithConfig('key1', config, NOW + 2000);
    const r4 = await limiter.checkWithConfig('key1', config, NOW + 3000);
    assert.strictEqual(r4.allowed, false);
    assert.strictEqual(r4.remaining, 0);
    assert.ok(r4.retryAfterSeconds! > 0);
  });

  it('resets after window expires', async () => {
    // Fill the window
    await limiter.checkWithConfig('key1', config, NOW);
    await limiter.checkWithConfig('key1', config, NOW + 1000);
    await limiter.checkWithConfig('key1', config, NOW + 2000);

    // Jump past the 60s window
    const r = await limiter.checkWithConfig('key1', config, NOW + 61_000);
    assert.strictEqual(r.allowed, true);
    assert.strictEqual(r.remaining, 2); // fresh window
  });

  it('isolates different keys', async () => {
    await limiter.checkWithConfig('key1', config, NOW);
    await limiter.checkWithConfig('key1', config, NOW + 1000);
    await limiter.checkWithConfig('key1', config, NOW + 2000);

    const other = await limiter.checkWithConfig('key2', config, NOW + 3000);
    assert.strictEqual(other.allowed, true);
    assert.strictEqual(other.remaining, 2);
  });

  it('reset() clears a specific key', async () => {
    await limiter.checkWithConfig('key1', config, NOW);
    await limiter.checkWithConfig('key1', config, NOW + 1000);
    await limiter.reset('key1');

    const r = await limiter.checkWithConfig('key1', config, NOW + 2000);
    assert.strictEqual(r.allowed, true);
    assert.strictEqual(r.remaining, 2);
  });

  it('uses tier-based limits via check()', async () => {
    // Free tier = 10 req/min
    for (let i = 0; i < 10; i++) {
      const r = await limiter.check('freekey', 'free', NOW + i * 100);
      assert.strictEqual(r.allowed, true);
    }
    const blocked = await limiter.check('freekey', 'free', NOW + 10_000);
    assert.strictEqual(blocked.allowed, false);
  });

  it('works with a KV backend', async () => {
    const kvStore = new Map<string, { value: string; ttl?: number }>();
    const mockKV: KVNamespace = {
      async get(key: string) {
        return kvStore.get(key)?.value ?? null;
      },
      async put(key: string, value: string, options?: { expirationTtl?: number }) {
        kvStore.set(key, { value, ttl: options?.expirationTtl });
      },
      async delete(key: string) {
        kvStore.delete(key);
      },
    };

    const kvLimiter = new RateLimiter(mockKV);
    const r1 = await kvLimiter.checkWithConfig('kvkey', config, NOW);
    assert.strictEqual(r1.allowed, true);

    // Verify it persisted to KV
    const raw = kvStore.get('rl:kvkey');
    assert.ok(raw, 'Entry should be in KV');
    const parsed = JSON.parse(raw!.value);
    assert.strictEqual(parsed.count, 1);
  });
});

// ── Worker Handler Tests ──

describe('handleRequest', () => {
  const VALID_KEY = 'cb_free_abcdefghijklmnop';
  const env: Env = { ANTHROPIC_API_KEY: 'sk-ant-test-key-123' };

  // Store the original global fetch so we can restore it
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    _resetRateLimiter();
    // Restore fetch in case a test replaced it
    globalThis.fetch = originalFetch;
  });

  function makeRequest(
    method: string,
    headers: Record<string, string> = {},
    body?: string,
  ): Request {
    return new Request('https://proxy.codebot.dev/v1/messages', {
      method,
      headers: { 'Content-Type': 'application/json', ...headers },
      body: method === 'POST' ? (body ?? '{"model":"claude-sonnet-4-20250514"}') : undefined,
    });
  }

  it('handles OPTIONS preflight', async () => {
    const req = makeRequest('OPTIONS');
    const res = await handleRequest(req, env);
    assert.strictEqual(res.status, 204);
    assert.ok(res.headers.get('Access-Control-Allow-Origin'));
  });

  it('rejects non-POST methods', async () => {
    const req = new Request('https://proxy.codebot.dev/v1/messages', { method: 'GET' });
    const res = await handleRequest(req, env);
    assert.strictEqual(res.status, 405);
  });

  it('rejects missing license key', async () => {
    const req = makeRequest('POST');
    const res = await handleRequest(req, env);
    assert.strictEqual(res.status, 401);
    const body = await res.json() as { error: string };
    assert.ok(body.error.includes('Missing'));
  });

  it('rejects invalid license key', async () => {
    const req = makeRequest('POST', { 'x-codebot-license': 'bad' });
    const res = await handleRequest(req, env);
    assert.strictEqual(res.status, 401);
  });

  it('enforces rate limits', async () => {
    // Burn through 10 free-tier requests
    for (let i = 0; i < 10; i++) {
      _resetRateLimiter(); // Each gets its own limiter... actually we need to NOT reset
    }
    _resetRateLimiter(); // Reset once, then send 11 requests

    // Mock fetch to avoid real HTTP
    globalThis.fetch = async () => new Response('{"ok":true}', { status: 200 });

    for (let i = 0; i < 10; i++) {
      const req = makeRequest('POST', { 'x-codebot-license': VALID_KEY });
      const res = await handleRequest(req, env);
      assert.strictEqual(res.status, 200, `Request ${i + 1} should succeed`);
    }

    // 11th request should be rate limited
    const req = makeRequest('POST', { 'x-codebot-license': VALID_KEY });
    const res = await handleRequest(req, env);
    assert.strictEqual(res.status, 429);
    const body = await res.json() as { error: string; retryAfterSeconds: number };
    assert.ok(body.retryAfterSeconds > 0);

    globalThis.fetch = originalFetch;
  });

  it('forwards to Claude API with correct headers', async () => {
    let capturedUrl = '';
    let capturedHeaders: Headers | null = null;

    globalThis.fetch = async (input: string | URL | Request, init?: RequestInit) => {
      capturedUrl = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
      capturedHeaders = new Headers(init?.headers as Record<string, string>);
      return new Response('{"id":"msg_123"}', {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    };

    const req = makeRequest('POST', {
      'x-codebot-license': VALID_KEY,
      'anthropic-version': '2023-06-01',
    });
    const res = await handleRequest(req, env);

    assert.strictEqual(res.status, 200);
    assert.ok(capturedUrl.includes('api.anthropic.com/v1/messages'));
    assert.strictEqual(capturedHeaders!.get('x-api-key'), 'sk-ant-test-key-123');
    // License key should be stripped from forwarded request
    assert.strictEqual(capturedHeaders!.get('x-codebot-license'), null);

    globalThis.fetch = originalFetch;
  });

  it('returns 502 when upstream fetch fails', async () => {
    globalThis.fetch = async () => {
      throw new Error('Network timeout');
    };

    const req = makeRequest('POST', { 'x-codebot-license': VALID_KEY });
    const res = await handleRequest(req, env);
    assert.strictEqual(res.status, 502);
    const body = await res.json() as { error: string; detail: string };
    assert.ok(body.detail.includes('timeout'));

    globalThis.fetch = originalFetch;
  });

  it('includes rate limit headers in response', async () => {
    globalThis.fetch = async () => new Response('{}', { status: 200 });

    const req = makeRequest('POST', { 'x-codebot-license': VALID_KEY });
    const res = await handleRequest(req, env);
    assert.ok(res.headers.get('x-ratelimit-remaining'));
    assert.ok(res.headers.get('x-ratelimit-reset'));

    globalThis.fetch = originalFetch;
  });

  it('sets default anthropic-version if missing', async () => {
    let capturedHeaders: Headers | null = null;

    globalThis.fetch = async (_input: string | URL | Request, init?: RequestInit) => {
      capturedHeaders = new Headers(init?.headers as Record<string, string>);
      return new Response('{}', { status: 200 });
    };

    const req = makeRequest('POST', { 'x-codebot-license': VALID_KEY });
    const res = await handleRequest(req, env);
    assert.strictEqual(res.status, 200);
    assert.strictEqual(capturedHeaders!.get('anthropic-version'), '2023-06-01');

    globalThis.fetch = originalFetch;
  });
});
