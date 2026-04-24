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

  it('disabling vault restores pre-vault projectRoot + cwd (2026-04-23 regression)', async () => {
    // Regression test for external review finding: setVaultMode(null) was
    // leaving projectRoot = vaultPath and cwd inside the vault, which meant
    // the rehydrated coding agent came back with write-enabled tools rooted
    // in the user's notes folder. Fixed by snapshotting pre-vault state on
    // enable and restoring on disable.
    const { port, token } = await startServer();
    const preVaultRoot = agent!.getProjectRoot();
    const preVaultCwd = process.cwd();
    assert.notStrictEqual(preVaultRoot, fixtureVault, 'precondition: agent should not already be in the fixture vault');

    // Enable
    await request(
      `http://127.0.0.1:${port}/api/command/vault`,
      'POST',
      token,
      { vaultPath: fixtureVault! },
    );
    // Vault active: projectRoot moved into the vault, cwd moved too
    assert.ok(
      agent!.getProjectRoot() === fixtureVault ||
        agent!.getProjectRoot() === fs.realpathSync(fixtureVault!),
      `vault enable should move projectRoot into the vault, got ${agent!.getProjectRoot()}`,
    );
    assert.ok(
      process.cwd() === fixtureVault || process.cwd() === fs.realpathSync(fixtureVault!),
      `vault enable should chdir into the vault, got ${process.cwd()}`,
    );

    // Disable
    await request(
      `http://127.0.0.1:${port}/api/command/vault`,
      'POST',
      token,
      { vaultPath: '' },
    );

    // projectRoot and cwd must be restored, not left inside the vault.
    assert.strictEqual(
      agent!.getProjectRoot(),
      preVaultRoot,
      'disabling vault must restore projectRoot to pre-vault value',
    );
    assert.strictEqual(
      process.cwd(),
      preVaultCwd,
      'disabling vault must restore cwd to pre-vault value',
    );
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

  it('POST /api/command/exec audits + blocks destructive commands (2026-04-23)', async () => {
    // Regression test for external review finding: /api/command/exec used to
    // be gated only by BLOCKED_PATTERNS regex, bypassing CORD. Now every
    // attempt is audited and constitutionally checked.
    const { port, token } = await startServer();
    const res = await request(
      `http://127.0.0.1:${port}/api/command/exec`,
      'POST',
      token,
      { command: 'rm -rf /' },
    );
    assert.strictEqual(res.status, 403, 'rm -rf / must be blocked');
    // Either CORD or BLOCKED_PATTERNS can catch this; the important
    // assertion is that it's blocked AND an audit entry was written.
    const auditor = agent!.getAuditLogger();
    const entries = auditor.query({ tool: 'dashboard_exec' });
    assert.ok(
      entries.some(e => e.action === 'constitutional_block' || e.action === 'security_block'),
      `expected a block entry in the audit log, got ${JSON.stringify(entries.map(e => e.action))}`,
    );
  });

  it('POST /api/command/exec audits successful commands (2026-04-23)', async () => {
    const { port, token } = await startServer();
    const res = await request(
      `http://127.0.0.1:${port}/api/command/exec`,
      'POST',
      token,
      { command: 'echo hello' },
    );
    // SSE stream returns 200; we just need to confirm the execute entry
    // made it into the audit log.
    assert.strictEqual(res.status, 200);
    const auditor = agent!.getAuditLogger();
    const entries = auditor.query({ tool: 'dashboard_exec' });
    assert.ok(
      entries.some(e => e.action === 'execute' && typeof e.args.command === 'string' && (e.args.command as string).includes('echo hello')),
      `expected execute entry for echo hello, got ${JSON.stringify(entries)}`,
    );
  });

  it('POST /api/command/tool/run rejects unknown tool with 404 + audit (2026-04-23)', async () => {
    // Regression test for external review finding: /tool/run used to call
    // tool.execute(args) directly with no validation/CORD/audit. Now it
    // routes through agent.evaluateToolCall() and audits the verdict.
    const { port, token } = await startServer();
    const res = await request(
      `http://127.0.0.1:${port}/api/command/tool/run`,
      'POST',
      token,
      { tool: 'definitely_not_a_real_tool', args: {} },
    );
    assert.strictEqual(res.status, 404);
    const auditor = agent!.getAuditLogger();
    const entries = auditor.query({ tool: 'dashboard_tool_run' });
    assert.ok(
      entries.some(e => e.action === 'deny'),
      `expected a deny entry for unknown tool, got ${JSON.stringify(entries.map(e => e.action))}`,
    );
  });

  it('POST /api/command/tool/run rejects missing required args with 400 + audit (2026-04-23)', async () => {
    const { port, token } = await startServer();
    // read_file requires `path` — send without it
    const res = await request(
      `http://127.0.0.1:${port}/api/command/tool/run`,
      'POST',
      token,
      { tool: 'read_file', args: {} },
    );
    assert.strictEqual(res.status, 400);
    const auditor = agent!.getAuditLogger();
    const entries = auditor.query({ tool: 'dashboard_tool_run' });
    assert.ok(
      entries.some(e => e.action === 'deny'),
      `expected a deny entry for missing args, got ${JSON.stringify(entries.map(e => e.action))}`,
    );
  });

  it('POST /api/command/tool/run audits successful tool execution (2026-04-23)', async () => {
    const { port, token } = await startServer();
    // Valid read_file of the fixture's note.md
    const res = await request(
      `http://127.0.0.1:${port}/api/command/tool/run`,
      'POST',
      token,
      { tool: 'read_file', args: { path: path.join(fixtureVault!, 'note.md') } },
    );
    assert.strictEqual(res.status, 200);
    const body = JSON.parse(res.body);
    assert.ok(!body.is_error, `expected success, got: ${JSON.stringify(body).slice(0, 300)}`);
    assert.ok(body.risk, 'response must include risk assessment');
    const auditor = agent!.getAuditLogger();
    const entries = auditor.query({ tool: 'dashboard_tool_run' });
    assert.ok(
      entries.some(e => e.action === 'execute' && typeof e.args.tool === 'string' && e.args.tool === 'read_file'),
      `expected execute entry for read_file, got ${JSON.stringify(entries.map(e => `${e.action}:${e.args.tool}`))}`,
    );
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
    assert.ok(body.vault.vaultPath.startsWith('/'), 'expanded path should be absolute');
    assert.ok(
      !body.vault.vaultPath.includes('~'),
      'expanded path should not contain ~',
    );
  });
});
