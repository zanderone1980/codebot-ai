/**
 * Offline Fallback Cache — TTL-based file cache for web tool results.
 * Stores cached responses at ~/.codebot/cache/ with SHA-256 key hashing.
 * Zero external dependencies.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { codebotPath } from './paths';

const CACHE_DIR = codebotPath('cache');
const DEFAULT_TTL_MS = 24 * 60 * 60 * 1000; // 24 hours

interface CacheEntry {
  value: string;
  expiresAt: number;
  createdAt: number;
  key: string;
}

function hashKey(key: string): string {
  return crypto.createHash('sha256').update(key).digest('hex');
}

function cachePath(key: string): string {
  return path.join(CACHE_DIR, hashKey(key) + '.json');
}

function ensureCacheDir(): void {
  if (!fs.existsSync(CACHE_DIR)) {
    fs.mkdirSync(CACHE_DIR, { recursive: true });
  }
}

/** Get a cached value. Returns null if missing or expired. */
export function cacheGet(key: string): string | null {
  try {
    const filePath = cachePath(key);
    if (!fs.existsSync(filePath)) return null;
    const entry: CacheEntry = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
    if (Date.now() > entry.expiresAt) {
      // Expired — clean up
      try { fs.unlinkSync(filePath); } catch { /* best-effort */ }
      return null;
    }
    return entry.value;
  } catch {
    return null;
  }
}

/** Store a value in the cache with optional TTL (default 24h). */
export function cacheSet(key: string, value: string, ttlMs: number = DEFAULT_TTL_MS): void {
  try {
    ensureCacheDir();
    const entry: CacheEntry = {
      value,
      expiresAt: Date.now() + ttlMs,
      createdAt: Date.now(),
      key,
    };
    fs.writeFileSync(cachePath(key), JSON.stringify(entry));
  } catch { /* best-effort — caching should never break the tool */ }
}

/** Check if a key exists and is not expired */
export function cacheHas(key: string): boolean {
  return cacheGet(key) !== null;
}

/** Clear all cached entries */
export function cacheClear(): number {
  let cleared = 0;
  try {
    if (!fs.existsSync(CACHE_DIR)) return 0;
    const files = fs.readdirSync(CACHE_DIR);
    for (const file of files) {
      if (file.endsWith('.json')) {
        try { fs.unlinkSync(path.join(CACHE_DIR, file)); cleared++; } catch { /* skip */ }
      }
    }
  } catch { /* best-effort */ }
  return cleared;
}

/** Purge expired entries only */
export function cachePurgeExpired(): number {
  let purged = 0;
  try {
    if (!fs.existsSync(CACHE_DIR)) return 0;
    const now = Date.now();
    const files = fs.readdirSync(CACHE_DIR);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const entry: CacheEntry = JSON.parse(fs.readFileSync(path.join(CACHE_DIR, file), 'utf-8'));
        if (now > entry.expiresAt) {
          fs.unlinkSync(path.join(CACHE_DIR, file));
          purged++;
        }
      } catch { /* corrupt entry — remove it */ try { fs.unlinkSync(path.join(CACHE_DIR, file)); purged++; } catch {} }
    }
  } catch { /* best-effort */ }
  return purged;
}

/** Get cache stats */
export function cacheStats(): { entries: number; totalBytes: number; oldestMs: number } {
  let entries = 0, totalBytes = 0, oldestMs = Date.now();
  try {
    if (!fs.existsSync(CACHE_DIR)) return { entries: 0, totalBytes: 0, oldestMs: 0 };
    const files = fs.readdirSync(CACHE_DIR);
    for (const file of files) {
      if (!file.endsWith('.json')) continue;
      try {
        const full = path.join(CACHE_DIR, file);
        const stat = fs.statSync(full);
        entries++;
        totalBytes += stat.size;
        if (stat.mtimeMs < oldestMs) oldestMs = stat.mtimeMs;
      } catch { /* skip */ }
    }
  } catch { /* best-effort */ }
  return { entries, totalBytes, oldestMs: entries > 0 ? oldestMs : 0 };
}
