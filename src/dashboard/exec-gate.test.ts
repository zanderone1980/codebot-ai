import { describe, it, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DashboardServer } from './server';
import { registerCommandRoutes } from './command-api';
import { Agent } from '../agent';
import { ExecuteTool } from '../tools/execute';
import type { LLMProvider, AgentEvent } from '../types';
import { makeTestAuditDir } from '../test-audit-isolation';

/**
 * Acceptance tests for the POST /api/command/exec gate-chain fix
 * (2026-04-24 SECURITY).
 *
 * Before this fix the endpoint parsed a body, ran a regex pre-check, and
 * spawned `sh -c <command>` directly — bypassing schema validation,
 * policy allow-list, risk scoring, CORD, SPARK, capability, permission,
 * AuditLogger, isCwdSafe containment, and sandbox routing. A dashboard-
 * token holder could run arbitrary shell commands with zero audit trail.
 *
 * The fix routes the endpoint through Agent.runStreamingTool →
 * ExecuteTool.stream. Gate chain runs at the Agent layer; preflight
 * (patterns + cwd + sandbox) runs again inside the tool. Audit entries
 * written: exec_start (allow evidence), exec_complete (exit + tails) or
 * exec_error (sandbox_required, spawn_error, etc.).
 *
 * Required coverage:
 *   1. dangerous command blocked, audited (inline-regex 403 now writes
 *      a `policy_block` audit entry in agent-backed mode), no stdout
 *   2. safe command streams stdout + exit 0, audits exec_start + exec_complete
 *   3. cwd outside project blocked
 *   4. sandbox-required streaming returns 501 and writes exec_error, no host spawn
 *   5. standalone agent=null still streams with init {mode:'standalone', guarded:false} and keeps regex block
 *   6. ExecuteTool preflight parity for accepted/rejected cases
 *   7. fine-grained capability check blocks streaming for disallowed
 *      shell_commands prefix (mirrors the buffered path's capability
 *      gate — /api/command/exec must not bypass it)
 */

function sseRequest(
  url: string,
  token: string,
  body: unknown,
): Promise<{ status: number; events: Array<Record<string, unknown>>; raw: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
      Accept: 'text/event-stream',
    };
    const req = http.request(url, { method: 'POST', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (chunk: Buffer) => chunks.push(chunk));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf-8');
        const events: Array<Record<string, unknown>> = [];
        if (res.headers['content-type']?.includes('text/event-stream')) {
          for (const block of raw.split('\n\n')) {
            const dataLine = block.split('\n').find((l) => l.startsWith('data: '));
            if (!dataLine) continue;
            try { events.push(JSON.parse(dataLine.slice(6))); } catch { /* skip */ }
          }
        }
        resolve({ status: res.statusCode || 0, events, raw });
      });
    });
    req.on('error', reject);
    req.write(JSON.stringify(body));
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

let portCounter = 15720;
function nextPort(): number { return portCounter++; }

