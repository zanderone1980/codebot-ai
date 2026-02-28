import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { exportSarif, sarifToString } from './sarif';
import type { AuditEntry } from './audit';

function makeEntry(overrides: Partial<AuditEntry> = {}): AuditEntry {
  return {
    timestamp: '2024-01-15T10:00:00.000Z',
    sessionId: 'test-session',
    sequence: 1,
    tool: 'execute',
    action: 'security_block',
    args: { command: 'rm -rf /' },
    reason: 'Blocked destructive command',
    prevHash: 'genesis',
    hash: 'abc123',
    ...overrides,
  };
}

describe('SARIF Export', () => {
  // ── Basic Structure ──

  it('produces valid SARIF 2.1.0 structure', () => {
    const entries: AuditEntry[] = [makeEntry()];
    const sarif = exportSarif(entries);

    assert.strictEqual(sarif.version, '2.1.0');
    assert.ok(sarif.$schema.includes('sarif-schema-2.1.0'));
    assert.strictEqual(sarif.runs.length, 1);
    assert.strictEqual(sarif.runs[0].tool.driver.name, 'CodeBot');
    assert.ok(sarif.runs[0].tool.driver.rules.length > 0);
  });

  it('includes all 5 rule definitions', () => {
    const sarif = exportSarif([]);
    const rules = sarif.runs[0].tool.driver.rules;
    assert.strictEqual(rules.length, 5);

    const ruleIds = rules.map(r => r.id);
    assert.ok(ruleIds.includes('CB001'));
    assert.ok(ruleIds.includes('CB002'));
    assert.ok(ruleIds.includes('CB003'));
    assert.ok(ruleIds.includes('CB004'));
    assert.ok(ruleIds.includes('CB005'));
  });

  // ── Rule Mapping ──

  it('maps security_block to CB001 error', () => {
    const sarif = exportSarif([makeEntry({ action: 'security_block' })]);
    const result = sarif.runs[0].results[0];
    assert.strictEqual(result.ruleId, 'CB001');
    assert.strictEqual(result.level, 'error');
  });

  it('maps policy_block to CB002 warning', () => {
    const sarif = exportSarif([makeEntry({ action: 'policy_block' })]);
    const result = sarif.runs[0].results[0];
    assert.strictEqual(result.ruleId, 'CB002');
    assert.strictEqual(result.level, 'warning');
  });

  it('maps capability_block to CB003 warning', () => {
    const sarif = exportSarif([makeEntry({ action: 'capability_block' })]);
    const result = sarif.runs[0].results[0];
    assert.strictEqual(result.ruleId, 'CB003');
    assert.strictEqual(result.level, 'warning');
  });

  it('maps error to CB004 note', () => {
    const sarif = exportSarif([makeEntry({ action: 'error' })]);
    const result = sarif.runs[0].results[0];
    assert.strictEqual(result.ruleId, 'CB004');
    assert.strictEqual(result.level, 'note');
  });

  it('maps deny to CB005 note', () => {
    const sarif = exportSarif([makeEntry({ action: 'deny' })]);
    const result = sarif.runs[0].results[0];
    assert.strictEqual(result.ruleId, 'CB005');
    assert.strictEqual(result.level, 'note');
  });

  // ── Filtering ──

  it('excludes execute actions (not security-relevant)', () => {
    const entries: AuditEntry[] = [
      makeEntry({ action: 'execute', sequence: 1 }),
      makeEntry({ action: 'security_block', sequence: 2 }),
      makeEntry({ action: 'execute', sequence: 3 }),
    ];
    const sarif = exportSarif(entries);
    assert.strictEqual(sarif.runs[0].results.length, 1);
    assert.strictEqual(sarif.runs[0].results[0].ruleId, 'CB001');
  });

  it('handles empty entries', () => {
    const sarif = exportSarif([]);
    assert.strictEqual(sarif.runs[0].results.length, 0);
    assert.strictEqual(sarif.runs[0].invocations[0].executionSuccessful, true);
  });

  // ── File Locations ──

  it('includes artifact location from args.path', () => {
    const sarif = exportSarif([makeEntry({
      action: 'security_block',
      args: { path: '/home/user/.env' },
    })]);
    const result = sarif.runs[0].results[0];
    assert.ok(result.locations);
    assert.strictEqual(result.locations.length, 1);
    assert.strictEqual(result.locations[0].physicalLocation.artifactLocation.uri, '/home/user/.env');
  });

  it('includes artifact location from args.file', () => {
    const sarif = exportSarif([makeEntry({
      action: 'policy_block',
      args: { file: 'credentials.json' },
    })]);
    const result = sarif.runs[0].results[0];
    assert.ok(result.locations);
    assert.strictEqual(result.locations[0].physicalLocation.artifactLocation.uri, 'credentials.json');
  });

  it('omits locations when no file path in args', () => {
    const sarif = exportSarif([makeEntry({
      action: 'deny',
      args: { command: 'curl evil.com' },
    })]);
    const result = sarif.runs[0].results[0];
    assert.strictEqual(result.locations, undefined);
  });

  // ── Messages ──

  it('builds message with tool name and action', () => {
    const sarif = exportSarif([makeEntry({
      tool: 'write_file',
      action: 'security_block',
      reason: 'Path traversal detected',
    })]);
    const msg = sarif.runs[0].results[0].message.text;
    assert.ok(msg.includes('write_file'));
    assert.ok(msg.includes('security block'));
    assert.ok(msg.includes('Path traversal detected'));
  });

  // ── Invocations ──

  it('marks invocation as failed when errors present', () => {
    const sarif = exportSarif([makeEntry({ action: 'security_block' })]);
    assert.strictEqual(sarif.runs[0].invocations[0].executionSuccessful, false);
  });

  it('marks invocation as successful when only warnings/notes', () => {
    const sarif = exportSarif([
      makeEntry({ action: 'deny', sequence: 1 }),
      makeEntry({ action: 'policy_block', sequence: 2 }),
    ]);
    assert.strictEqual(sarif.runs[0].invocations[0].executionSuccessful, true);
  });

  it('includes session ID in invocation properties', () => {
    const sarif = exportSarif([], { sessionId: 'my-session' });
    const props = sarif.runs[0].invocations[0].properties;
    assert.ok(props);
    assert.strictEqual(props.sessionId, 'my-session');
  });

  // ── Options ──

  it('accepts custom version', () => {
    const sarif = exportSarif([], { version: '2.0.0' });
    assert.strictEqual(sarif.runs[0].tool.driver.version, '2.0.0');
  });

  it('uses entry timestamps for invocation times', () => {
    const entries: AuditEntry[] = [
      makeEntry({ timestamp: '2024-01-15T10:00:00Z', sequence: 1 }),
      makeEntry({ timestamp: '2024-01-15T10:05:00Z', sequence: 2, action: 'deny' }),
    ];
    const sarif = exportSarif(entries);
    assert.strictEqual(sarif.runs[0].invocations[0].startTimeUtc, '2024-01-15T10:00:00Z');
    assert.strictEqual(sarif.runs[0].invocations[0].endTimeUtc, '2024-01-15T10:05:00Z');
  });

  // ── Serialization ──

  it('sarifToString produces valid JSON', () => {
    const sarif = exportSarif([makeEntry()]);
    const str = sarifToString(sarif);
    const parsed = JSON.parse(str);
    assert.strictEqual(parsed.version, '2.1.0');
    assert.ok(parsed.runs);
  });

  it('sarifToString produces formatted output', () => {
    const sarif = exportSarif([]);
    const str = sarifToString(sarif);
    assert.ok(str.includes('\n'), 'Should be formatted with newlines');
    assert.ok(str.includes('  '), 'Should be indented');
  });
});
