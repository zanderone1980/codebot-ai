/**
 * Tests for src/capability-allowlist.ts (PR 11).
 *
 * Coverage targets:
 *   - empty / whitespace inputs return an empty Set, no throw.
 *   - valid labels are accepted and returned in the Set.
 *   - NEVER_ALLOWABLE labels are rejected with the precise §7-citing error.
 *   - Unknown labels are rejected with the closed-set error message.
 *   - Hard exclusions take precedence over the unknown-label check (so a
 *     user typing `move-money` sees the *right* explanation, not "unknown").
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  parseAllowCapabilityFlag,
  CapabilityAllowlistError,
  NEVER_ALLOWABLE,
  CURRENTLY_ALLOWABLE,
} from './capability-allowlist';

describe('parseAllowCapabilityFlag (PR 11)', () => {
  it('returns an empty Set for empty input', () => {
    assert.strictEqual(parseAllowCapabilityFlag('').size, 0);
    assert.strictEqual(parseAllowCapabilityFlag('   ').size, 0);
  });

  it('parses a single label', () => {
    const out = parseAllowCapabilityFlag('account-access');
    assert.strictEqual(out.size, 1);
    assert.ok(out.has('account-access'));
  });

  it('parses a comma-separated list, trims whitespace, ignores empty tokens', () => {
    const out = parseAllowCapabilityFlag(' account-access ,, net-fetch , read-only,');
    assert.strictEqual(out.size, 3);
    assert.ok(out.has('account-access'));
    assert.ok(out.has('net-fetch'));
    assert.ok(out.has('read-only'));
  });

  it('rejects move-money with the §7 message — never-allowable wins over unknown-label', () => {
    assert.throws(() => parseAllowCapabilityFlag('move-money'), CapabilityAllowlistError);
    try {
      parseAllowCapabilityFlag('move-money');
      assert.fail('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      assert.match(msg, /Refusing to allowlist capability "move-money"/);
      assert.match(msg, /never-allowable set/);
      assert.match(msg, /§7/);
    }
  });

  it('rejects each NEVER_ALLOWABLE label individually', () => {
    for (const label of NEVER_ALLOWABLE) {
      assert.throws(
        () => parseAllowCapabilityFlag(label),
        CapabilityAllowlistError,
        `expected ${label} to be rejected`,
      );
    }
  });

  it('rejects mixed valid + never-allowable input — fail fast on the first bad label', () => {
    assert.throws(
      () => parseAllowCapabilityFlag('account-access,send-on-behalf,net-fetch'),
      /Refusing to allowlist capability "send-on-behalf"/,
    );
  });

  it('rejects unknown labels with the closed-set error', () => {
    assert.throws(() => parseAllowCapabilityFlag('foo-bar'), CapabilityAllowlistError);
    try {
      parseAllowCapabilityFlag('foo-bar');
      assert.fail('should have thrown');
    } catch (e) {
      const msg = (e as Error).message;
      assert.match(msg, /Unknown or unsupported capability label "foo-bar"/);
      assert.match(msg, /Allowable labels:/);
      // The error should enumerate the entire closed set so the user
      // can self-correct without grepping the source.
      for (const ok of CURRENTLY_ALLOWABLE) {
        assert.ok(msg.includes(ok), `error message should list ${ok}`);
      }
    }
  });

  it('NEVER_ALLOWABLE and CURRENTLY_ALLOWABLE are disjoint', () => {
    for (const l of NEVER_ALLOWABLE) {
      assert.ok(!CURRENTLY_ALLOWABLE.has(l), `${l} should not be in CURRENTLY_ALLOWABLE`);
    }
  });

  it('all currently-allowable labels round-trip without error', () => {
    for (const label of CURRENTLY_ALLOWABLE) {
      const out = parseAllowCapabilityFlag(label);
      assert.ok(out.has(label), `${label} should round-trip`);
    }
  });

  it('rejects case-mismatched labels — exact lowercase only', () => {
    assert.throws(() => parseAllowCapabilityFlag('Account-Access'), CapabilityAllowlistError);
    assert.throws(() => parseAllowCapabilityFlag('NET-FETCH'), CapabilityAllowlistError);
  });
});
