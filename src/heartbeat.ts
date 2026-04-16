/**
 * Anonymous opt-in heartbeat — daily install ping.
 *
 * Distinct from src/telemetry.ts (which tracks per-session token cost).
 * This module exists ONLY to count active installs across the user base
 * so we know if the project is gaining traction. No personal data, no
 * code, no prompts, no model output — just version/OS/active flag.
 *
 * Privacy model:
 *   - Per-day rotating installation_id = sha256(installRoot + YYYY-MM-DD).
 *     The same install produces a different hash each day, so pings cannot
 *     be linked across days. We can count daily-active without tracking.
 *   - The base installRoot is a one-time random uuid stored on disk in
 *     ~/.codebot/heartbeat.json. Never sent over the wire on its own.
 *   - Opt-out at any time: `codebot --heartbeat off` (or set
 *     `enabled: false` in heartbeat.json).
 *   - First-run prompt explains everything before the first ping.
 *
 * Failure model:
 *   - Network errors are swallowed silently. Heartbeat must NEVER block
 *     the CLI or print anything to the user during normal operation.
 *   - Daily-pinged-already check happens before any network call so
 *     repeated startups in the same day cost nothing.
 *
 * Kill switches (for CI / tests / privacy-conscious environments):
 *   - Env var CODEBOT_HEARTBEAT_DISABLED=1 stops everything regardless of
 *     on-disk config.
 *   - Setting CODEBOT_HEARTBEAT_URL overrides the endpoint (self-host).
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { codebotPath } from './paths';

/** Default endpoint. Override via env var CODEBOT_HEARTBEAT_URL. */
const DEFAULT_HEARTBEAT_URL = 'https://codebot-stats.workers.dev/api/ping';

/** How long to wait for the network ping before giving up silently. */
const PING_TIMEOUT_MS = 3000;

/** Schema version for the on-disk heartbeat config. Bump when fields change. */
const HEARTBEAT_SCHEMA_VERSION = 1;

export interface HeartbeatConfig {
  v: number;
  enabled: boolean;
  installRoot: string;
  lastPingDate: string;
  firstSeenDate: string;
  promptShown: boolean;
}

export interface PingPayload {
  installation_id: string;
  version: string;
  os: string;
  node: string;
  first_seen_week: string;
  active_today: boolean;
}

function heartbeatConfigPath(): string {
  return codebotPath('heartbeat.json');
}

export function loadHeartbeatConfig(): HeartbeatConfig | null {
  try {
    const p = heartbeatConfigPath();
    if (!fs.existsSync(p)) return null;
    const raw = fs.readFileSync(p, 'utf-8');
    const parsed = JSON.parse(raw) as Partial<HeartbeatConfig>;
    if (parsed.v !== HEARTBEAT_SCHEMA_VERSION) return null;
    if (typeof parsed.enabled !== 'boolean') return null;
    if (typeof parsed.installRoot !== 'string' || parsed.installRoot.length < 16) return null;
    return {
      v: parsed.v,
      enabled: parsed.enabled,
      installRoot: parsed.installRoot,
      lastPingDate: parsed.lastPingDate || '',
      firstSeenDate: parsed.firstSeenDate || '',
      promptShown: parsed.promptShown ?? false,
    };
  } catch {
    return null;
  }
}

export function saveHeartbeatConfig(cfg: HeartbeatConfig): void {
  try {
    const p = heartbeatConfigPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify(cfg, null, 2));
  } catch {
    /* best effort */
  }
}

export function newHeartbeatConfig(enabled: boolean): HeartbeatConfig {
  return {
    v: HEARTBEAT_SCHEMA_VERSION,
    enabled,
    installRoot: crypto.randomUUID(),
    lastPingDate: '',
    firstSeenDate: todayIso(),
    promptShown: true,
  };
}

/** YYYY-MM-DD in UTC so it doesn't drift by timezone. */
export function todayIso(date: Date = new Date()): string {
  const y = date.getUTCFullYear();
  const m = String(date.getUTCMonth() + 1).padStart(2, '0');
  const d = String(date.getUTCDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** ISO-8601 week, e.g. "2026-W16". Standard Thursday-based algorithm. */
export function isoWeek(date: Date = new Date()): string {
  const d = new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate()));
  const dayNum = d.getUTCDay() || 7;
  d.setUTCDate(d.getUTCDate() + 4 - dayNum);
  const yearStart = new Date(Date.UTC(d.getUTCFullYear(), 0, 1));
  const weekNum = Math.ceil(((d.getTime() - yearStart.getTime()) / 86400000 + 1) / 7);
  return `${d.getUTCFullYear()}-W${String(weekNum).padStart(2, '0')}`;
}

