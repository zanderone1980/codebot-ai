/**
 * Cursor CLI provider tests.
 *
 * We never spawn the real `agent` binary in tests — that would require a
 * CURSOR_API_KEY and burn real Cursor credits. Instead, we point the
 * provider at a fake Node script (written to a tempfile per-test) that
 * prints fixture stream-json lines to stdout and exits. The parser is
 * the thing under test, not Cursor's runtime.
 */

import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { CodingAgentRegistry } from './registry';
import { CursorCliAgentProvider } from './cursor-cli';
import { VaultManager } from '../vault';
import { AuditLogger } from '../audit';
import { makeTestVaultPath } from '../test-vault-isolation';
import { makeTestAuditDir } from '../test-audit-isolation';
import type { TaskSpec, TaskEvent } from './types';

let codebotHome: string;
let prevHome: string | undefined;
let scratchDir: string;

before(() => {
  codebotHome = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-test-cursor-cli-'));
  prevHome = process.env.CODEBOT_HOME;
  process.env.CODEBOT_HOME = codebotHome;
  scratchDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cb-cursor-cwd-'));
});

after(() => {
  if (prevHome === undefined) delete process.env.CODEBOT_HOME;
  else process.env.CODEBOT_HOME = prevHome;
  try { fs.rmSync(codebotHome, { recursive: true, force: true }); } catch { /* noop */ }
  try { fs.rmSync(scratchDir, { recursive: true, force: true }); } catch { /* noop */ }
});

/** Write a fake `agent` script that prints `lines` then exits with `code`. */
function makeFakeAgent(lines: string[], code = 0, sleepMs = 0): string {
  const script = `#!/usr/bin/env node
const lines = ${JSON.stringify(lines)};
const sleepMs = ${sleepMs};
async function run() {
  for (const l of lines) {
    process.stdout.write(l + '\\n');
    if (sleepMs > 0) await new Promise(r => setTimeout(r, sleepMs));
  }
  process.exit(${code});
}
run();
`;
  const file = path.join(scratchDir, `fake-agent-${Date.now()}-${Math.random().toString(36).slice(2)}.js`);
  fs.writeFileSync(file, script, { mode: 0o755 });
  return file;
}

function makeSpec(overrides: Partial<TaskSpec> = {}): TaskSpec {
  return {
    provider: 'cursor-cli',
    title: 'demo',
    prompt: 'fix the bug',
    cwd: scratchDir,
    permissions: { allow: ['read-only', 'write-fs', 'run-cmd'] },
    ...overrides,
  };
}

async function drain(events: AsyncIterable<TaskEvent>): Promise<TaskEvent[]> {
  const out: TaskEvent[] = [];
  for await (const e of events) out.push(e);
  return out;
}

function setupRegistry(binary: string, audit?: AuditLogger): { reg: CodingAgentRegistry; audit: AuditLogger } {
  const a = audit ?? new AuditLogger(makeTestAuditDir());
  const vault = new VaultManager({ vaultPath: makeTestVaultPath() });
  vault.set('cursor', {
    type: 'api_key',
    value: 'fake-api-key-for-tests',
    metadata: { provider: 'cursor', created: new Date().toISOString() },
  });
  const reg = new CodingAgentRegistry(vault, a);
  reg.register(new CursorCliAgentProvider({ cursorBinary: 'node', audit: a }));
  // Trick: we can't easily inject extra args, so the binary is `node` and we
  // override by passing the script path in spec.prompt? No — prompt becomes a
  // CLI arg. Instead we override binary directly to the script path itself.
  // Re-register with the actual binary path:
  (reg as unknown as { providers: Map<string, CursorCliAgentProvider> }).providers.set(
    'cursor-cli',
    new CursorCliAgentProvider({ cursorBinary: binary, audit: a }),
  );
  return { reg, audit: a };
}

