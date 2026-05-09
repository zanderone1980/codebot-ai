import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as http from 'http';

import { AuditLogger } from './audit';
import {
  EventListener,
  handleInboundEvent,
  signEvent,
} from './event-listener';

const SECRET = 'a-test-secret-at-least-16-chars-long';

function makeAudit(): { audit: AuditLogger; dir: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-evt-test-'));
  const audit = new AuditLogger(dir);
  return { audit, dir };
}

describe('event-listener — handleInboundEvent', () => {
  let audit: AuditLogger;
  let dir: string;

  beforeEach(() => {
    const m = makeAudit();
    audit = m.audit;
    dir = m.dir;
  });

  afterEach(() => {
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it('accepts a properly signed event and writes webhook_received', async () => {
    const body = JSON.stringify({ pr: 42, repo: 'a/b' });
    const headers = signEvent(SECRET, body, 'github.pr.opened');
    const result = await handleInboundEvent(body, headers, { port: 1, secret: SECRET, audit });
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.reason, 'received');
    assert.ok(result.receiveAuditHash, 'should expose audit hash');

    const entries = audit.query({ action: 'webhook_received' });
    assert.strictEqual(entries.length, 1);
    assert.strictEqual(entries[0].args.eventType, 'github.pr.opened');
  });

  it('rejects unsigned requests with 400 and audits webhook_rejected', async () => {
    const body = '{}';
    const result = await handleInboundEvent(body, { 'content-type': 'application/json' }, {
      port: 1, secret: SECRET, audit,
    });
    assert.strictEqual(result.status, 400);
    assert.strictEqual(result.reason, 'missing_headers');

    const rejects = audit.query({ action: 'webhook_rejected' });
    assert.strictEqual(rejects.length, 1);
    assert.strictEqual(rejects[0].args.reason, 'missing_headers');
  });

  it('rejects bad HMAC with 401 and constant-time compare', async () => {
    const body = JSON.stringify({ x: 1 });
    const headers = signEvent(SECRET, body, 'evt');
    headers['x-codebot-signature'] = '0'.repeat(64); // wrong but valid hex length
    const result = await handleInboundEvent(body, headers, { port: 1, secret: SECRET, audit });
    assert.strictEqual(result.status, 401);
    assert.strictEqual(result.reason, 'bad_signature');

    const rejects = audit.query({ action: 'webhook_rejected' });
    assert.strictEqual(rejects.length, 1);
    assert.strictEqual(rejects[0].args.reason, 'bad_signature');
  });

  it('rejects non-hex signatures without crashing', async () => {
    const body = '{}';
    const headers = signEvent(SECRET, body, 'evt');
    headers['x-codebot-signature'] = 'not-hex-at-all!!';
    const result = await handleInboundEvent(body, headers, { port: 1, secret: SECRET, audit });
    assert.strictEqual(result.status, 401);
  });

  it('rejects stale timestamps (replay window)', async () => {
    const body = '{}';
    const oldTs = Math.floor(Date.now() / 1000) - 600; // 10 min ago
    const headers = signEvent(SECRET, body, 'evt', oldTs);
    const result = await handleInboundEvent(body, headers, { port: 1, secret: SECRET, audit });
    assert.strictEqual(result.status, 400);
    assert.strictEqual(result.reason, 'stale_timestamp');
  });

  it('parses non-JSON bodies into { raw } envelope', async () => {
    const body = 'plain text payload';
    const headers = signEvent(SECRET, body, 'plain');
    const result = await handleInboundEvent(body, headers, { port: 1, secret: SECRET, audit });
    assert.strictEqual(result.status, 200);
  });

  it('dispatches via onEvent and audits webhook_dispatched on success', async () => {
    const body = JSON.stringify({ x: 1 });
    const headers = signEvent(SECRET, body, 'evt');
    let dispatched = false;
    const result = await handleInboundEvent(body, headers, {
      port: 1, secret: SECRET, audit,
      onEvent: async (e) => {
        dispatched = true;
        assert.strictEqual(e.type, 'evt');
        assert.deepStrictEqual(e.body, { x: 1 });
        return 'ran the thing';
      },
    });
    assert.ok(dispatched);
    assert.strictEqual(result.status, 200);
    assert.strictEqual(result.reason, 'dispatched');
    assert.ok(result.dispatchAuditHash);

    const dispatches = audit.query({ action: 'webhook_dispatched' });
    assert.strictEqual(dispatches.length, 1);
    assert.strictEqual(dispatches[0].args.ok, true);
    assert.match(String(dispatches[0].args.summary), /ran the thing/);
  });

  it('audits webhook_dispatched ok:false when handler throws and returns 500', async () => {
    const body = '{}';
    const headers = signEvent(SECRET, body, 'evt');
    const result = await handleInboundEvent(body, headers, {
      port: 1, secret: SECRET, audit,
      onEvent: async () => { throw new Error('boom'); },
    });
    assert.strictEqual(result.status, 500);
    assert.strictEqual(result.reason, 'dispatch_failed');

    const dispatches = audit.query({ action: 'webhook_dispatched' });
    assert.strictEqual(dispatches.length, 1);
    assert.strictEqual(dispatches[0].args.ok, false);
    assert.match(String(dispatches[0].args.error), /boom/);
  });

  it('chains receive and dispatch entries (chain-of-custody)', async () => {
    const body = JSON.stringify({ id: 1 });
    const headers = signEvent(SECRET, body, 'evt');
    let receivedHash = '';
    const result = await handleInboundEvent(body, headers, {
      port: 1, secret: SECRET, audit,
      onEvent: async (e) => { receivedHash = e.receiveAuditHash; return 'ok'; },
    });
    assert.strictEqual(result.status, 200);

    const recv = audit.query({ action: 'webhook_received' });
    const disp = audit.query({ action: 'webhook_dispatched' });
    assert.strictEqual(recv.length, 1);
    assert.strictEqual(disp.length, 1);
    assert.strictEqual(receivedHash, recv[0].hash);
    assert.strictEqual(disp[0].args.receiveAuditHash, recv[0].hash);

    // Verify the chain over the whole session.
    const sessionEntries = audit.query({ sessionId: audit.getSessionId() });
    const verify = AuditLogger.verify(sessionEntries);
    assert.strictEqual(verify.valid, true, `chain invalid: ${verify.reason}`);
  });
});

describe('event-listener — EventListener server', () => {
  let audit: AuditLogger;
  let dir: string;
  let listener: EventListener;

  beforeEach(() => {
    const m = makeAudit();
    audit = m.audit;
    dir = m.dir;
  });

  afterEach(async () => {
    if (listener) await listener.stop();
    try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
  });

  it('rejects construction with short secret', () => {
    assert.throws(
      () => new EventListener({ port: 0, secret: 'short', audit }),
      /at least 16/,
    );
  });

  it('rejects construction with bad port', () => {
    assert.throws(
      () => new EventListener({ port: 0, secret: 'long-enough-secret-1234', audit }),
      /port must be 1-65535/,
    );
    assert.throws(
      () => new EventListener({ port: 70000, secret: 'long-enough-secret-1234', audit }),
      /port must be 1-65535/,
    );
  });

  it('starts, accepts a signed POST, and stops cleanly', async () => {
    listener = new EventListener({ port: 53127, secret: SECRET, audit });
    const { port } = await listener.start();
    assert.ok(listener.isListening());
    assert.strictEqual(port, 53127);

    const body = JSON.stringify({ hello: 'world' });
    const headers = signEvent(SECRET, body, 'integration.smoke');

    const result: { status: number; body: string } = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port, path: '/event', method: 'POST',
        headers: { ...headers, 'content-length': String(Buffer.byteLength(body)) },
      }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode || 0, body: Buffer.concat(chunks).toString('utf-8') }));
      });
      req.on('error', reject);
      req.write(body);
      req.end();
    });

    assert.strictEqual(result.status, 200);
    const parsed = JSON.parse(result.body);
    assert.strictEqual(parsed.ok, true);
    assert.strictEqual(parsed.reason, 'received');
  });

  it('returns 404 for non-/event paths', async () => {
    listener = new EventListener({ port: 53128, secret: SECRET, audit });
    await listener.start();

    const status: number = await new Promise((resolve, reject) => {
      const req = http.request({
        host: '127.0.0.1', port: 53128, path: '/nope', method: 'POST',
      }, (res) => { res.resume(); res.on('end', () => resolve(res.statusCode || 0)); });
      req.on('error', reject);
      req.end();
    });
    assert.strictEqual(status, 404);
  });
});
