/**
 * CodeBot API Proxy — Cloudflare Worker
 *
 * Sits between the Electron app and Claude API:
 *  1. Validates the license key from x-codebot-license header
 *  2. Applies per-key rate limiting
 *  3. Forwards the request to api.anthropic.com with the real API key
 *  4. Streams the response back to the client
 *
 * Deploy: `wrangler deploy src/proxy/worker.ts`
 * Secret: `wrangler secret put ANTHROPIC_API_KEY`
 */

import { RateLimiter } from './rate-limiter';
import {
  Env,
  LicenseValidationResult,
  LicenseTier,
  DEFAULT_PROXY_CONFIG,
} from './types';

// ── License Validation ──

const LICENSE_PREFIX = 'cb_';
const MIN_KEY_LENGTH = 16;

/**
 * Validate a license key format and status.
 *
 * In production this would hit a KV store or D1 database to check
 * revocation and tier. For now we validate format and derive tier
 * from the key prefix.
 */
export function validateLicenseKey(key: string | null | undefined): LicenseValidationResult {
  if (!key) {
    return { valid: false, error: 'Missing license key' };
  }

  const trimmed = key.trim();
  if (trimmed.length < MIN_KEY_LENGTH) {
    return { valid: false, error: 'Invalid license key format' };
  }

  if (!trimmed.startsWith(LICENSE_PREFIX)) {
    return { valid: false, error: 'Invalid license key prefix' };
  }

  // Derive tier from key segment: cb_free_xxx, cb_pro_xxx, etc.
  const tier = parseTierFromKey(trimmed);
  return { valid: true, tier };
}

function parseTierFromKey(key: string): LicenseTier {
  const body = key.slice(LICENSE_PREFIX.length);
  if (body.startsWith('enterprise_')) return 'enterprise';
  if (body.startsWith('team_')) return 'team';
  if (body.startsWith('pro_')) return 'pro';
  return 'free';
}

// ── CORS helpers ──

const CORS_HEADERS: Record<string, string> = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, x-codebot-license, anthropic-version',
};

function corsResponse(status: number, body: Record<string, unknown>): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

// ── Request Handler ──

/** Singleton rate limiter — lives for the Worker isolate lifetime. */
let rateLimiter: RateLimiter | null = null;

function getRateLimiter(env: Env): RateLimiter {
  if (!rateLimiter) {
    rateLimiter = new RateLimiter(env.RATE_LIMIT_KV);
  }
  return rateLimiter;
}

/**
 * Main request handler. Exported for direct invocation in tests.
 */
export async function handleRequest(request: Request, env: Env): Promise<Response> {
  // CORS preflight
  if (request.method === 'OPTIONS') {
    return new Response(null, { status: 204, headers: CORS_HEADERS });
  }

  // Only POST allowed (Claude API is POST-only for messages)
  if (request.method !== 'POST') {
    return corsResponse(405, { error: 'Method not allowed' });
  }

  // ── 1. Validate license key ──
  const licenseKey = request.headers.get(DEFAULT_PROXY_CONFIG.licenseHeader);
  const validation = validateLicenseKey(licenseKey);
  if (!validation.valid) {
    return corsResponse(401, { error: validation.error ?? 'Unauthorized' });
  }

  const tier = validation.tier!;

  // ── 2. Rate limit ──
  const limiter = getRateLimiter(env);
  const rlResult = await limiter.check(licenseKey!, tier);

  if (!rlResult.allowed) {
    return corsResponse(429, {
      error: 'Rate limit exceeded',
      retryAfterSeconds: rlResult.retryAfterSeconds,
      resetAt: new Date(rlResult.resetAt).toISOString(),
    });
  }

  // ── 3. Forward to Claude API ──
  const url = new URL(request.url);
  const targetUrl = `${DEFAULT_PROXY_CONFIG.claudeApiUrl}${url.pathname}`;

  // Clone headers, swap auth
  const forwardHeaders = new Headers(request.headers);
  forwardHeaders.delete(DEFAULT_PROXY_CONFIG.licenseHeader);
  forwardHeaders.set('x-api-key', env.ANTHROPIC_API_KEY);
  // Ensure anthropic-version is set
  if (!forwardHeaders.has('anthropic-version')) {
    forwardHeaders.set('anthropic-version', '2023-06-01');
  }

  let upstreamResponse: Response;
  try {
    upstreamResponse = await fetch(targetUrl, {
      method: 'POST',
      headers: forwardHeaders,
      body: request.body,
    });
  } catch (err) {
    return corsResponse(502, {
      error: 'Failed to reach Claude API',
      detail: err instanceof Error ? err.message : 'Unknown error',
    });
  }

  // ── 4. Return upstream response with rate limit headers ──
  const responseHeaders = new Headers(upstreamResponse.headers);
  responseHeaders.set('x-ratelimit-remaining', String(rlResult.remaining));
  responseHeaders.set('x-ratelimit-reset', new Date(rlResult.resetAt).toISOString());
  // CORS
  for (const [k, v] of Object.entries(CORS_HEADERS)) {
    responseHeaders.set(k, v);
  }

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    headers: responseHeaders,
  });
}

// ── Cloudflare Worker Export ──

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    return handleRequest(request, env);
  },
};

// ── Test Helpers ──

/**
 * Reset the singleton rate limiter (for test isolation).
 */
export function _resetRateLimiter(): void {
  rateLimiter = null;
}
