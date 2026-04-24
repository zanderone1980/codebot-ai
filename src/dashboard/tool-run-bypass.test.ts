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
 * Acceptance tests for the POST /api/command/tool/run bypass fix
 * (2026-04-23 SECURITY).
 *
 * Before this fix the endpoint called `tool.execute(body.args)` directly
 * on the ToolRegistry entry — bypassing schema validation, policy
 * allow-list, risk scoring, ConstitutionalLayer, SPARK, permission
 * prompts, and AuditLogger. A dashboard-token holder could run any
 * registered tool with zero security gates and zero audit trail.
 *
 * These tests prove:
 *   1. A call that requires a permission prompt (e.g. `execute`, whose
 *      default permission is `prompt`) is denied with `blocked: true`
 *      and a matching audit entry is written — there's no user on an
 *      HTTP wire to answer a readline prompt, so we fail closed.
 *   2. An `auto`-permission tool (e.g. `read_file`) still runs through
 *      the endpoint successfully, so the fix doesn't break the legit
 *      dashboard UX.
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

function makeStubProvider(): LLMProvider {
  return {
    name: 'stub',
    async *chat(): AsyncGenerator<AgentEvent> {
      yield { type: 'done' };
    },
  } as LLMProvider;
}

let portCounter = 15620;
function nextPort(): number { return portCounter++; }