describe('POST /api/command/exec — gate chain', () => {
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

  async function startServer(
    overrides: { agentless?: boolean; policy?: Record<string, unknown> } = {},
  ): Promise<{ port: number; token: string; sessionId: string | null }> {
    // Realpath the tmp dir — on macOS, `/var/folders/...` is a symlink
    // to `/private/var/folders/...`, and isCwdSafe compares the
    // *realpath* of a cwd to the *non-realpath* projectRoot. If we
    // don't resolve the symlink here, ExecuteTool rejects its own
    // default cwd as unsafe.
    fixtureDir = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-exec-gate-')),
    );

    if (overrides.policy) {
      fs.mkdirSync(path.join(fixtureDir, '.codebot'), { recursive: true });
      fs.writeFileSync(
        path.join(fixtureDir, '.codebot', 'policy.json'),
        JSON.stringify(overrides.policy, null, 2),
      );
    }

    let sessionId: string | null = null;
    if (!overrides.agentless) {
      // `constitutional.enabled: false` — CORD currently score-blocks
      // many benign `execute` commands based on string contents (e.g.
      // "echo hello-from-exec-stream" scores 11 → BLOCK regardless of
      // tool semantics). That's a separate CORD-tuning issue already
      // tracked outside this PR; disabling here isolates these tests
      // to exactly what this patch changes: the gate-chain wiring and
      // ExecuteTool streaming. Policy / capability / permission /
      // preflight still run. autoApprove matches production dashboard.
      agent = new Agent({
        auditDir: makeTestAuditDir(),
        provider: makeStubProvider(),
        model: 'stub-model',
        providerName: 'stub',
        projectRoot: fixtureDir,
        autoApprove: true,
        constitutional: { enabled: false },
      });
      sessionId = agent.getAuditLogger().getSessionId();
    }

    const port = nextPort();
    server = new DashboardServer({ port });
    registerCommandRoutes(server, agent);
    await server.start();
    return { port, token: server.getAuthToken(), sessionId };
  }

  // ── Test 1: dangerous command blocked, audited, no stdout ────────────
  it('blocks a dangerous command and writes a deny/block audit entry', async () => {
    const { port, token, sessionId } = await startServer();

    const res = await sseRequest(
      `http://127.0.0.1:${port}/api/command/exec`,
      token,
      { command: 'rm -rf /' },
    );

    // The inline regex pre-check returns a 403 JSON error before SSE
    // headers go out. That is the belt-and-suspenders layer: even if
    // the gate chain somehow allowed it, this wall catches it first.
    assert.strictEqual(res.status, 403, `expected 403, got ${res.status}: ${res.raw}`);
    assert.match(
      res.raw,
      /blocked|dangerous/i,
      `expected block message, got: ${res.raw}`,
    );
    // No stdout streamed under any circumstances.
    assert.ok(
      !res.events.some((e) => e.type === 'stdout'),
      `expected no stdout events on block, got events=${JSON.stringify(res.events)}`,
    );

    // Audit honesty: agent-backed mode now writes a `policy_block`
    // audit entry before returning the inline-regex 403. Without this
    // entry the PR claim "dangerous command blocked AND audited" is a
    // lie on the inline-wall code path. The entry must carry the
    // command so forensics can reconstruct what was attempted.
    const earlyEntries = agent!.getAuditLogger().query({ sessionId: sessionId! });
    const earlyBlocks = earlyEntries.filter(
      (e) => e.tool === 'execute' && e.action === 'policy_block',
    );
    assert.ok(
      earlyBlocks.length >= 1,
      `expected ≥1 policy_block audit entry for inline-regex 403, got entries=${JSON.stringify(earlyEntries.map((e) => ({ tool: e.tool, action: e.action })))}`,
    );
    assert.strictEqual(
      (earlyBlocks[0].args as { command?: string }).command,
      'rm -rf /',
      `expected audit entry to record the attempted command, got: ${JSON.stringify(earlyBlocks[0].args)}`,
    );

    // Gate-chain allow path: send a benign command that the inline
    // regex does NOT match, prove it reaches the tool and produces the
    // `exec_start` allow-evidence entry.
    const res2 = await sseRequest(
      `http://127.0.0.1:${port}/api/command/exec`,
      token,
      { command: 'echo via-gate-chain' },
    );
    assert.strictEqual(res2.status, 200, `expected 200 on allowed command, got ${res2.status}`);
    const entries = agent!.getAuditLogger().query({ sessionId: sessionId! });
    const execEntries = entries.filter((e) => e.tool === 'execute');
    assert.ok(
      execEntries.some((e) => e.action === 'exec_start'),
      `expected an exec_start audit entry for the allowed command, got ${JSON.stringify(execEntries.map((e) => ({ tool: e.tool, action: e.action })))}`,
    );
  });

  // ── Test 2: safe command streams + audits ─────────────────────────────
  it('streams a safe command, exits 0, writes exec_start + exec_complete', async () => {
    const { port, token, sessionId } = await startServer();

    const res = await sseRequest(
      `http://127.0.0.1:${port}/api/command/exec`,
      token,
      { command: 'echo hello-from-exec-stream' },
    );

    assert.strictEqual(res.status, 200, `expected 200, got ${res.status}: ${res.raw}`);

    const init = res.events.find((e) => e.type === 'init');
    assert.ok(init, `expected init event, got events=${JSON.stringify(res.events)}`);
    assert.strictEqual(init!.mode, 'agent');
    assert.strictEqual(init!.guarded, true);

    const stdout = res.events.filter((e) => e.type === 'stdout').map((e) => e.text).join('');
    assert.ok(
      stdout.includes('hello-from-exec-stream'),
      `expected stdout to contain fixture marker, got stdout=${JSON.stringify(stdout)}, all events=${JSON.stringify(res.events)}, raw=${JSON.stringify(res.raw.slice(0, 500))}`,
    );

    const exit = res.events.find((e) => e.type === 'exit');
    assert.ok(exit, `expected exit event, got events=${JSON.stringify(res.events)}`);
    assert.strictEqual(exit!.code, 0, `expected exit code 0, got ${exit!.code}`);

    // Audit: one exec_start (allow evidence) + one exec_complete.
    const entries = agent!.getAuditLogger().query({ sessionId: sessionId! });
    const execStart = entries.filter((e) => e.tool === 'execute' && e.action === 'exec_start');
    const execComplete = entries.filter((e) => e.tool === 'execute' && e.action === 'exec_complete');
    assert.strictEqual(
      execStart.length,
      1,
      `expected exactly 1 exec_start entry, got ${execStart.length}: ${JSON.stringify(execStart)}`,
    );
    assert.strictEqual(
      execComplete.length,
      1,
      `expected exactly 1 exec_complete entry, got ${execComplete.length}: ${JSON.stringify(execComplete)}`,
    );
    assert.match(
      String(execComplete[0].result),
      /exit:0/,
      `expected exec_complete result to tag exit:0, got: ${execComplete[0].result}`,
    );
    // Tail must be present and must not be full output dumped in.
    // Our fixture is "hello-from-exec-stream\n" — well under 512 bytes.
    assert.match(
      String(execComplete[0].reason),
      /stdout_tail=.*hello-from-exec-stream/,
      `expected stdout tail in reason, got: ${execComplete[0].reason}`,
    );
  });

  // ── Test 3: cwd outside project blocked ──────────────────────────────
  it('blocks a command whose cwd escapes the project root', async () => {
    const { port, token, sessionId } = await startServer();

    const res = await sseRequest(
      `http://127.0.0.1:${port}/api/command/exec`,
      token,
      { command: 'echo hi', cwd: '/etc' },
    );

    // Gate chain lets a policy-allowed command through; the tool's own
    // preflight catches the cwd escape and throws with code 'unsafe_cwd'.
    // runStreamingTool maps that to an error (500) SSE event.
    assert.strictEqual(res.status, 200, `expected 200 (SSE), got ${res.status}: ${res.raw}`);
    const err = res.events.find((e) => e.type === 'error');
    assert.ok(err, `expected an error event for unsafe_cwd, got events=${JSON.stringify(res.events)}`);
    assert.strictEqual(err!.errorCode, 'unsafe_cwd');
    assert.ok(
      !res.events.some((e) => e.type === 'stdout'),
      'must not stream any stdout when cwd is unsafe',
    );
    assert.ok(
      !res.events.some((e) => e.type === 'exit'),
      'must not emit an exit event — process never spawned',
    );

    const entries = agent!.getAuditLogger().query({ sessionId: sessionId! });
    const execError = entries.filter((e) => e.tool === 'execute' && e.action === 'exec_error');
    assert.ok(
      execError.length > 0,
      `expected ≥1 exec_error audit entry, got ${JSON.stringify(entries.map((e) => ({ tool: e.tool, action: e.action })))}`,
    );
    assert.match(
      String(execError[0].reason),
      /unsafe_cwd/,
      `expected unsafe_cwd in reason, got: ${execError[0].reason}`,
    );
  });

  // ── Test 4: sandbox-required streaming returns 501, no host spawn ────
  it('fails closed with 501 when policy requires sandbox for streaming exec', async () => {
    // validatePolicy() requires `version` as string (not number) — a
    // numeric version silently fails validation and the file is ignored.
    const { port, token, sessionId } = await startServer({
      policy: {
        version: '1',
        execution: { sandbox: 'docker' },
      },
    });

    const res = await sseRequest(
      `http://127.0.0.1:${port}/api/command/exec`,
      token,
      { command: 'echo must-not-reach-host' },
    );

    assert.strictEqual(res.status, 200, `expected 200 SSE framing, got ${res.status}: ${res.raw}`);
    const err = res.events.find((e) => e.type === 'error');
    assert.ok(err, `expected error event, got events=${JSON.stringify(res.events)}`);
    assert.strictEqual(err!.code, 501, `expected HTTP-mapped code 501, got ${err!.code}`);
    assert.strictEqual(err!.errorCode, 'sandbox_required');
    assert.match(
      String(err!.reason),
      /sandbox/i,
      `expected sandbox mention in reason, got: ${err!.reason}`,
    );
    assert.ok(
      !res.events.some((e) => e.type === 'stdout'),
      'must not stream any stdout — no host spawn allowed when sandbox required',
    );
    assert.ok(
      !res.events.some((e) => e.type === 'exit'),
      'must not emit exit — process never spawned',
    );

    const entries = agent!.getAuditLogger().query({ sessionId: sessionId! });
    const execError = entries.filter((e) => e.tool === 'execute' && e.action === 'exec_error');
    assert.ok(
      execError.length > 0,
      'expected exec_error audit entry for sandbox_required refusal',
    );
    assert.match(
      String(execError[0].reason),
      /sandbox_required/,
      `expected sandbox_required code in reason, got: ${execError[0].reason}`,
    );
  });

  // ── Test 5: standalone agent=null still streams, regex block intact ──
  it('standalone mode (agent=null) streams with guarded:false and keeps regex block', async () => {
    const { port, token } = await startServer({ agentless: true });

    // Safe command still streams end-to-end.
    const okRes = await sseRequest(
      `http://127.0.0.1:${port}/api/command/exec`,
      token,
      { command: 'echo standalone-path' },
    );
    assert.strictEqual(okRes.status, 200, `expected 200, got ${okRes.status}: ${okRes.raw}`);
    const init = okRes.events.find((e) => e.type === 'init');
    assert.ok(init, `expected init event, got events=${JSON.stringify(okRes.events)}`);
    assert.strictEqual(init!.mode, 'standalone');
    assert.strictEqual(init!.guarded, false);
    const stdout = okRes.events.filter((e) => e.type === 'stdout').map((e) => e.text).join('');
    assert.ok(
      stdout.includes('standalone-path'),
      `expected stdout to contain fixture marker, got: ${stdout}`,
    );

    // Dangerous command still blocked by the inline regex — standalone
    // mode has no gate chain to fall back to, so this wall is the only
    // defense and must not be removed.
    const badRes = await sseRequest(
      `http://127.0.0.1:${port}/api/command/exec`,
      token,
      { command: 'rm -rf /' },
    );
    assert.strictEqual(badRes.status, 403, `expected 403, got ${badRes.status}: ${badRes.raw}`);
    assert.ok(
      !badRes.events.some((e) => e.type === 'stdout'),
      'dangerous command must not stream anything in standalone mode',
    );
  });

  // ── Test 6: ExecuteTool preflight parity ─────────────────────────────
  it('ExecuteTool.preflight produces the same accept/reject decisions as execute()', async () => {
    // See startServer() comment on realpath — macOS tmpdir is a symlink
    // and isCwdSafe fails without resolving.
    const root = fs.realpathSync(
      fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-preflight-')),
    );
    try {
      const tool = new ExecuteTool(root);

      // Accepted — execute() must produce output; preflight must produce an ok:true plan.
      const okCases = [
        { command: 'echo parity-ok' },
        { command: 'true' },
      ];
      for (const args of okCases) {
        const pre = tool.preflight(args);
        assert.strictEqual(pre.ok, true, `preflight should accept: ${JSON.stringify(args)}`);
        const out = await tool.execute(args);
        assert.ok(
          !out.startsWith('Error:'),
          `execute() should not return Error: for ${JSON.stringify(args)}, got: ${out}`,
        );
      }

      // Rejected — blocked pattern: preflight returns code 'blocked_pattern';
      // execute() throws (historical contract preserved).
      const preBlock = tool.preflight({ command: 'rm -rf /' });
      assert.strictEqual(preBlock.ok, false);
      if (!preBlock.ok) {
        assert.strictEqual(preBlock.code, 'blocked_pattern');
      }
      await assert.rejects(
        () => tool.execute({ command: 'rm -rf /' }),
        /Blocked|dangerous/i,
        'execute() must throw for blocked patterns',
      );

      // Rejected — missing command: preflight 'bad_args'; execute returns Error:.
      const preBad = tool.preflight({});
      assert.strictEqual(preBad.ok, false);
      if (!preBad.ok) {
        assert.strictEqual(preBad.code, 'bad_args');
      }
      const badOut = await tool.execute({});
      assert.match(badOut, /^Error:/, 'execute() must return Error: string for missing command');

      // Rejected — unsafe cwd: preflight 'unsafe_cwd'; execute returns Error:.
      const preCwd = tool.preflight({ command: 'echo x', cwd: '/etc' });
      assert.strictEqual(preCwd.ok, false);
      if (!preCwd.ok) {
        assert.strictEqual(preCwd.code, 'unsafe_cwd');
      }
      const cwdOut = await tool.execute({ command: 'echo x', cwd: '/etc' });
      assert.match(cwdOut, /^Error:/, 'execute() must return Error: string for unsafe cwd');
    } finally {
      try { fs.rmSync(root, { recursive: true }); } catch { /* ignore */ }
    }
  });

  // ── Test 7: fine-grained capability check blocks streaming ──────────
  //
  // The buffered tool runner (`executeSingleTool`) calls
  // `checkToolCapabilities` after `_prepareToolCall`. The streaming path
  // (`runStreamingTool`) must do the same, otherwise a policy that
  // restricts execute.shell_commands to e.g. 'npm' would block
  // `git status` via `runSingleTool` but let it stream through
  // /api/command/exec. This test proves the capability gate is enforced
  // on the streaming path and the block is audited as `capability_block`.
  it('blocks streaming exec when command prefix is outside capability allow-list', async () => {
    const { port, token, sessionId } = await startServer({
      policy: {
        version: '1',
        tools: {
          capabilities: {
            execute: {
              // Only `echo` prefix is allowed. The gate chain's policy
              // allow-list is empty (= all tools enabled), inline
              // BLOCKED_PATTERNS does not match `ls`, and CORD is
              // disabled in startServer(). The ONLY thing standing
              // between `ls /tmp` and a host spawn is the capability
              // check inside runStreamingTool.
              shell_commands: ['echo'],
            },
          },
        },
      },
    });

    // Allowed prefix — must reach the tool and stream.
    const okRes = await sseRequest(
      `http://127.0.0.1:${port}/api/command/exec`,
      token,
      { command: 'echo capability-allowed' },
    );
    assert.strictEqual(okRes.status, 200, `expected 200, got ${okRes.status}: ${okRes.raw}`);
    const okExit = okRes.events.find((e) => e.type === 'exit');
    assert.ok(okExit, `expected exit event for allowed prefix, got: ${JSON.stringify(okRes.events)}`);
    assert.strictEqual(okExit!.code, 0);

    // Disallowed prefix — `ls` is not in shell_commands. Must be
    // blocked at the agent layer, must emit a blocked SSE event, must
    // NOT stream stdout, must NOT emit an exit event.
    const badRes = await sseRequest(
      `http://127.0.0.1:${port}/api/command/exec`,
      token,
      { command: 'ls /tmp' },
    );
    assert.strictEqual(badRes.status, 200, `expected 200 SSE, got ${badRes.status}: ${badRes.raw}`);
    const blocked = badRes.events.find((e) => e.type === 'blocked');
    assert.ok(
      blocked,
      `expected blocked SSE event for capability-denied command, got events=${JSON.stringify(badRes.events)}`,
    );
    assert.match(
      String(blocked!.reason),
      /shell_commands|cannot run|capability/i,
      `expected capability-shaped reason, got: ${blocked!.reason}`,
    );
    assert.ok(
      !badRes.events.some((e) => e.type === 'stdout'),
      'capability-blocked command must not stream any stdout',
    );
    assert.ok(
      !badRes.events.some((e) => e.type === 'exit'),
      'capability-blocked command must not spawn a process — no exit event',
    );

    // Audit — a `capability_block` entry for the execute tool with the
    // attempted command. No `exec_start` for the blocked command (that
    // would mean the block happened AFTER allow evidence was written,
    // which is wrong).
    const entries = agent!.getAuditLogger().query({ sessionId: sessionId! });
    const capBlocks = entries.filter(
      (e) => e.tool === 'execute' && e.action === 'capability_block',
    );
    assert.ok(
      capBlocks.length >= 1,
      `expected ≥1 capability_block audit entry, got ${JSON.stringify(entries.map((e) => ({ tool: e.tool, action: e.action })))}`,
    );
    const capBlock = capBlocks.find(
      (e) => (e.args as { command?: string }).command === 'ls /tmp',
    );
    assert.ok(
      capBlock,
      `expected capability_block entry for 'ls /tmp', got: ${JSON.stringify(capBlocks.map((e) => e.args))}`,
    );

    // No exec_start for the blocked command — allow evidence must not
    // precede a block.
    const starts = entries.filter(
      (e) =>
        e.tool === 'execute' &&
        e.action === 'exec_start' &&
        (e.args as { command?: string }).command === 'ls /tmp',
    );
    assert.strictEqual(
      starts.length,
      0,
      `exec_start must not be written for capability-blocked command, got ${JSON.stringify(starts)}`,
    );
  });
});
