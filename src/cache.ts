/**
 * LRU Tool Result Cache with TTL
 *
 * Caches results from read-only tools (read_file, grep, glob, etc.)
 * to avoid redundant I/O. Invalidates on writes to affected paths.
 *
 * @since v1.5.0
 */

interface CacheEntry {
  value: string;
  expires: number;
  size: number;
}

export class ToolCache {
  private cache = new Map<string, CacheEntry>();
  private maxSize: number;
  private currentSize = 0;

  /** Default TTLs per tool (ms) */
  static readonly TTL: Record<string, number> = {
    read_file: 30_000,
    grep: 30_000,
    glob: 30_000,
    code_analysis: 60_000,
    code_review: 60_000,
    image_info: 60_000,
  };

  constructor(maxSizeBytes = 50 * 1024 * 1024) {
    this.maxSize = maxSizeBytes;
  }

  /** Build a deterministic cache key from tool name + sorted args */
  static key(toolName: string, args: Record<string, unknown>): string {
    const sorted = Object.keys(args)
      .sort()
      .map(k => `${k}=${JSON.stringify(args[k])}`)
      .join('&');
    return `${toolName}:${sorted}`;
  }

  /** Get a cached value, or null if expired/missing */
  get(key: string): string | null {
    const entry = this.cache.get(key);
    if (!entry) return null;

    if (Date.now() > entry.expires) {
      this.delete(key);
      return null;
    }

    // Move to end (most recently used) — Map preserves insertion order
    this.cache.delete(key);
    this.cache.set(key, entry);
    return entry.value;
  }

  /** Store a value with TTL */
  set(key: string, value: string, ttlMs: number): void {
    // Delete existing entry first (update size tracking)
    this.delete(key);

    const size = key.length + value.length;

    // Don't cache if single entry exceeds 10% of max
    if (size > this.maxSize * 0.1) return;

    // Evict LRU entries until we have room
    while (this.currentSize + size > this.maxSize && this.cache.size > 0) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.delete(oldest);
      }
    }

    this.cache.set(key, {
      value,
      expires: Date.now() + ttlMs,
      size,
    });
    this.currentSize += size;
  }

  /** Remove a specific key */
  private delete(key: string): void {
    const entry = this.cache.get(key);
    if (entry) {
      this.currentSize -= entry.size;
      this.cache.delete(key);
    }
  }

  /**
   * Invalidate all cache entries whose key contains the given substring.
   * Used when a file is written/edited — invalidate any cached reads for that path.
   */
  invalidate(pattern: string): void {
    for (const key of [...this.cache.keys()]) {
      if (key.includes(pattern)) {
        this.delete(key);
      }
    }
  }

  /** Clear entire cache */
  clear(): void {
    this.cache.clear();
    this.currentSize = 0;
  }

  /** Number of entries currently cached */
  get size(): number {
    return this.cache.size;
  }

  /** Total bytes currently cached */
  get bytes(): number {
    return this.currentSize;
  }
}
