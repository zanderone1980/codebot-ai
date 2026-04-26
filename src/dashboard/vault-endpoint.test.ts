import { describe, it, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DashboardServer } from './server';
import { registerCommandRoutes } from './command-api';
import { Agent } from '../agent';
import type { LLMProvider, AgentEvent } from '../types';
import { makeTestAuditDir } from '../test-audit-isolation';

/**
 * Integration tests for POST /api/command/vault. We spin up a real
 * DashboardServer, wire a real Agent (with a stub provider), and hit
 * the endpoint over HTTP. These tests verify:
 *   - Validation of the vault path (must exist, must be a directory)
 *   - GET /api/command/vault returns null when no vault active
 *   - POST enables vault, GET reflects it, Agent.getVaultMode matches
 *   - POST with empty path disables vault mode
 */

function request(
  url: string,
  method: string,
  token: string,
  body?: unknown,
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = { Authorization: `Bearer ${token}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    const req = http.request(url, { method, headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => resolve({
        status: res.statusCode || 0,
        body: Buffer.concat(chunks).toString('utf-8'),
      }));
    });
    req.on('error', reject);
    if (body !== undefined) req.write(JSON.stringify(body));
    req.end();
  });
}

/**
 * Minimal stub provider — the vault endpoint path never hits the LLM,
 * so we don't need a real one. Yielding a "done" event keeps the Agent
 * constructor happy.
 */
function makeStubProvider(): LLMProvider {
  return {
    name: 'stub',
    async *chat(): AsyncGenerator<AgentEvent> {
      yield { type: 'done' };
    },
  } as LLMProvider;
}

let portCounter = 15220;
function nextPort(): number { return portCounter++; }

describe('POST /api/command/vault — dashboard vault control', () => {
  let server: DashboardServer | null = null;
  let fixtureVault: string | null = null;
  let agent: Agent | null = null;

  afterEach(async () => {
    if (server && server.isRunning()) await server.stop();
    server = null;
    // Enabling vault-mode chdir'd the process into fixtureVault; if we
    // rm it while cwd still points there, any subsequent process.cwd()
    // call throws ENOENT (uv_cwd). Return to a safe dir before deleting.
    try { process.chdir(os.homedir()); } catch { /* best effort */ }
    if (fixtureVault && fs.existsSync(fixtureVault)) {
      try { fs.rmSync(fixtureVault, { recursive: true }); } catch { /* ignore */ }
    }
    fixtureVault = null;
    agent = null;
  });

  async function startServer(): Promise<{ port: number; token: string }> {
    fixtureVault = fs.mkdtempSync(path.join(os.homedir(), '.cb-test-vault-api-'));
    // Add one markdown file so a real vault-mode session could work
    fs.writeFileSync(path.join(fixtureVault, 'note.md'), '# Test note\n\nHello from the fixture.\n');

    agent = new Agent({
      auditDir: makeTestAuditDir(),
      provider: makeStubProvider(),
      model: 'stub-model',
      providerName: 'stub',
      projectRoot: process.cwd(),
    });

    const port = nextPort();
    server = new DashboardServer({ port });
    registerCommandRoutes(server, agent);
    await server.start();
    return { port, token: server.getAuthToken() };
  }

  it('GET /api/command/vault returns null when no vault is active', async () => {
    const { port, token } = await startServer();
    const res = await request(`http://127.0.0.1:${port}/api/command/vault`, 'GET', token);
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.vault, null);
  });

  it('POST enables vault; GET then reflects the new state', async () => {
    const { port, token } = await startServer();
    const res = await request(
      `http://127.0.0.1:${port}/api/command/vault`,
      'POST',
      token,
      { vaultPath: fixtureVault!, writable: false, networkAllowed: false },
    );
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.enabled, true);
    assert.strictEqual(body.vault.writable, false);
    assert.strictEqual(body.vault.networkAllowed, false);
    // Resolved path should match fixture (realpath may add /private prefix on macOS)
    assert.ok(
      body.vault.vaultPath === fixtureVault ||
      body.vault.vaultPath === fs.realpathSync(fixtureVault!),
      `expected vault path to match fixture, got ${body.vault.vaultPath}`,
    );

    // GET reflects it
    const get = await request(`http://127.0.0.1:${port}/api/command/vault`, 'GET', token);
    const getBody = JSON.parse(get.body);
    assert.ok(getBody.vault, 'GET should return the active vault');

    // Agent.getVaultMode matches
    assert.deepStrictEqual(agent!.getVaultMode(), body.vault);
  });

  it('POST with writable=true + networkAllowed=true passes flags through', async () => {
    const { port, token } = await startServer();
    const res = await request(
      `http://127.0.0.1:${port}/api/command/vault`,
      'POST',
      token,
      { vaultPath: fixtureVault!, writable: true, networkAllowed: true },
    );
    const body = JSON.parse(res.body);
    assert.strictEqual(body.vault.writable, true);
    assert.strictEqual(body.vault.networkAllowed, true);
  });

  it('POST with empty path disables vault mode', async () => {
    const { port, token } = await startServer();
    // Enable first
    await request(
      `http://127.0.0.1:${port}/api/command/vault`,
      'POST',
      token,
      { vaultPath: fixtureVault! },
    );
    // Then disable
    const res = await request(
      `http://127.0.0.1:${port}/api/command/vault`,
      'POST',
      token,
      { vaultPath: '' },
    );
    const body = JSON.parse(res.body);
    assert.strictEqual(body.disabled, true);
    assert.strictEqual(body.vault, null);
    assert.strictEqual(agent!.getVaultMode(), null);
  });

  it('POST with non-existent path returns 400', async () => {
    const { port, token } = await startServer();
    const res = await request(
      `http://127.0.0.1:${port}/api/command/vault`,
      'POST',
      token,
      { vaultPath: '/this/path/definitely/does/not/exist/anywhere' },
    );
    assert.strictEqual(res.status, 400);
    assert.match(res.body, /does not exist/);
  });

  it('POST with a file (not directory) returns 400', async () => {
    const { port, token } = await startServer();
    const file = path.join(fixtureVault!, 'note.md');
    const res = await request(
      `http://127.0.0.1:${port}/api/command/vault`,
      'POST',
      token,
      { vaultPath: file },
    );
    assert.strictEqual(res.status, 400);
    assert.match(res.body, /not a directory/);
  });

  it('POST expands ~ to homedir', async () => {
    const { port, token } = await startServer();
    // fixtureVault is already under homedir — compute its ~-relative form
    const rel = fixtureVault!.replace(os.homedir(), '~');
    const res = await request(
      `http://127.0.0.1:${port}/api/command/vault`,
      'POST',
      token,
      { vaultPath: rel },
    );
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    // Issue #11: previously asserted .startsWith('/'), which is wrong on
    // Windows where absolute paths look like `C:\Users\…`. The actual
    // contract is "the path is absolute and the ~ token is gone".
    assert.ok(
      path.isAbsolute(body.vault.vaultPath),
      `expanded path should be absolute, got ${body.vault.vaultPath}`,
    );
    assert.ok(
      !body.vault.vaultPath.includes('~'),
      'expanded path should not contain ~',
    );
  });
});
