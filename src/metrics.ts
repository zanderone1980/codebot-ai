/**
 * MetricsCollector for CodeBot v1.9.0
 *
 * Structured telemetry: counters + histograms.
 * Persists to ~/.codebot/telemetry/metrics-YYYY-MM-DD.jsonl
 * Optional OTLP HTTP export when OTEL_EXPORTER_OTLP_ENDPOINT is set.
 *
 * Pattern: fail-safe, session-scoped, never throws.
 * Follows TokenTracker conventions from src/telemetry.ts.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';
import * as https from 'https';

// ── Types ──

export interface CounterValue {
  name: string;
  labels: Record<string, string>;
  value: number;
}

export interface HistogramValue {
  name: string;
  labels: Record<string, string>;
  count: number;
  sum: number;
  min: number;
  max: number;
  buckets: number[]; // observation values for percentile calculation
}

export interface MetricsSnapshot {
  sessionId: string;
  timestamp: string;
  counters: CounterValue[];
  histograms: HistogramValue[];
}

// ── Helpers ──

/** Encode a metric key: name|label1=val1|label2=val2 (sorted labels) */
function encodeKey(name: string, labels?: Record<string, string>): string {
  if (!labels || Object.keys(labels).length === 0) return name;
  const sorted = Object.entries(labels)
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('|');
  return `${name}|${sorted}`;
}

/** Decode a metric key back to name + labels */
function decodeKey(key: string): { name: string; labels: Record<string, string> } {
  const parts = key.split('|');
  const name = parts[0];
  const labels: Record<string, string> = {};
  for (let i = 1; i < parts.length; i++) {
    const eq = parts[i].indexOf('=');
    if (eq > 0) {
      labels[parts[i].substring(0, eq)] = parts[i].substring(eq + 1);
    }
  }
  return { name, labels };
}

/** Compute percentile from sorted array */
function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.ceil((p / 100) * sorted.length) - 1;
  return sorted[Math.max(0, idx)];
}

// ── Collector ──

const MAX_BUCKETS = 1000; // cap stored observations to prevent memory bloat

export class MetricsCollector {
  private sessionId: string;
  private counters: Map<string, number> = new Map();
  private histograms: Map<string, { count: number; sum: number; min: number; max: number; buckets: number[] }> = new Map();