describe('CursorCliAgentProvider — validation', () => {
  it('rejects missing prompt / title / cwd', () => {
    const p = new CursorCliAgentProvider();
    assert.match(p.validateSpec(makeSpec({ title: '' }))!, /title is required/);
    assert.match(p.validateSpec(makeSpec({ prompt: '' }))!, /prompt is required/);
    assert.match(p.validateSpec(makeSpec({ cwd: '' }))!, /cwd is required/);
  });

  it('rejects nonexistent cwd', () => {
    const p = new CursorCliAgentProvider();
    const r = p.validateSpec(makeSpec({ cwd: '/no/such/path/here-cb-test' }));
    assert.match(r!, /cwd does not exist/);
  });

  it('accepts a valid spec', () => {
    const p = new CursorCliAgentProvider();
    assert.strictEqual(p.validateSpec(makeSpec()), null);
  });
});

describe('CursorCliAgentProvider — credentials', () => {
  it('refuses to start without a vault credential', async () => {
    const vault = new VaultManager({ vaultPath: makeTestVaultPath() });
    // Note: no vault.set('cursor', ...) — credential resolution returns null.
    const reg = new CodingAgentRegistry(vault);
    reg.register(new CursorCliAgentProvider({ cursorBinary: 'node' }));
    await assert.rejects(() => reg.submit(makeSpec()), /CURSOR_API_KEY/);
  });
});

