/**
 * CodeBot AI — Provider-Aware Rate Limiting (v2.3.0)
 *
 * Proactive rate limiting with sliding windows for RPM and TPM.
 * Tracks concurrent requests and adapts on 429 responses.
 *
 * ZERO external dependencies.
 */

export interface ProviderRateConfig {
  provider: string;
  requestsPerMinute: number;
  tokensPerMinute: number;
  concurrentRequests: number;
}

export const PROVIDER_RATE_DEFAULTS: Record<string, ProviderRateConfig> = {
  anthropic: { provider: 'anthropic', requestsPerMinute: 50, tokensPerMinute: 100_000, concurrentRequests: 5 },
  openai:    { provider: 'openai',    requestsPerMinute: 60, tokensPerMinute: 150_000, concurrentRequests: 10 },
  gemini:    { provider: 'gemini',    requestsPerMinute: 60, tokensPerMinute: 1_000_000, concurrentRequests: 10 },
  deepseek:  { provider: 'deepseek',  requestsPerMinute: 30, tokensPerMinute: 60_000,  concurrentRequests: 3 },
  groq:      { provider: 'groq',      requestsPerMinute: 30, tokensPerMinute: 50_000,  concurrentRequests: 3 },
  mistral:   { provider: 'mistral',   requestsPerMinute: 30, tokensPerMinute: 100_000, concurrentRequests: 5 },
  xai:       { provider: 'xai',       requestsPerMinute: 60, tokensPerMinute: 100_000, concurrentRequests: 5 },
  local:     { provider: 'local',     requestsPerMinute: 999, tokensPerMinute: 999_999, concurrentRequests: 1 },
  ollama:    { provider: 'ollama',    requestsPerMinute: 999, tokensPerMinute: 999_999, concurrentRequests: 1 },
  lmstudio:  { provider: 'lmstudio',  requestsPerMinute: 999, tokensPerMinute: 999_999, concurrentRequests: 1 },
  vllm:      { provider: 'vllm',      requestsPerMinute: 999, tokensPerMinute: 999_999, concurrentRequests: 1 },
};

const WINDOW_MS = 60_000; // 1 minute sliding window

export class ProviderRateLimiter {
  private timestamps: number[] = [];
  private tokenEntries: Array<{ ts: number; tokens: number }> = [];
  private activeRequests: number = 0;
  private config: ProviderRateConfig;
  private originalConfig: ProviderRateConfig;
  private waiters: Array<() => void> = [];

  constructor(provider: string, overrides?: Partial<ProviderRateConfig>) {
    const defaults = PROVIDER_RATE_DEFAULTS[provider] || PROVIDER_RATE_DEFAULTS.local;
    this.config = { ...defaults, ...overrides };
    this.originalConfig = { ...this.config };
  }

  /** Wait until a request is allowed. Returns wait time in ms (0 = no wait). */
  async acquire(estimatedTokens?: number): Promise<number> {
    this.pruneWindow();

    let totalWait = 0;

    // Check RPM
    if (this.timestamps.length >= this.config.requestsPerMinute) {
      const oldest = this.timestamps[0];
      const waitMs = oldest + WINDOW_MS - Date.now();
      if (waitMs > 0) {
        totalWait = Math.max(totalWait, waitMs);
      }
    }

    // Check TPM
    if (estimatedTokens) {
      const currentTokens = this.tokenEntries.reduce((sum, e) => sum + e.tokens, 0);
      if (currentTokens + estimatedTokens > this.config.tokensPerMinute) {
        const oldest = this.tokenEntries[0];
        if (oldest) {
          const waitMs = oldest.ts + WINDOW_MS - Date.now();
          if (waitMs > 0) {
            totalWait = Math.max(totalWait, waitMs);
          }
        }
      }
    }

    // Check concurrent limit — use promise-based queue instead of busy-wait
    if (this.activeRequests >= this.config.concurrentRequests) {
      const waitStart = Date.now();
      await this.waitForSlot();
      totalWait += Date.now() - waitStart;
    }

    // Wait if needed
    if (totalWait > 0) {
      await this.sleep(totalWait);
    }

    // Record request
    this.timestamps.push(Date.now());
    this.activeRequests++;

    return totalWait;
  }

  /** Wait for a concurrent slot to open (promise-based, no polling) */
  private waitForSlot(): Promise<void> {
    return new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  /** Release a concurrent request slot. */
  release(): void {
    this.activeRequests = Math.max(0, this.activeRequests - 1);
    // Wake next waiter if any
    if (this.waiters.length > 0) {
      const next = this.waiters.shift()!;
      next();
    }
  }

  /** Record actual tokens consumed (for TPM tracking). */
  recordTokens(tokens: number): void {
    this.tokenEntries.push({ ts: Date.now(), tokens });
  }

  /** Get current utilization as percentages. */
  getUtilization(): { rpmPercent: number; tpmPercent: number; concurrentPercent: number } {
    this.pruneWindow();
    const currentTokens = this.tokenEntries.reduce((sum, e) => sum + e.tokens, 0);
    return {
      rpmPercent: Math.round((this.timestamps.length / this.config.requestsPerMinute) * 100),
      tpmPercent: Math.round((currentTokens / this.config.tokensPerMinute) * 100),
      concurrentPercent: Math.round((this.activeRequests / this.config.concurrentRequests) * 100),
    };
  }

  /** Adapt limits on 429 response. Reduces RPM by 50%. */
  backoff(): void {
    this.config.requestsPerMinute = Math.max(1, Math.floor(this.config.requestsPerMinute / 2));
  }

  /** Restore original limits after successful requests. */
  recover(): void {
    this.config = { ...this.originalConfig };
  }

  /** Update config at runtime. */
  updateLimits(overrides: Partial<ProviderRateConfig>): void {
    Object.assign(this.config, overrides);
  }

  /** Get current config */
  getConfig(): ProviderRateConfig {
    return { ...this.config };
  }

  /** Remove entries older than the window. */
  private pruneWindow(): void {
    const cutoff = Date.now() - WINDOW_MS;
    this.timestamps = this.timestamps.filter(ts => ts > cutoff);
    this.tokenEntries = this.tokenEntries.filter(e => e.ts > cutoff);
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
