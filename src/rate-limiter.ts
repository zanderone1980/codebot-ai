/**
 * Per-tool Rate Limiter
 *
 * Simple sliding-window throttle that enforces minimum intervals between
 * calls to the same tool. Prevents hammering web services and self-DOS.
 *
 * @since v1.5.0
 */

export class RateLimiter {
  private lastCall = new Map<string, number>();

  /** Minimum interval (ms) between calls per tool */
  private limits: Record<string, number> = {
    browser: 200,
    web_fetch: 500,
    web_search: 1000,
    execute: 100,
  };

  constructor(overrides?: Record<string, number>) {
    if (overrides) {
      Object.assign(this.limits, overrides);
    }
  }

  /** Wait if needed to respect the tool's rate limit */
  async throttle(toolName: string): Promise<void> {
    const limit = this.limits[toolName];
    if (!limit) return; // no limit for this tool

    const last = this.lastCall.get(toolName) || 0;
    const elapsed = Date.now() - last;

    if (elapsed < limit) {
      await new Promise(resolve => setTimeout(resolve, limit - elapsed));
    }

    this.lastCall.set(toolName, Date.now());
  }

  /** Get the configured limit for a tool (0 = no limit) */
  getLimit(toolName: string): number {
    return this.limits[toolName] || 0;
  }

  /** Update a tool's rate limit at runtime */
  setLimit(toolName: string, intervalMs: number): void {
    this.limits[toolName] = intervalMs;
  }

  /** Reset all tracking (useful for tests) */
  reset(): void {
    this.lastCall.clear();
  }
}