/**
 * Per-day rotating installation ID. Same install produces a different
 * hash on different days — so we can count daily-active without tracking
 * across days.
 */
export function dailyInstallationId(installRoot: string, date: Date = new Date()): string {
  const day = todayIso(date);
  return crypto.createHash('sha256').update(`${installRoot}:${day}`).digest('hex').slice(0, 32);
}

export function buildPayload(cfg: HeartbeatConfig, version: string): PingPayload {
  return {
    installation_id: dailyInstallationId(cfg.installRoot),
    version,
    os: `${process.platform}-${process.arch}`,
    node: (process.versions.node || '').split('.')[0] || 'unknown',
    first_seen_week: cfg.firstSeenDate
      ? isoWeek(new Date(cfg.firstSeenDate + 'T00:00:00Z'))
      : isoWeek(),
    active_today: true,
  };
}

/**
 * Send the daily ping if needed. Idempotent within a day. Silent on all
 * errors. Returns true if a ping was actually sent (mainly for tests).
 */
export async function maybePing(
  version: string,
  opts?: { now?: Date; endpoint?: string },
): Promise<boolean> {
  if (process.env.CODEBOT_HEARTBEAT_DISABLED === '1') return false;

  const cfg = loadHeartbeatConfig();
  if (!cfg || !cfg.enabled) return false;

  const today = todayIso(opts?.now);
  if (cfg.lastPingDate === today) return false;

  const payload = buildPayload(cfg, version);
  const endpoint = opts?.endpoint || process.env.CODEBOT_HEARTBEAT_URL || DEFAULT_HEARTBEAT_URL;

  try {
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), PING_TIMEOUT_MS);
    const res = await fetch(endpoint, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: ctrl.signal,
    });
    clearTimeout(t);
    if (!res.ok) return false;
  } catch {
    return false;
  }

  // Mark as pinged AFTER success so a transient failure today doesn't
  // skip us tomorrow.
  saveHeartbeatConfig({ ...cfg, lastPingDate: today });
  return true;
}

/** First-run consent message. Quiet=true skips this for tests. */
export function showFirstRunPrompt(write: (s: string) => void = (s) => process.stdout.write(s)): void {
  write(
    `\n\x1b[36m[heartbeat]\x1b[0m CodeBot can send an anonymous daily ping (version, OS, Node\n` +
      `version) to help the project count active installs. Per-day rotating ID —\n` +
      `pings can NOT be linked across days. NO code, NO file paths, NO prompts,\n` +
      `NO model output, NO API keys, ever.\n\n` +
      `Heartbeat is OFF by default. Opt in with:  codebot --heartbeat on\n` +
      `Schema and full details:                   docs/PRIVACY.md\n\n`,
  );
}

/**
 * Idempotently set up the heartbeat config on first run.
 *
 * Default: DISABLED. The PRIVACY.md commitment is "Default OFF" and we
 * honor it. The first-run prompt explains how to opt in.
 */
export function ensureHeartbeatConfig(opts?: {
  defaultEnabled?: boolean;
  quiet?: boolean;
}): HeartbeatConfig {
  const existing = loadHeartbeatConfig();
  if (existing) return existing;

  const enabled = opts?.defaultEnabled ?? false;
  const cfg = newHeartbeatConfig(enabled);
  saveHeartbeatConfig(cfg);
  if (!opts?.quiet) showFirstRunPrompt();
  return cfg;
}

/** Programmatically toggle heartbeat. Used by `codebot --heartbeat on/off`. */
export function setHeartbeatEnabled(enabled: boolean): HeartbeatConfig {
  const existing = loadHeartbeatConfig();
  if (existing) {
    const updated: HeartbeatConfig = { ...existing, enabled, promptShown: true };
    saveHeartbeatConfig(updated);
    return updated;
  }
  const fresh = newHeartbeatConfig(enabled);
  saveHeartbeatConfig(fresh);
  return fresh;
}

/** One-line status string for `codebot --heartbeat status`. */
export function heartbeatStatus(): string {
  const cfg = loadHeartbeatConfig();
  if (!cfg) return 'heartbeat: not yet configured (will prompt on next run)';
  if (!cfg.enabled) return 'heartbeat: OFF';
  return `heartbeat: ON  •  first-seen: ${cfg.firstSeenDate || 'unknown'}  •  last-ping: ${cfg.lastPingDate || 'never'}`;
}
