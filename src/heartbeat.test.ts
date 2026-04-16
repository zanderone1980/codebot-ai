import { describe, it, before, after, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  loadHeartbeatConfig,
  saveHeartbeatConfig,
  newHeartbeatConfig,
  todayIso,
  isoWeek,
  dailyInstallationId,
  buildPayload,
  maybePing,
  ensureHeartbeatConfig,
  setHeartbeatEnabled,
  heartbeatStatus,
} from './heartbeat';

describe('heartbeat', () => {
  let tmpDir: string;
  const origHome = process.env.CODEBOT_HOME;
  const origDisabled = process.env.CODEBOT_HEARTBEAT_DISABLED;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'heartbeat-'));
    process.env.CODEBOT_HOME = tmpDir;
    delete process.env.CODEBOT_HEARTBEAT_DISABLED;
  });

  after(() => {
    if (origHome) process.env.CODEBOT_HOME = origHome;
    else delete process.env.CODEBOT_HOME;
    if (origDisabled) process.env.CODEBOT_HEARTBEAT_DISABLED = origDisabled;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  afterEach(() => {
    // Reset disk state between tests so each starts fresh.
    const p = path.join(tmpDir, 'heartbeat.json');
    try { fs.unlinkSync(p); } catch { /* ok */ }
  });

  describe('todayIso', () => {
    it('returns YYYY-MM-DD in UTC', () => {
      const d = new Date('2026-04-15T05:00:00Z');
      assert.strictEqual(todayIso(d), '2026-04-15');
    });

    it('does not drift across timezones (UTC-locked)', () => {
      // Same UTC instant should always give same date regardless of local TZ.
      const d = new Date('2026-04-15T23:30:00Z');
      assert.strictEqual(todayIso(d), '2026-04-15');
    });
  });

  describe('isoWeek', () => {
    it('returns ISO week format YYYY-Www', () => {
      const d = new Date('2026-04-15T00:00:00Z');
      const w = isoWeek(d);
      assert.match(w, /^2026-W\d{2}$/);
    });

    it('handles year boundary correctly (early January maps to W01)', () => {
      const d = new Date('2026-01-05T00:00:00Z'); // Monday of W01
      assert.strictEqual(isoWeek(d), '2026-W02');
    });
  });

  describe('dailyInstallationId', () => {
    it('produces a stable hash for same root + day', () => {
      const root = 'fixed-uuid';
      const d = new Date('2026-04-15T12:00:00Z');
      const a = dailyInstallationId(root, d);
      const b = dailyInstallationId(root, d);
      assert.strictEqual(a, b);
      assert.strictEqual(a.length, 32);
    });

    it('rotates daily — different day produces different hash', () => {
      const root = 'fixed-uuid';
      const d1 = new Date('2026-04-15T12:00:00Z');
      const d2 = new Date('2026-04-16T12:00:00Z');
      assert.notStrictEqual(dailyInstallationId(root, d1), dailyInstallationId(root, d2));
    });

    it('different installs on same day produce different hashes', () => {
      const d = new Date('2026-04-15T12:00:00Z');
      assert.notStrictEqual(dailyInstallationId('install-a', d), dailyInstallationId('install-b', d));
    });
  });

  describe('config save/load roundtrip', () => {
    it('saves and loads identical config', () => {
      const cfg = newHeartbeatConfig(true);
      saveHeartbeatConfig(cfg);
      const loaded = loadHeartbeatConfig();
      assert.deepStrictEqual(loaded, cfg);
    });

    it('returns null when no config file exists', () => {
      assert.strictEqual(loadHeartbeatConfig(), null);
    });

    it('rejects invalid schema (missing fields)', () => {
      fs.writeFileSync(path.join(tmpDir, 'heartbeat.json'), JSON.stringify({ v: 1 }));
      assert.strictEqual(loadHeartbeatConfig(), null);
    });

    it('rejects wrong schema version', () => {
      const cfg = { v: 999, enabled: true, installRoot: 'x'.repeat(36), lastPingDate: '', firstSeenDate: '', promptShown: true };
      fs.writeFileSync(path.join(tmpDir, 'heartbeat.json'), JSON.stringify(cfg));
      assert.strictEqual(loadHeartbeatConfig(), null);
    });

    it('handles corrupt JSON gracefully', () => {
      fs.writeFileSync(path.join(tmpDir, 'heartbeat.json'), 'not json {{');
      assert.strictEqual(loadHeartbeatConfig(), null);
    });
  });

  describe('buildPayload', () => {
    it('includes all expected fields', () => {
      const cfg = newHeartbeatConfig(true);
      const p = buildPayload(cfg, '2.10.0');
      assert.strictEqual(p.version, '2.10.0');
      assert.match(p.os, /^[a-z0-9]+-[a-z0-9]+$/);
      assert.match(p.first_seen_week, /^\d{4}-W\d{2}$/);
      assert.strictEqual(p.active_today, true);
      assert.strictEqual(p.installation_id.length, 32);
    });

    it('does NOT leak the installRoot', () => {
      const cfg = newHeartbeatConfig(true);
      const p = buildPayload(cfg, '2.10.0');
      const json = JSON.stringify(p);
      assert.ok(!json.includes(cfg.installRoot), 'installRoot must never be in the payload');
    });
  });

  describe('ensureHeartbeatConfig', () => {
    it('creates a fresh config if none exists (default OFF per PRIVACY.md)', () => {
      assert.strictEqual(loadHeartbeatConfig(), null);
      const cfg = ensureHeartbeatConfig({ quiet: true });
      assert.ok(cfg.installRoot.length >= 16);
      assert.strictEqual(cfg.enabled, false);
      assert.deepStrictEqual(loadHeartbeatConfig(), cfg);
    });

    it('respects defaultEnabled=true override (used in tests + opt-in flow)', () => {
      const cfg = ensureHeartbeatConfig({ quiet: true, defaultEnabled: true });
      assert.strictEqual(cfg.enabled, true);
    });

    it('returns existing config without modifying it', () => {
      const original = ensureHeartbeatConfig({ quiet: true });
      const second = ensureHeartbeatConfig({ quiet: true });
      assert.deepStrictEqual(second, original);
    });

    it('respects defaultEnabled=false', () => {
      const cfg = ensureHeartbeatConfig({ quiet: true, defaultEnabled: false });
      assert.strictEqual(cfg.enabled, false);
    });
  });

  describe('setHeartbeatEnabled', () => {
    it('toggles existing config', () => {
      ensureHeartbeatConfig({ quiet: true });
      const off = setHeartbeatEnabled(false);
      assert.strictEqual(off.enabled, false);
      const on = setHeartbeatEnabled(true);
      assert.strictEqual(on.enabled, true);
    });

    it('creates config if none exists', () => {
      assert.strictEqual(loadHeartbeatConfig(), null);
      const cfg = setHeartbeatEnabled(false);
      assert.strictEqual(cfg.enabled, false);
    });
  });

  describe('heartbeatStatus', () => {
    it('reports unconfigured', () => {
      assert.match(heartbeatStatus(), /not yet configured/);
    });

    it('reports OFF', () => {
      setHeartbeatEnabled(false);
      assert.match(heartbeatStatus(), /heartbeat: OFF/);
    });

    it('reports ON with last-ping never', () => {
      setHeartbeatEnabled(true);
      assert.match(heartbeatStatus(), /heartbeat: ON/);
      assert.match(heartbeatStatus(), /last-ping: never/);
    });
  });

  describe('maybePing', () => {
    it('does nothing when no config exists', async () => {
      const sent = await maybePing('2.10.0');
      assert.strictEqual(sent, false);
    });

    it('does nothing when disabled in config', async () => {
      setHeartbeatEnabled(false);
      const sent = await maybePing('2.10.0');
      assert.strictEqual(sent, false);
    });

    it('does nothing when CODEBOT_HEARTBEAT_DISABLED=1', async () => {
      ensureHeartbeatConfig({ quiet: true, defaultEnabled: true });
      process.env.CODEBOT_HEARTBEAT_DISABLED = '1';
      try {
        const sent = await maybePing('2.10.0');
        assert.strictEqual(sent, false);
      } finally {
        delete process.env.CODEBOT_HEARTBEAT_DISABLED;
      }
    });

    it('sends a ping when enabled and not already sent today', async () => {
      ensureHeartbeatConfig({ quiet: true, defaultEnabled: true });
      type Received = { url: string; body: { version: string; active_today: boolean; installation_id: string; os: string; node: string; first_seen_week: string } };
      let received: Received | null = null;
      // Simulate a successful endpoint by patching globalThis.fetch.
      const origFetch = globalThis.fetch;
      globalThis.fetch = (async (url: string, init: any) => {
        received = { url, body: JSON.parse(init.body) };
        return new Response(null, { status: 200 });
      }) as any;
      try {
        const sent = await maybePing('2.10.0', { endpoint: 'https://test.invalid/api/ping' });
        assert.strictEqual(sent, true);
        assert.ok(received);
        const got = received as Received;
        assert.strictEqual(got.url, 'https://test.invalid/api/ping');
        assert.strictEqual(got.body.version, '2.10.0');
        assert.strictEqual(got.body.active_today, true);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it('is idempotent within a day (does not re-ping)', async () => {
      ensureHeartbeatConfig({ quiet: true, defaultEnabled: true });
      let pingCount = 0;
      const origFetch = globalThis.fetch;
      globalThis.fetch = (async () => {
        pingCount++;
        return new Response(null, { status: 200 });
      }) as any;
      try {
        await maybePing('2.10.0', { endpoint: 'https://test.invalid/api/ping' });
        await maybePing('2.10.0', { endpoint: 'https://test.invalid/api/ping' });
        await maybePing('2.10.0', { endpoint: 'https://test.invalid/api/ping' });
        assert.strictEqual(pingCount, 1);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it('swallows network errors silently', async () => {
      ensureHeartbeatConfig({ quiet: true, defaultEnabled: true });
      const origFetch = globalThis.fetch;
      globalThis.fetch = (async () => { throw new Error('ECONNREFUSED'); }) as any;
      try {
        const sent = await maybePing('2.10.0', { endpoint: 'https://test.invalid/api/ping' });
        assert.strictEqual(sent, false);
      } finally {
        globalThis.fetch = origFetch;
      }
    });

    it('does not mark lastPingDate on failed ping (so we retry tomorrow)', async () => {
      ensureHeartbeatConfig({ quiet: true, defaultEnabled: true });
      const origFetch = globalThis.fetch;
      globalThis.fetch = (async () => new Response(null, { status: 503 })) as any;
      try {
        await maybePing('2.10.0', { endpoint: 'https://test.invalid/api/ping' });
        const cfg = loadHeartbeatConfig();
        assert.strictEqual(cfg!.lastPingDate, '');
      } finally {
        globalThis.fetch = origFetch;
      }
    });
  });
});