  constructor(sessionId?: string) {
    this.sessionId = sessionId || `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
  }

  getSessionId(): string {
    return this.sessionId;
  }

  /** Increment a counter by delta (default 1) */
  increment(name: string, labels?: Record<string, string>, delta: number = 1): void {
    const key = encodeKey(name, labels);
    this.counters.set(key, (this.counters.get(key) || 0) + delta);
  }

  /** Record a histogram observation */
  observe(name: string, value: number, labels?: Record<string, string>): void {
    const key = encodeKey(name, labels);
    const existing = this.histograms.get(key);
    if (existing) {
      existing.count++;
      existing.sum += value;
      existing.min = Math.min(existing.min, value);
      existing.max = Math.max(existing.max, value);
      if (existing.buckets.length < MAX_BUCKETS) {
        existing.buckets.push(value);
      }
    } else {
      this.histograms.set(key, {
        count: 1,
        sum: value,
        min: value,
        max: value,
        buckets: [value],
      });
    }
  }

  /** Read a counter value */
  getCounter(name: string, labels?: Record<string, string>): number {
    return this.counters.get(encodeKey(name, labels)) || 0;
  }

  /** Read a histogram summary */
  getHistogram(name: string, labels?: Record<string, string>): HistogramValue | null {
    const key = encodeKey(name, labels);
    const h = this.histograms.get(key);
    if (!h) return null;
    const { name: n, labels: l } = decodeKey(key);
    return { name: n, labels: l, ...h };
  }

  /** Full session snapshot */
  snapshot(): MetricsSnapshot {
    const counters: CounterValue[] = [];
    for (const [key, value] of this.counters) {
      const { name, labels } = decodeKey(key);
      counters.push({ name, labels, value });
    }

    const histograms: HistogramValue[] = [];
    for (const [key, h] of this.histograms) {
      const { name, labels } = decodeKey(key);
      histograms.push({ name, labels, ...h });
    }

    return {
      sessionId: this.sessionId,
      timestamp: new Date().toISOString(),
      counters,
      histograms,
    };
  }

  /** Persist snapshot to ~/.codebot/telemetry/metrics-YYYY-MM-DD.jsonl */
  save(sessionId?: string): void {
    try {
      const telemetryDir = path.join(os.homedir(), '.codebot', 'telemetry');
      fs.mkdirSync(telemetryDir, { recursive: true });

      const snap = this.snapshot();
      if (sessionId) snap.sessionId = sessionId;

      const date = new Date().toISOString().split('T')[0];
      const filePath = path.join(telemetryDir, `metrics-${date}.jsonl`);
      fs.appendFileSync(filePath, JSON.stringify(snap) + '\n', 'utf-8');
    } catch {
      // Telemetry failures are non-fatal
    }
  }

  /** Human-readable per-tool breakdown */
  formatSummary(): string {
    const lines: string[] = ['Metrics Summary', '─'.repeat(50)];

    // Counters
    const counterEntries = Array.from(this.counters.entries())
      .sort(([a], [b]) => a.localeCompare(b));

    if (counterEntries.length > 0) {
      lines.push('Counters:');
      for (const [key, value] of counterEntries) {
        const { name, labels } = decodeKey(key);
        const labelStr = Object.keys(labels).length > 0
          ? ` {${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(', ')}}`
          : '';
        lines.push(`  ${name}${labelStr}: ${value}`);
      }
    }

    // Histograms — per-tool breakdown
    const histEntries = Array.from(this.histograms.entries())
      .sort(([a], [b]) => a.localeCompare(b));

    if (histEntries.length > 0) {
      lines.push('Histograms:');
      for (const [key, h] of histEntries) {
        const { name, labels } = decodeKey(key);
        const labelStr = Object.keys(labels).length > 0
          ? ` {${Object.entries(labels).map(([k, v]) => `${k}="${v}"`).join(', ')}}`
          : '';
        const sorted = [...h.buckets].sort((a, b) => a - b);
        const avg = h.count > 0 ? (h.sum / h.count).toFixed(3) : '0';
        const p50 = percentile(sorted, 50).toFixed(3);
        const p95 = percentile(sorted, 95).toFixed(3);
        const p99 = percentile(sorted, 99).toFixed(3);
        lines.push(`  ${name}${labelStr}: count=${h.count} avg=${avg} p50=${p50} p95=${p95} p99=${p99} min=${h.min.toFixed(3)} max=${h.max.toFixed(3)}`);
      }
    }

    if (counterEntries.length === 0 && histEntries.length === 0) {
      lines.push('  (no metrics recorded)');
    }

    return lines.join('\n');
  }

  /**
   * Export snapshot in OTLP JSON format via HTTP POST.
   * Only fires when OTEL_EXPORTER_OTLP_ENDPOINT is set.
   * Fails silently — never blocks or crashes.
   */
  exportOtel(snap?: MetricsSnapshot): void {
    try {
      const endpoint = process.env.OTEL_EXPORTER_OTLP_ENDPOINT;
      if (!endpoint) return;

      const data = snap || this.snapshot();
      const payload = this.buildOtlpPayload(data);
      const url = new URL('/v1/metrics', endpoint);
      const body = JSON.stringify(payload);

      const mod = url.protocol === 'https:' ? https : http;
      const req = mod.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(body),
        },
        timeout: 5000,
      });

      req.on('error', () => { /* silent */ });
      req.on('timeout', () => req.destroy());
      req.write(body);
      req.end();
    } catch {
      // OTLP export failures are non-fatal
    }
  }

  /** Build OTLP-compatible JSON payload */
  private buildOtlpPayload(snap: MetricsSnapshot): Record<string, unknown> {
    const metrics: Record<string, unknown>[] = [];

    for (const counter of snap.counters) {
      metrics.push({
        name: counter.name,
        sum: {
          dataPoints: [{
            asInt: counter.value,
            attributes: Object.entries(counter.labels).map(([k, v]) => ({
              key: k, value: { stringValue: v },
            })),
            timeUnixNano: Date.now() * 1_000_000,
          }],
          isMonotonic: true,
          aggregationTemporality: 2, // CUMULATIVE
        },
      });
    }

    for (const hist of snap.histograms) {
      metrics.push({
        name: hist.name,
        histogram: {
          dataPoints: [{
            count: hist.count,
            sum: hist.sum,
            min: hist.min,
            max: hist.max,
            attributes: Object.entries(hist.labels).map(([k, v]) => ({
              key: k, value: { stringValue: v },
            })),
            timeUnixNano: Date.now() * 1_000_000,
          }],
          aggregationTemporality: 2,
        },
      });
    }

    return {
      resourceMetrics: [{
        resource: {
          attributes: [
            { key: 'service.name', value: { stringValue: 'codebot' } },
            { key: 'session.id', value: { stringValue: snap.sessionId } },
          ],
        },
        scopeMetrics: [{
          scope: { name: 'codebot-metrics', version: '1.9.0' },
          metrics,
        }],
      }],
    };
  }
}