describe('POST /api/command/tool/run — security gate chain', () => {
  let server: DashboardServer | null = null;
  let agent: Agent | null = null;
  let fixtureDir: string | null = null;

  afterEach(async () => {
    if (server && server.isRunning()) await server.stop();
    server = null;
    if (fixtureDir && fs.existsSync(fixtureDir)) {
      try { fs.rmSync(fixtureDir, { recursive: true }); } catch { /* ignore */ }
    }
    fixtureDir = null;
    agent = null;
  });

  async function startServer(): Promise<{ port: number; token: string }> {
    fixtureDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-tool-run-'));
    // A readable fixture file for the read_file happy-path test
    fs.writeFileSync(path.join(fixtureDir, 'hello.txt'), 'hello from fixture\n');

    // Match real dashboard usage: autoApprove=true. CORD issues CHALLENGE
    // for almost every action by design (it wants a human on the prompt),
    // so without autoApprove the dashboard would fail-closed on harmless
    // tools too. autoApprove skips the permission gate for CHALLENGE but
    // NOT for CORD BLOCK / SPARK CHALLENGE / policy / capability — the
    // layers this test actually cares about.
    agent = new Agent({
      provider: makeStubProvider(),
      model: 'stub-model',
      providerName: 'stub',
      projectRoot: fixtureDir,
      autoApprove: true,
    });

    const port = nextPort();
    server = new DashboardServer({ port });
    registerCommandRoutes(server, agent);
    await server.start();
    return { port, token: server.getAuthToken() };
  }

  it('blocks a dangerous `execute` call and writes an audit entry', async () => {
    const { port, token } = await startServer();
    const sessionId = agent!.getAuditLogger().getSessionId();

    const res = await request(
      `http://127.0.0.1:${port}/api/command/tool/run`,
      'POST',
      token,
      { tool: 'execute', args: { command: 'rm -rf /' } },
    );

    // Endpoint responds 200 with structured block outcome — NOT 500,
    // NOT a successful execution.
    assert.strictEqual(res.status, 200, `expected 200, got ${res.status}: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.strictEqual(body.is_error, true, `expected is_error: true, got body=${JSON.stringify(body)}`);
    assert.strictEqual(body.blocked, true, `expected blocked: true, got body=${JSON.stringify(body)}`);
    // Result should be the safety-policy message, not shell output.
    assert.ok(
      /blocked|policy|permission/i.test(String(body.result)),
      `expected block message in result, got: ${body.result}`,
    );

    // An audit entry MUST exist for this session tagged with a
    // deny/block action. This is the whole point of the fix — the old
    // code path wrote nothing.
    const entries = agent!.getAuditLogger().query({ sessionId });
    const blockEntries = entries.filter(e =>
      e.tool === 'execute' &&
      (e.action === 'deny' ||
       e.action === 'constitutional_block' ||
       e.action === 'policy_block' ||
       e.action === 'security_block'),
    );
    assert.ok(
      blockEntries.length > 0,
      `expected ≥1 block audit entry for execute, got entries=${JSON.stringify(entries.map(e => ({ tool: e.tool, action: e.action })))}`,
    );
  });

  it('allows a safe `read_file` call to pass through', async () => {
    const { port, token } = await startServer();

    const target = path.join(fixtureDir!, 'hello.txt');
    const res = await request(
      `http://127.0.0.1:${port}/api/command/tool/run`,
      'POST',
      token,
      { tool: 'read_file', args: { path: target } },
    );

    assert.strictEqual(res.status, 200, `expected 200, got ${res.status}: ${res.body}`);
    const body = JSON.parse(res.body);
    assert.strictEqual(
      body.blocked,
      false,
      `expected blocked: false for read_file, got body=${JSON.stringify(body)}`,
    );
    assert.strictEqual(
      body.is_error,
      false,
      `expected is_error: false for read_file, got body=${JSON.stringify(body)}`,
    );
    assert.ok(
      String(body.result).includes('hello from fixture'),
      `expected file contents in result, got: ${body.result}`,
    );
  });

  it('returns 404 for an unknown tool (preserves pre-fix shape)', async () => {
    const { port, token } = await startServer();
    const res = await request(
      `http://127.0.0.1:${port}/api/command/tool/run`,
      'POST',
      token,
      { tool: 'no_such_tool_exists', args: {} },
    );
    assert.strictEqual(res.status, 404, `expected 404, got ${res.status}: ${res.body}`);
  });

  // ── Skill bypass (reviewer-flagged P1) ──
  //
  // Skill tools are composite: their `execute()` runs a pipeline of
  // inner tool calls. Before this patch the inner-step callback called
  // `t.execute(args)` directly, so a skill step running `execute`,
  // `write_file`, etc. bypassed every gate on that inner step — a
  // variant of the same bypass as the outer endpoint.
  //
  // Two layers close this: (a) block skill_* on the HTTP endpoint, (b)
  // route the inner-step callback through runSingleTool so the gate
  // chain replays for every step when invoked autonomously.

  it('rejects skill_* invocations with 403 on /api/command/tool/run', async () => {
    const { port, token } = await startServer();
    // `standup-summary` is a built-in skill, always registered.
    const toolName = 'skill_standup-summary';
    assert.ok(
      agent!.getToolRegistry().get(toolName),
      'expected skill_standup-summary to be registered (built-in)',
    );

    const res = await request(
      `http://127.0.0.1:${port}/api/command/tool/run`,
      'POST',
      token,
      { tool: toolName, args: { channel: '#test' } },
    );
    assert.strictEqual(res.status, 403, `expected 403, got ${res.status}: ${res.body}`);
    assert.match(
      res.body,
      /skill/i,
      `expected error body to mention skills, got: ${res.body}`,
    );
  });

  it('skill inner steps replay the gate chain — each step writes an audit entry', async () => {
    // Isolate the CodeBot home so we can drop a fixture skill without
    // touching the user's ~/.codebot/skills. Must be set BEFORE the
    // Agent is constructed, because loadSkills() fires in the
    // constructor.
    const origHome = process.env.CODEBOT_HOME;
    const cbHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-home-'));
    process.env.CODEBOT_HOME = cbHome;
    fs.mkdirSync(path.join(cbHome, 'skills'), { recursive: true });

    // A minimal skill: one step that reads a fixture file. read_file is
    // permission:'auto' and does NOT hit a CORD hard-block, so the
    // inner step should pass through cleanly and — critically — go
    // through executeSingleTool which writes a read_file audit entry.
    // Pre-patch (`t.execute()` direct call) wrote no audit entry for
    // the inner step.
    const fixtureDirLocal = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-skill-'));
    const fixtureFile = path.join(fixtureDirLocal, 'note.txt');
    fs.writeFileSync(fixtureFile, 'skill-inner-step-reached\n');

    fs.writeFileSync(
      path.join(cbHome, 'skills', 'test-read.json'),
      JSON.stringify({
        name: 'test-read',
        description: 'Read a fixture file — test harness skill',
        parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
        steps: [{ tool: 'read_file', args: { path: '{{input.path}}' } }],
      }),
    );

    try {
      // Fresh agent so loadSkills() picks up the fixture skill.
      //
      // `constitutional.enabled: false` — CORD currently returns a
      // score-based BLOCK for any `skill_*` tool (score ~22, regardless
      // of inner step). With CORD on, the outer skill invocation would
      // never reach its inner steps, so we couldn't verify the
      // inner-step gate chain is now wired. That CORD aggressiveness
      // against skills is a separate issue tracked outside this PR.
      // Disabling CORD here isolates the test to exactly what this
      // patch changes: the inner-step callback writing audit entries.
      const localAgent = new Agent({
        provider: makeStubProvider(),
        model: 'stub-model',
        providerName: 'stub',
        projectRoot: fixtureDirLocal,
        autoApprove: true,
        constitutional: { enabled: false },
      });
      const sessionId = localAgent.getAuditLogger().getSessionId();

      const reg = localAgent.getToolRegistry();
      assert.ok(
        reg.get('skill_test-read'),
        `expected skill_test-read to be registered; got skills=${reg.all().map(t => t.name).filter(n => n.startsWith('skill_')).join(',')}`,
      );

      const outcome = await localAgent.runSingleTool(
        'skill_test-read',
        { path: fixtureFile },
        { interactivePrompt: true },
      );

      // Inner step should have passed through executeSingleTool, which
      // writes an audit entry for read_file. Pre-patch code wrote NONE
      // for inner steps.
      const entries = localAgent.getAuditLogger().query({ sessionId });
      const innerReadEntries = entries.filter(e => e.tool === 'read_file');
      assert.ok(
        innerReadEntries.length > 0,
        `expected ≥1 audit entry for inner read_file step, got entries=${JSON.stringify(entries.map(e => ({ tool: e.tool, action: e.action })))}; outcome=${JSON.stringify(outcome)}`,
      );

      // Sanity: the outer skill tool returned the inner result.
      assert.ok(
        String(outcome.result).includes('skill-inner-step-reached'),
        `expected outer skill result to contain inner read output, got: ${outcome.result}`,
      );
    } finally {
      if (origHome === undefined) delete process.env.CODEBOT_HOME;
      else process.env.CODEBOT_HOME = origHome;
      try { fs.rmSync(cbHome, { recursive: true }); } catch { /* ignore */ }
      try { fs.rmSync(fixtureDirLocal, { recursive: true }); } catch { /* ignore */ }
    }
  });
});
