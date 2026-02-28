/**
 * Retry utilities for resilient network operations.
 * Exponential backoff with jitter, Retry-After header support.
 * Zero dependencies.
 */

export interface RetryOptions {
  maxRetries?: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  retryableStatuses?: number[];
}

const DEFAULTS: Required<RetryOptions> = {
  maxRetries: 3,
  baseDelayMs: 1000,
  maxDelayMs: 30000,
  retryableStatuses: [429, 500, 502, 503, 504],
};

/** Returns true if the error/status is retryable (network error or retryable HTTP status). */
export function isRetryable(error: unknown, status?: number, opts?: RetryOptions): boolean {
  const statuses = opts?.retryableStatuses ?? DEFAULTS.retryableStatuses;
  if (status && statuses.includes(status)) return true;
  if (error instanceof TypeError) return true; // fetch network errors
  if (error instanceof Error) {
    const msg = error.message.toLowerCase();
    if (msg.includes('fetch failed') || msg.includes('econnreset') ||
        msg.includes('econnrefused') || msg.includes('etimedout') ||
        msg.includes('socket hang up') || msg.includes('network') ||
        msg.includes('abort')) {
      return true;
    }
  }
  return false;
}

/**
 * Calculate delay with exponential backoff + jitter.
 * For 429 responses, respects Retry-After header.
 */
export function getRetryDelay(attempt: number, retryAfterHeader?: string | null, opts?: RetryOptions): number {
  const base = opts?.baseDelayMs ?? DEFAULTS.baseDelayMs;
  const max = opts?.maxDelayMs ?? DEFAULTS.maxDelayMs;

  // Respect Retry-After header (in seconds)
  if (retryAfterHeader) {
    const seconds = parseInt(retryAfterHeader, 10);
    if (!isNaN(seconds) && seconds > 0) {
      return Math.min(seconds * 1000, max);
    }
  }

  // Exponential backoff with jitter: base * 2^attempt * (0.5..1.5)
  const exponential = base * Math.pow(2, attempt);
  const jitter = 0.5 + Math.random();
  return Math.min(exponential * jitter, max);
}

export function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

/**
 * Returns true if the error message indicates a fatal/permanent failure
 * that will never succeed on retry (missing API key, auth failure, billing, etc.).
 */
export function isFatalError(errorMsg: string): boolean {
  const lower = errorMsg.toLowerCase();
  return (
    lower.includes('api key') ||
    lower.includes('api_key') ||
    lower.includes('apikey') ||
    lower.includes('authentication') ||
    lower.includes('unauthorized') ||
    lower.includes('invalid_request_error') ||
    lower.includes('invalid request') ||
    lower.includes('permission denied') ||
    lower.includes('account deactivated') ||
    lower.includes('account suspended') ||
    lower.includes('billing') ||
    (lower.includes('quota') && lower.includes('exceeded')) ||
    lower.includes('insufficient_quota') ||
    lower.includes('model not found') ||
    lower.includes('does not exist') ||
    lower.includes('access denied')
  );
}

export { DEFAULTS as RETRY_DEFAULTS };
