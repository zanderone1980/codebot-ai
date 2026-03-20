/**
 * In-memory rate limiter with optional KV store backend.
 *
 * Designed for Cloudflare Workers: uses in-memory Map for single-isolate
 * speed and can optionally persist to KV for cross-isolate consistency.
 */

import {
  KVNamespace,
  RateLimitConfig,
  RateLimitEntry,
  RateLimitResult,
  TIER_RATE_LIMITS,
  LicenseTier,
} from './types';

export class RateLimiter {
  private store = new Map<string, RateLimitEntry>();
  private kv?: KVNamespace;

  constructor(kv?: KVNamespace) {
    this.kv = kv;
  }

  /**
   * Check and consume one request for the given key.
   * Returns whether the request is allowed plus remaining quota.
   */
  async check(
    key: string,
    tier: LicenseTier,
    now: number = Date.now(),
  ): Promise<RateLimitResult> {
    const config = TIER_RATE_LIMITS[tier];
    return this.checkWithConfig(key, config, now);
  }

  /**
   * Core rate limit logic with explicit config (useful for testing).
   */
  async checkWithConfig(
    key: string,
    config: RateLimitConfig,
    now: number = Date.now(),
  ): Promise<RateLimitResult> {
    const windowMs = config.windowSeconds * 1000;
    let entry = await this.getEntry(key);

    // Start a new window if none exists or the current one expired
    if (!entry || now - entry.windowStart >= windowMs) {
      entry = { count: 1, windowStart: now };
      await this.setEntry(key, entry, config.windowSeconds);
      return {
        allowed: true,
        remaining: config.maxRequests - 1,
        resetAt: now + windowMs,
      };
    }

    // Within current window — check limit
    if (entry.count >= config.maxRequests) {
      const resetAt = entry.windowStart + windowMs;
      return {
        allowed: false,
        remaining: 0,
        resetAt,
        retryAfterSeconds: Math.ceil((resetAt - now) / 1000),
      };
    }

    // Allowed — increment
    entry.count++;
    await this.setEntry(key, entry, config.windowSeconds);
    return {
      allowed: true,
      remaining: config.maxRequests - entry.count,
      resetAt: entry.windowStart + windowMs,
    };
  }

  /** Reset a specific key (useful for testing or admin). */
  async reset(key: string): Promise<void> {
    this.store.delete(key);
    if (this.kv) {
      await this.kv.delete(key);
    }
  }

  /** Clear all in-memory entries. */
  clear(): void {
    this.store.clear();
  }

  // ── Storage layer ──

  private async getEntry(key: string): Promise<RateLimitEntry | null> {
    // In-memory first (fast path)
    const mem = this.store.get(key);
    if (mem) return mem;

    // Fall back to KV if available
    if (this.kv) {
      const raw = await this.kv.get(`rl:${key}`);
      if (raw) {
        try {
          const entry = JSON.parse(raw) as RateLimitEntry;
          this.store.set(key, entry); // warm the cache
          return entry;
        } catch {
          return null;
        }
      }
    }

    return null;
  }

  private async setEntry(
    key: string,
    entry: RateLimitEntry,
    ttlSeconds: number,
  ): Promise<void> {
    this.store.set(key, entry);

    if (this.kv) {
      await this.kv.put(`rl:${key}`, JSON.stringify(entry), {
        expirationTtl: ttlSeconds,
      });
    }
  }
}
