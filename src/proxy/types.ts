/**
 * Types for the CodeBot API proxy (Cloudflare Worker).
 *
 * License key validation, rate limiting, and proxy configuration.
 */

// ── License Key ──

export interface LicenseKey {
  /** The raw key string (e.g. "cb_live_abc123...") */
  key: string;
  /** Tier controls rate limits and feature access */
  tier: LicenseTier;
  /** ISO timestamp — keys can expire */
  expiresAt?: string;
  /** If true, key has been revoked */
  revoked?: boolean;
}

export type LicenseTier = 'free' | 'pro' | 'team' | 'enterprise';

export interface LicenseValidationResult {
  valid: boolean;
  tier?: LicenseTier;
  error?: string;
}

// ── Rate Limiting ──

export interface RateLimitConfig {
  /** Max requests per window */
  maxRequests: number;
  /** Window size in seconds */
  windowSeconds: number;
}

export interface RateLimitEntry {
  /** Number of requests in current window */
  count: number;
  /** Window start timestamp (epoch ms) */
  windowStart: number;
}

export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  resetAt: number;
  retryAfterSeconds?: number;
}

/** Per-tier rate limit defaults */
export const TIER_RATE_LIMITS: Record<LicenseTier, RateLimitConfig> = {
  free:       { maxRequests: 10,  windowSeconds: 60 },
  pro:        { maxRequests: 60,  windowSeconds: 60 },
  team:       { maxRequests: 120, windowSeconds: 60 },
  enterprise: { maxRequests: 300, windowSeconds: 60 },
};

// ── Proxy Config ──

export interface ProxyConfig {
  /** Claude API base URL */
  claudeApiUrl: string;
  /** Header name for the license key */
  licenseHeader: string;
  /** Anthropic API key (stored in Worker secret / env) */
  anthropicApiKey: string;
}

export const DEFAULT_PROXY_CONFIG: Omit<ProxyConfig, 'anthropicApiKey'> = {
  claudeApiUrl: 'https://api.anthropic.com',
  licenseHeader: 'x-codebot-license',
};

// ── Cloudflare Worker Env ──

export interface Env {
  /** Anthropic API key — set via `wrangler secret put ANTHROPIC_API_KEY` */
  ANTHROPIC_API_KEY: string;
  /** Optional: KV namespace for persistent rate limiting */
  RATE_LIMIT_KV?: KVNamespace;
}

/**
 * Minimal KV namespace interface so the code compiles without
 * Cloudflare's full types installed.
 */
export interface KVNamespace {
  get(key: string): Promise<string | null>;
  put(key: string, value: string, options?: { expirationTtl?: number }): Promise<void>;
  delete(key: string): Promise<void>;
}