describe('CursorCliAgentProvider — stream-json parser', () => {
  it('maps assistant rows to output events', async () => {
    const fake = makeFakeAgent([
      JSON.stringify({ type: 'system', subtype: 'init' }),
      JSON.stringify({ type: 'assistant', text: 'thinking about the bug' }),
      JSON.stringify({ type: 'result', ok: true, summary: 'done', tokens: 100 }),
    ]);
    const { reg } = setupRegistry(fake);
    const handle = await reg.submit(makeSpec());
    const events = await drain(handle.events());
    const types = events.map(e => e.type);
    assert.deepStrictEqual(types, ['status', 'output', 'result']);
    const out = events[1];
    if (out.type !== 'output') throw new Error('expected output');
    assert.strictEqual(out.text, 'thinking about the bug');
    assert.strictEqual(handle.status(), 'succeeded');
  });

  it('maps tool_call edit_file rows to file_change(modify)', async () => {
    const fake = makeFakeAgent([
      JSON.stringify({ type: 'tool_call', tool: 'edit_file', args: { path: 'src/foo.ts' }, ok: true }),
      JSON.stringify({ type: 'tool_call', tool: 'create_file', args: { path: 'NEW.md' }, ok: true }),
      JSON.stringify({ type: 'tool_call', tool: 'delete_file', args: { path: 'old.txt' }, ok: true }),
      JSON.stringify({ type: 'result', ok: true, summary: 'wrote 3 files' }),
    ]);
    const { reg } = setupRegistry(fake);
    const handle = await reg.submit(makeSpec());
    const events = await drain(handle.events());
    const fcs = events.filter(e => e.type === 'file_change');
    assert.strictEqual(fcs.length, 3);
    assert.deepStrictEqual(
      fcs.map(e => (e.type === 'file_change' ? [e.path, e.op] : null)),
      [['src/foo.ts', 'modify'], ['NEW.md', 'create'], ['old.txt', 'delete']],
    );
  });

  it('maps generic tool_call to command event with exitCode from ok flag', async () => {
    const fake = makeFakeAgent([
      JSON.stringify({ type: 'tool_call', tool: 'shell', args: { command: 'npm test' }, ok: true }),
      JSON.stringify({ type: 'tool_call', tool: 'shell', args: { command: 'npm lint' }, ok: false }),
      JSON.stringify({ type: 'result', ok: false, summary: 'lint failed' }),
    ]);
    const { reg } = setupRegistry(fake);
    const handle = await reg.submit(makeSpec());
    const events = await drain(handle.events());
    const cmds = events.filter(e => e.type === 'command');
    assert.strictEqual(cmds.length, 2);
    assert.strictEqual((cmds[0] as { command: string; exitCode: number }).command, 'npm test');
    assert.strictEqual((cmds[0] as { command: string; exitCode: number }).exitCode, 0);
    assert.strictEqual((cmds[1] as { command: string; exitCode: number }).exitCode, 1);
    assert.strictEqual(handle.status(), 'failed');
  });

  it('budget cap flips ok=true to ok=false when tokens exceed cap', async () => {
    const fake = makeFakeAgent([
      JSON.stringify({ type: 'result', ok: true, summary: 'fine', tokens: 5000 }),
    ]);
    const { reg } = setupRegistry(fake);
    const handle = await reg.submit(
      makeSpec({ permissions: { allow: ['read-only'], budget: { tokens: 1000 } } }),
    );
    const events = await drain(handle.events());
    const result = events.find(e => e.type === 'result');
    if (!result || result.type !== 'result') throw new Error('expected result');
    assert.strictEqual(result.ok, false);
    assert.match(result.summary, /BUDGET EXCEEDED: 5000 > 1000 tokens/);
    assert.strictEqual(handle.status(), 'failed');
  });

  it('synthesizes a result event when CLI exits without one', async () => {
    const fake = makeFakeAgent(
      [JSON.stringify({ type: 'assistant', text: 'partial' })],
      1, // non-zero exit, no result row
    );
    const { reg } = setupRegistry(fake);
    const handle = await reg.submit(makeSpec());
    const events = await drain(handle.events());
    const result = events.find(e => e.type === 'result');
    if (!result || result.type !== 'result') throw new Error('expected synthesized result');
    assert.strictEqual(result.ok, false);
    assert.match(result.summary, /exited 1 without result row/);
    assert.strictEqual(handle.status(), 'failed');
  });

  it('handles split JSON lines across stdout chunks (carry-over buffer)', async () => {
    // Emit a long assistant text broken into halves on either side of a chunk
    // boundary. The parser must wait for the newline before parsing.
    const long = JSON.stringify({ type: 'assistant', text: 'x'.repeat(2000) });
    const fake = makeFakeAgent([long, JSON.stringify({ type: 'result', ok: true, summary: 'ok' })], 0, 5);
    const { reg } = setupRegistry(fake);
    const handle = await reg.submit(makeSpec());
    const events = await drain(handle.events());
    const out = events.find(e => e.type === 'output');
    if (!out || out.type !== 'output') throw new Error('expected output');
    assert.strictEqual(out.text.length, 2000);
    assert.strictEqual(handle.status(), 'succeeded');
  });

  it('emits a log event for unparseable stream-json lines', async () => {
    // Build the script by hand so we can write a malformed line directly.
    const file = path.join(scratchDir, `fake-agent-bad-${Date.now()}.js`);
    fs.writeFileSync(
      file,
      `#!/usr/bin/env node
process.stdout.write('not valid json\\n');
process.stdout.write(${JSON.stringify(JSON.stringify({ type: 'result', ok: true, summary: 'ok' }))} + '\\n');
process.exit(0);
`,
      { mode: 0o755 },
    );
    const { reg } = setupRegistry(file);
    const handle = await reg.submit(makeSpec());
    const events = await drain(handle.events());
    const warn = events.find(e => e.type === 'log' && e.level === 'warn');
    if (!warn || warn.type !== 'log') throw new Error('expected warn log for bad JSON');
    assert.match(warn.message, /unparseable stream-json/);
    // Subsequent valid line still parses.
    const result = events.find(e => e.type === 'result');
    assert.ok(result, 'parser should recover after a bad line');
  });
});

describe('CursorCliAgentProvider — audit chain', () => {
  it('writes task_start, task_event*, task_complete rows on success', async () => {
    const audit = new AuditLogger(makeTestAuditDir());
    const fake = makeFakeAgent([
      JSON.stringify({ type: 'assistant', text: 'hi' }),
      JSON.stringify({ type: 'result', ok: true, summary: 'done' }),
    ]);
    const { reg } = setupRegistry(fake, audit);
    const handle = await reg.submit(makeSpec({ title: 'audit-test' }));
    await drain(handle.events());

    const start = audit.query({ action: 'task_start' });
    const events = audit.query({ action: 'task_event' });
    const complete = audit.query({ action: 'task_complete' });

    assert.strictEqual(start.length, 1);
    assert.strictEqual(start[0].tool, 'coding-agent:cursor-cli');
    // status (running) + output rows = at least 2 task_event rows
    assert.ok(events.length >= 2, `expected >=2 task_event rows, got ${events.length}`);
    assert.strictEqual(complete.length, 1);

    // Hash chain verifies clean.
    const verify = audit.verifySession();
    assert.strictEqual(verify.valid, true, verify.reason);
  });
});
