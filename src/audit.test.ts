import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { AuditLogger } from './audit';

function makeTempDir(): string {
  const dir = path.join(os.tmpdir(), `codebot-audit-test-${Date.now()}-${Math.random().toString(36).substring(2, 6)}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

function cleanup(dir: string) {
  try { fs.rmSync(dir, { recursive: true }); } catch { /* ok */ }
}

describe('AuditLogger', () => {
  it('writes JSONL entries', () => {
    const dir = makeTempDir();
    try {
      const logger = new AuditLogger(dir);
      logger.log({ tool: 'read_file', action: 'execute', args: { path: '/foo.ts' }, result: 'success' });

      const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
      assert.ok(files.length > 0, 'Should create a log file');

      const content = fs.readFileSync(path.join(dir, files[0]), 'utf-8');
      const entry = JSON.parse(content.trim());
      assert.strictEqual(entry.tool, 'read_file');
      assert.strictEqual(entry.action, 'execute');
    } finally {
      cleanup(dir);
    }
  });

  it('includes all required fields including hash chain', () => {
    const dir = makeTempDir();
    try {
      const logger = new AuditLogger(dir);
      logger.log({ tool: 'write_file', action: 'execute', args: { path: '/bar.ts' } });

      const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
      const content = fs.readFileSync(path.join(dir, files[0]), 'utf-8');
      const entry = JSON.parse(content.trim());

      assert.ok(entry.timestamp, 'Should have timestamp');
      assert.ok(entry.sessionId, 'Should have sessionId');
      assert.strictEqual(entry.sequence, 1, 'First entry should be sequence 1');
      assert.strictEqual(entry.tool, 'write_file');
      assert.strictEqual(entry.action, 'execute');
      assert.ok(entry.args, 'Should have args');
      assert.strictEqual(entry.prevHash, 'genesis', 'First entry should reference genesis');
      assert.ok(entry.hash, 'Should have hash');
      assert.strictEqual(entry.hash.length, 64, 'Hash should be SHA-256 hex');
    } finally {
      cleanup(dir);
    }
  });

  it('masks secrets in args', () => {
    const dir = makeTempDir();
    try {
      const logger = new AuditLogger(dir);
      logger.log({
        tool: 'write_file',
        action: 'execute',
        args: { path: '/config.ts', content: 'api_key = AKIAIOSFODNN7EXAMPLE' },
      });

      const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
      const content = fs.readFileSync(path.join(dir, files[0]), 'utf-8');
      assert.ok(!content.includes('AKIAIOSFODNN7EXAMPLE'), 'Full secret should be masked in logs');
      assert.ok(content.includes('****'), 'Should contain mask characters');
    } finally {
      cleanup(dir);
    }
  });

  it('survives write errors without throwing', () => {
    const logger = new AuditLogger('/nonexistent/audit/path');
    assert.doesNotThrow(() => {
      logger.log({ tool: 'test', action: 'execute', args: {} });
    });
  });

  it('returns correct session ID', () => {
    const dir = makeTempDir();
    try {
      const logger = new AuditLogger(dir);
      const sessionId = logger.getSessionId();
      assert.ok(sessionId.length > 0, 'Session ID should not be empty');
      assert.ok(sessionId.includes('-'), 'Session ID should contain a dash');
    } finally {
      cleanup(dir);
    }
  });

  it('query returns logged entries', () => {
    const dir = makeTempDir();
    try {
      const logger = new AuditLogger(dir);
      logger.log({ tool: 'read_file', action: 'execute', args: { path: '/a.ts' } });
      logger.log({ tool: 'write_file', action: 'security_block', args: { path: '/etc/passwd' }, reason: 'blocked' });
      logger.log({ tool: 'edit_file', action: 'deny', args: { path: '/b.ts' } });

      const all = logger.query();
      assert.strictEqual(all.length, 3);

      const blocks = logger.query({ action: 'security_block' });
      assert.strictEqual(blocks.length, 1);
      assert.strictEqual(blocks[0].tool, 'write_file');
    } finally {
      cleanup(dir);
    }
  });

  it('builds a valid hash chain', () => {
    const dir = makeTempDir();
    try {
      const logger = new AuditLogger(dir);
      logger.log({ tool: 'read_file', action: 'execute', args: { path: '/a.ts' } });
      logger.log({ tool: 'write_file', action: 'execute', args: { path: '/b.ts' } });
      logger.log({ tool: 'execute', action: 'execute', args: { command: 'npm test' } });

      const entries = logger.query();
      assert.strictEqual(entries.length, 3);

      // Verify chain
      const result = AuditLogger.verify(entries);
      assert.strictEqual(result.valid, true, `Chain should be valid: ${result.reason}`);
      assert.strictEqual(result.entriesChecked, 3);
    } finally {
      cleanup(dir);
    }
  });

  it('detects tampered entries', () => {
    const dir = makeTempDir();
    try {
      const logger = new AuditLogger(dir);
      logger.log({ tool: 'read_file', action: 'execute', args: { path: '/a.ts' } });
      logger.log({ tool: 'write_file', action: 'execute', args: { path: '/b.ts' } });

      // Tamper with entries
      const entries = logger.query();
      entries[1].tool = 'TAMPERED'; // Modify the tool name

      const result = AuditLogger.verify(entries);
      assert.strictEqual(result.valid, false, 'Should detect tampering');
      assert.ok(result.reason?.includes('Hash mismatch') || result.reason?.includes('Chain break'),
        `Should explain failure: ${result.reason}`);
    } finally {
      cleanup(dir);
    }
  });

  it('detects chain breaks (deleted entries)', () => {
    const dir = makeTempDir();
    try {
      const logger = new AuditLogger(dir);
      logger.log({ tool: 'read_file', action: 'execute', args: { path: '/a.ts' } });
      logger.log({ tool: 'write_file', action: 'execute', args: { path: '/b.ts' } });
      logger.log({ tool: 'execute', action: 'execute', args: { command: 'ls' } });

      const entries = logger.query();
      // Remove middle entry (simulate deletion)
      const tampered = [entries[0], entries[2]];

      const result = AuditLogger.verify(tampered);
      assert.strictEqual(result.valid, false, 'Should detect missing entry');
    } finally {
      cleanup(dir);
    }
  });

  it('verifySession returns valid for current session', () => {
    const dir = makeTempDir();
    try {
      const logger = new AuditLogger(dir);
      logger.log({ tool: 'read_file', action: 'execute', args: {} });
      logger.log({ tool: 'write_file', action: 'execute', args: {} });

      const result = logger.verifySession();
      assert.strictEqual(result.valid, true);
      assert.strictEqual(result.entriesChecked, 2);
    } finally {
      cleanup(dir);
    }
  });

  it('increments sequence numbers correctly', () => {
    const dir = makeTempDir();
    try {
      const logger = new AuditLogger(dir);
      logger.log({ tool: 'a', action: 'execute', args: {} });
      logger.log({ tool: 'b', action: 'execute', args: {} });
      logger.log({ tool: 'c', action: 'execute', args: {} });

      const entries = logger.query();
      assert.strictEqual(entries[0].sequence, 1);
      assert.strictEqual(entries[1].sequence, 2);
      assert.strictEqual(entries[2].sequence, 3);
    } finally {
      cleanup(dir);
    }
  });

  /**
   * Honesty-pass addition (2026-04-25): explicitly stress-test the
   * verifier against the audit-action union as it stands TODAY,
   * including the actions added by PRs 5/6 (router:switch /
   * router:fallback / budget_block / budget_warning).
   *
   * §12 of personal-agent-infrastructure.md commits to "audit-chain
   * integrity verified in CI on every test session." This test is
   * the concrete CI enforcement of that commitment — it runs as part
   * of `node --test`, so every CI matrix run hits it.
   *
   * If a future PR adds a new audit action that breaks the verifier,
   * this test fails loudly. If a future PR weakens the verifier
   * (e.g. silently passes tampered chains), the tamper sub-tests fail.
   */
  it('verifies hash chain across the FULL action union (every audit action type)', () => {
    const dir = makeTempDir();
    try {
      const logger = new AuditLogger(dir);
      // One representative entry per action in the union (audit.ts).
      logger.log({ tool: 'read_file', action: 'execute', args: { path: '/a' } });
      logger.log({ tool: 'edit_file', action: 'deny', args: {}, reason: 'user said no' });
      logger.log({ tool: 'execute', action: 'error', args: {}, reason: 'ENOENT' });
      logger.log({ tool: 'edit_file', action: 'security_block', args: {}, reason: 'CWD escape' });
      logger.log({ tool: 'write_file', action: 'policy_block', args: {}, reason: 'denied by policy' });
      logger.log({ tool: 'execute', action: 'capability_block', args: {}, reason: 'shell allowlist' });
      logger.log({ tool: 'edit_file', action: 'constitutional_block', args: {}, reason: 'CORD veto' });
      logger.log({ tool: 'execute', action: 'exec_start', args: { cmd: 'ls' } });
      logger.log({ tool: 'execute', action: 'exec_complete', args: {}, result: 'exit 0' });
      logger.log({ tool: 'execute', action: 'exec_error', args: {}, reason: 'spawn failed' });
      // PR 5 additions
      logger.log({ tool: 'router', action: 'switch', args: { tier: 'reasoning', from: 'sonnet', to: 'opus' } });
      logger.log({ tool: 'router', action: 'fallback', args: { tier: 'fast', desiredFamily: 'openai' }, reason: 'cross-provider' });
      // PR 6 additions
      logger.log({ tool: 'budget', action: 'budget_warning', args: { threshold: 0.5, ratio: 0.6 } });
      logger.log({ tool: 'budget', action: 'budget_block', args: { totalCostUsd: 1.06, effectiveCapUsd: 1.0 } });

      const result = logger.verifySession();
      assert.strictEqual(result.valid, true,
        `verifier rejected a clean chain across full action union: ${result.reason}`);
      assert.strictEqual(result.entriesChecked, 14);
    } finally {
      cleanup(dir);
    }
  });

  it('verifier catches tampering on a router:switch entry mid-chain', () => {
    // The recently-added action types must be subject to the same
    // tamper detection as the legacy ones. Pin that explicitly.
    const dir = makeTempDir();
    try {
      const logger = new AuditLogger(dir);
      logger.log({ tool: 'read_file', action: 'execute', args: { path: '/a' } });
      logger.log({ tool: 'router', action: 'switch', args: { tier: 'reasoning', from: 'sonnet', to: 'opus' } });
      logger.log({ tool: 'execute', action: 'execute', args: { cmd: 'ls' } });

      // Tamper the router entry's args after the fact.
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
      const file = path.join(dir, files[0]);
      const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
      const tamperedLine = lines[1].replace('"to":"opus"', '"to":"haiku"');
      lines[1] = tamperedLine;
      fs.writeFileSync(file, lines.join('\n') + '\n');

      const reloaded = new AuditLogger(dir);
      const result = reloaded.verifySession(logger.getSessionId());
      assert.strictEqual(result.valid, false,
        'verifier must catch tampering on a router:switch entry');
      assert.strictEqual(result.firstInvalidAt, 2);
    } finally {
      cleanup(dir);
    }
  });

  it('verifier catches tampering on a budget_block entry', () => {
    const dir = makeTempDir();
    try {
      const logger = new AuditLogger(dir);
      logger.log({ tool: 'execute', action: 'execute', args: { cmd: 'a' } });
      logger.log({ tool: 'budget', action: 'budget_block', args: { totalCostUsd: 1.5, effectiveCapUsd: 1.0 } });
      logger.log({ tool: 'execute', action: 'execute', args: { cmd: 'b' } });

      const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
      const file = path.join(dir, files[0]);
      const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
      // Try to make it look like the budget cap was higher than it was
      lines[1] = lines[1].replace('"effectiveCapUsd":1', '"effectiveCapUsd":10');
      fs.writeFileSync(file, lines.join('\n') + '\n');

      const reloaded = new AuditLogger(dir);
      const result = reloaded.verifySession(logger.getSessionId());
      assert.strictEqual(result.valid, false,
        'verifier must catch tampering on a budget_block entry');
    } finally {
      cleanup(dir);
    }
  });

  it('verifier handles a multi-session log file (each session checked independently)', () => {
    // Real prod logs interleave entries from multiple sessions in a
    // single day's file. Each session has its own hash chain. This
    // test pins that verifySession(sessionId) only checks the matching
    // session's entries and is unaffected by other sessions in the
    // file — even if those other sessions are tampered.
    const dir = makeTempDir();
    try {
      // Two loggers writing to the same dir = two sessions in one file.
      const a = new AuditLogger(dir);
      const b = new AuditLogger(dir);
      a.log({ tool: 'read_file', action: 'execute', args: {} });
      b.log({ tool: 'edit_file', action: 'execute', args: {} });
      a.log({ tool: 'execute', action: 'execute', args: {} });
      b.log({ tool: 'execute', action: 'execute', args: {} });
      a.log({ tool: 'router', action: 'switch', args: { tier: 'fast' } });

      // Verify both before tampering
      const aBefore = a.verifySession();
      const bBefore = b.verifySession();
      assert.strictEqual(aBefore.valid, true);
      assert.strictEqual(bBefore.valid, true);
      assert.strictEqual(aBefore.entriesChecked, 3);
      assert.strictEqual(bBefore.entriesChecked, 2);

      // Tamper b's first entry only.
      const files = fs.readdirSync(dir).filter(f => f.endsWith('.jsonl'));
      const file = path.join(dir, files[0]);
      const content = fs.readFileSync(file, 'utf-8');
      const tampered = content.replace('"tool":"edit_file"', '"tool":"write_file"');
      fs.writeFileSync(file, tampered);

      // a should still be valid; b should be invalid.
      const aAfter = new AuditLogger(dir).verifySession(a.getSessionId());
      const bAfter = new AuditLogger(dir).verifySession(b.getSessionId());
      assert.strictEqual(aAfter.valid, true,
        'session a is unaffected by tampering in session b');
      assert.strictEqual(bAfter.valid, false,
        'session b verifier catches its own tampering');
    } finally {
      cleanup(dir);
    }
  });

  it('verifies a 100-entry chain end-to-end (bulk regression)', () => {
    // §12 commits to "audit-chain integrity verified on every test
    // session" — exercise it at scale. If the verifier ever has an
    // O(n^2) bug or an off-by-one in sequence handling, this test
    // catches it.
    const dir = makeTempDir();
    try {
      const logger = new AuditLogger(dir);
      const actions: Array<'execute' | 'switch' | 'budget_warning'> = [
        'execute', 'switch', 'budget_warning',
      ];
      for (let i = 0; i < 100; i++) {
        logger.log({
          tool: i % 3 === 0 ? 'router' : i % 3 === 1 ? 'budget' : 'execute',
          action: actions[i % 3],
          args: { i },
        });
      }
      const result = logger.verifySession();
      assert.strictEqual(result.valid, true, `100-entry chain rejected: ${result.reason}`);
      assert.strictEqual(result.entriesChecked, 100);
    } finally {
      cleanup(dir);
    }
  });
});
