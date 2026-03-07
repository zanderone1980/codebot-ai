import { describe, it, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { DashboardServer } from './server';
import { registerApiRoutes } from './api';

function request(url: string, method: string = 'GET', token?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    const req = http.request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        resolve({
          status: res.statusCode || 0,
          body: Buffer.concat(chunks).toString('utf-8'),
        });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

let portCounter = 14120;
function nextPort(): number {
  return portCounter++;
}

describe('Dashboard API', () => {
  let server: DashboardServer | null = null;
  let tmpDir: string = '';

  afterEach(async () => {
    if (server && server.isRunning()) {
      await server.stop();
    }
    server = null;
    if (tmpDir && fs.existsSync(tmpDir)) {
      fs.rmSync(tmpDir, { recursive: true });
    }
  });

  function setupTestProject(): string {
    tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'api-test-'));
    const sessionsDir = path.join(tmpDir, '.codebot', 'sessions');
    const auditDir = path.join(tmpDir, '.codebot', 'audit');
    fs.mkdirSync(sessionsDir, { recursive: true });
    fs.mkdirSync(auditDir, { recursive: true });

    // Create a test session
    fs.writeFileSync(
      path.join(sessionsDir, 'test-session-1.jsonl'),
      '{"role":"user","content":"hello"}\n{"role":"assistant","content":"hi there"}\n'
    );

    // Create a test audit log
    fs.writeFileSync(
      path.join(auditDir, 'test-session-1.jsonl'),
      '{"tool":"read_file","action":"execute","timestamp":"2025-01-01T00:00:00Z","hash":"abc"}\n{"tool":"write_file","action":"execute","timestamp":"2025-01-01T00:01:00Z","prevHash":"abc","hash":"def"}\n'
    );

    return tmpDir;
  }

  it('GET /api/health returns ok', async () => {
    const port = nextPort();
    server = new DashboardServer({ port });
    registerApiRoutes(server);
    await server.start();

    const res = await request(`http://127.0.0.1:${port}/api/health`, 'GET', server!.getAuthToken());
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.status, 'ok');
    assert.ok(body.version);
    assert.ok(typeof body.uptime === 'number');
  });

  it('GET /api/sessions returns session list', async () => {
    const port = nextPort();
    const root = setupTestProject();
    server = new DashboardServer({ port });
    registerApiRoutes(server, root);
    await server.start();

    const res = await request(`http://127.0.0.1:${port}/api/sessions`, 'GET', server!.getAuthToken());
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.sessions));
    assert.strictEqual(body.total, 1);
    assert.strictEqual(body.sessions[0].id, 'test-session-1');
  });

  it('GET /api/sessions/:id returns session detail', async () => {
    const port = nextPort();
    const root = setupTestProject();
    server = new DashboardServer({ port });
    registerApiRoutes(server, root);
    await server.start();

    const res = await request(`http://127.0.0.1:${port}/api/sessions/test-session-1`, 'GET', server!.getAuthToken());
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.id, 'test-session-1');
    assert.strictEqual(body.messageCount, 2);
  });

  it('GET /api/sessions/:id returns 404 for missing session', async () => {
    const port = nextPort();
    const root = setupTestProject();
    server = new DashboardServer({ port });
    registerApiRoutes(server, root);
    await server.start();

    const res = await request(`http://127.0.0.1:${port}/api/sessions/nonexistent`, 'GET', server!.getAuthToken());
    assert.strictEqual(res.status, 404);
  });

  it('GET /api/audit returns audit entries', async () => {
    const port = nextPort();
    const root = setupTestProject();
    server = new DashboardServer({ port });
    registerApiRoutes(server, root);
    await server.start();

    const res = await request(`http://127.0.0.1:${port}/api/audit?days=365`, 'GET', server!.getAuthToken());
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.entries));
    assert.ok(body.total >= 0);
  });

  it('GET /api/audit/verify returns chain integrity', async () => {
    const port = nextPort();
    const root = setupTestProject();
    server = new DashboardServer({ port });
    registerApiRoutes(server, root);
    await server.start();

    const res = await request(`http://127.0.0.1:${port}/api/audit/verify`, 'GET', server!.getAuthToken());
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.chainIntegrity === 'verified' || body.chainIntegrity === 'broken');
  });

  it('GET /api/metrics/summary returns aggregated stats', async () => {
    const port = nextPort();
    const root = setupTestProject();
    server = new DashboardServer({ port });
    registerApiRoutes(server, root);
    await server.start();

    const res = await request(`http://127.0.0.1:${port}/api/metrics/summary`, 'GET', server!.getAuthToken());
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(typeof body.sessions === 'number');
    assert.ok(typeof body.auditEntries === 'number');
  });

  it('GET /api/usage returns usage history', async () => {
    const port = nextPort();
    const root = setupTestProject();
    server = new DashboardServer({ port });
    registerApiRoutes(server, root);
    await server.start();

    const res = await request(`http://127.0.0.1:${port}/api/usage`, 'GET', server!.getAuthToken());
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(Array.isArray(body.usage));
  });

  it('POST /api/audit/export returns entries', async () => {
    const port = nextPort();
    const root = setupTestProject();
    server = new DashboardServer({ port });
    registerApiRoutes(server, root);
    await server.start();

    const res = await request(`http://127.0.0.1:${port}/api/audit/export`, 'POST', server!.getAuthToken());
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(body.format);
    assert.ok(body.version);
  });

  it('handles empty project directory gracefully', async () => {
    const port = nextPort();
    tmpDir = fs.mkdtempSync(path.join(require('os').tmpdir(), 'api-empty-'));
    server = new DashboardServer({ port });
    registerApiRoutes(server, tmpDir);
    await server.start();

    const res = await request(`http://127.0.0.1:${port}/api/sessions`, 'GET', server!.getAuthToken());
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.total, 0);
  });
});
