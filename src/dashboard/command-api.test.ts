import { describe, it, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as http from 'http';
import { DashboardServer } from './server';
import { registerCommandRoutes } from './command-api';

function request(
  url: string,
  method: string = 'GET',
  body?: string,
  token?: string,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const opts: http.RequestOptions = { method };
    const headers: Record<string, string> = {};
    if (token) headers['Authorization'] = `Bearer ${token}`;
    if (body) headers['Content-Type'] = 'application/json';
    if (Object.keys(headers).length > 0) opts.headers = headers;
    const req = http.request(url, opts, (res) => {
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
    if (body) req.write(body);
    req.end();
  });
}

let portCounter = 15120;
function nextPort(): number {
  return portCounter++;
}

describe('Command Center API', () => {
  let server: DashboardServer | null = null;

  afterEach(async () => {
    if (server && server.isRunning()) {
      await server.stop();
    }
    server = null;
  });

  it('GET /api/command/status returns unavailable when agent is null', async () => {
    const port = nextPort();
    server = new DashboardServer({ port });
    registerCommandRoutes(server, null);
    await server.start();

    const res = await request(`http://127.0.0.1:${port}/api/command/status`, 'GET', undefined, server!.getAuthToken());
    assert.strictEqual(res.status, 200);
    const data = JSON.parse(res.body);
    assert.strictEqual(data.available, false);
  });

  it('GET /api/command/tools returns 503 when agent is null', async () => {
    const port = nextPort();
    server = new DashboardServer({ port });
    registerCommandRoutes(server, null);
    await server.start();

    const res = await request(`http://127.0.0.1:${port}/api/command/tools`, 'GET', undefined, server!.getAuthToken());
    assert.strictEqual(res.status, 503);
  });

  it('POST /api/command/tool/run returns 503 when agent is null', async () => {
    const port = nextPort();
    server = new DashboardServer({ port });
    registerCommandRoutes(server, null);
    await server.start();

    const res = await request(
      `http://127.0.0.1:${port}/api/command/tool/run`,
      'POST',
      JSON.stringify({ tool: 'read_file', args: { path: '/tmp/x' } }),
      server!.getAuthToken(),
    );
    assert.strictEqual(res.status, 503);
  });

  it('POST /api/command/chat returns 503 when agent is null', async () => {
    const port = nextPort();
    server = new DashboardServer({ port });
    registerCommandRoutes(server, null);
    await server.start();

    const res = await request(
      `http://127.0.0.1:${port}/api/command/chat`,
      'POST',
      JSON.stringify({ message: 'hello' }),
      server!.getAuthToken(),
    );
    assert.strictEqual(res.status, 503);
  });

  it('POST /api/command/quick-action returns 400 for unknown action', async () => {
    const port = nextPort();
    server = new DashboardServer({ port });
    registerCommandRoutes(server, null);
    await server.start();

    // Quick actions now work standalone — unknown action returns 400
    const res = await request(
      `http://127.0.0.1:${port}/api/command/quick-action`,
      'POST',
      JSON.stringify({ action: 'nonexistent' }),
      server!.getAuthToken(),
    );
    // 400 because action is validated first (standalone mode runs exec)
    assert.strictEqual(res.status, 400);
  });

  it('POST /api/command/exec streams stdout for simple command', async () => {
    const port = nextPort();
    server = new DashboardServer({ port });
    registerCommandRoutes(server, null);
    await server.start();

    const res = await request(
      `http://127.0.0.1:${port}/api/command/exec`,
      'POST',
      JSON.stringify({ command: 'echo hello-from-test' }),
      server!.getAuthToken(),
    );
    assert.strictEqual(res.status, 200);
    assert.ok(res.body.includes('hello-from-test'));
    assert.ok(res.body.includes('"type":"stdout"'));
  });

  it('POST /api/command/exec rejects blocked commands', async () => {
    const port = nextPort();
    server = new DashboardServer({ port });
    registerCommandRoutes(server, null);
    await server.start();

    const res = await request(
      `http://127.0.0.1:${port}/api/command/exec`,
      'POST',
      JSON.stringify({ command: 'rm -rf /' }),
      server!.getAuthToken(),
    );
    assert.strictEqual(res.status, 403);
    const data = JSON.parse(res.body);
    assert.ok(data.error.includes('Blocked'));
  });

  it('POST /api/command/exec returns 400 when command is missing', async () => {
    const port = nextPort();
    server = new DashboardServer({ port });
    registerCommandRoutes(server, null);
    await server.start();

    const res = await request(
      `http://127.0.0.1:${port}/api/command/exec`,
      'POST',
      JSON.stringify({}),
      server!.getAuthToken(),
    );
    assert.strictEqual(res.status, 400);
  });

  it('GET /api/command/history returns empty when agent is null', async () => {
    const port = nextPort();
    server = new DashboardServer({ port });
    registerCommandRoutes(server, null);
    await server.start();

    const res = await request(`http://127.0.0.1:${port}/api/command/history`, 'GET', undefined, server!.getAuthToken());
    assert.strictEqual(res.status, 200);
    const data = JSON.parse(res.body);
    assert.deepStrictEqual(data.messages, []);
  });

  it('SSE helpers produce correct format', async () => {
    const port = nextPort();
    server = new DashboardServer({ port });

    // Test SSE through exec endpoint which always works (no agent needed)
    registerCommandRoutes(server, null);
    await server.start();

    const res = await request(
      `http://127.0.0.1:${port}/api/command/exec`,
      'POST',
      JSON.stringify({ command: 'echo test123' }),
      server!.getAuthToken(),
    );

    // Verify SSE format: lines start with "data: "
    const lines = res.body.split('\n').filter(l => l.startsWith('data: '));
    assert.ok(lines.length >= 2, 'Should have at least stdout + exit events');

    // Verify JSON parseable
    for (const line of lines) {
      const payload = line.slice(6);
      if (payload === '[DONE]') continue;
      const parsed = JSON.parse(payload);
      assert.ok(parsed.type, 'Each event should have a type');
    }
  });
});
