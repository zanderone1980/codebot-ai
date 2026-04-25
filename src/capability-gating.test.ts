import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  LABEL_TO_PERMISSION,
  permissionRank,
  strictestPermissionForCapabilityLabels,
  labelsRequiringPermission,
  escalatePermissionFromCapabilityLabels,
} from './capability-gating';
import type { CapabilityLabel } from './types';

/**
 * PR 4 — capability-driven permission escalation.
 *
 * Pure-function tests for the gating helpers. Integration tests for
 * `_prepareToolCall` and `ToolRegistry.register` live in their own
 * suites (`capability-coverage.test.ts` for the registration guard,
 * agent-level tests for the gate behavior).
 *
 * The contract these tests pin:
 *   - Each label maps to a single required permission per §7.
 *   - `strictestPermissionForCapabilityLabels` returns the strictest
 *     permission across a list (combine rule).
 *   - `escalatePermissionFromCapabilityLabels` is monotonic up only —
 *     never weakens a stricter starting permission.
 *   - `triggeringLabels` returns ONLY the labels that drove the
 *     escalation (i.e. the ones whose required permission equals the
 *     final escalated value), not any of the weaker labels along for
 *     the ride. That's what makes the audit reason readable.
 */

describe('LABEL_TO_PERMISSION — §7 mapping is complete', () => {
  // Exhaustive list of labels in the union (mirrors src/types.ts).
  const ALL_LABELS: CapabilityLabel[] = [
    'read-only', 'write-fs', 'run-cmd',
    'browser-read', 'browser-write', 'net-fetch',
    'account-access', 'send-on-behalf', 'delete-data',
    'spend-money', 'move-money',
  ];

  it('every label has a required permission declared', () => {
    for (const label of ALL_LABELS) {
      const p = LABEL_TO_PERMISSION[label];
      assert.ok(p, `LABEL_TO_PERMISSION missing label "${label}"`);
      assert.ok(['auto', 'prompt', 'always-ask'].includes(p),
        `label "${label}" has invalid permission "${p}"`);
    }
  });

  it('§7 always-ask labels: send-on-behalf, delete-data, browser-write, spend-money, move-money', () => {
    assert.strictEqual(LABEL_TO_PERMISSION['send-on-behalf'], 'always-ask');
    assert.strictEqual(LABEL_TO_PERMISSION['delete-data'], 'always-ask');
    assert.strictEqual(LABEL_TO_PERMISSION['browser-write'], 'always-ask');
    assert.strictEqual(LABEL_TO_PERMISSION['spend-money'], 'always-ask');
    assert.strictEqual(LABEL_TO_PERMISSION['move-money'], 'always-ask');
  });

  it('§7 prompt labels: write-fs, run-cmd, net-fetch, account-access', () => {
    assert.strictEqual(LABEL_TO_PERMISSION['write-fs'], 'prompt');
    assert.strictEqual(LABEL_TO_PERMISSION['run-cmd'], 'prompt');
    assert.strictEqual(LABEL_TO_PERMISSION['net-fetch'], 'prompt');
    assert.strictEqual(LABEL_TO_PERMISSION['account-access'], 'prompt');
  });

  it('§7 auto labels: read-only, browser-read', () => {
    assert.strictEqual(LABEL_TO_PERMISSION['read-only'], 'auto');
    assert.strictEqual(LABEL_TO_PERMISSION['browser-read'], 'auto');
  });
});

describe('permissionRank — strictest wins', () => {
  it('always-ask > prompt > auto', () => {
    assert.ok(permissionRank('always-ask') > permissionRank('prompt'));
    assert.ok(permissionRank('prompt') > permissionRank('auto'));
  });
});

describe('strictestPermissionForCapabilityLabels — §7 combine rule', () => {
  it('empty list returns auto (no escalation)', () => {
    assert.strictEqual(strictestPermissionForCapabilityLabels(undefined), 'auto');
    assert.strictEqual(strictestPermissionForCapabilityLabels([]), 'auto');
  });

  it('single read-only returns auto', () => {
    assert.strictEqual(strictestPermissionForCapabilityLabels(['read-only']), 'auto');
  });

  it('single write-fs returns prompt', () => {
    assert.strictEqual(strictestPermissionForCapabilityLabels(['write-fs']), 'prompt');
  });

  it('single send-on-behalf returns always-ask', () => {
    assert.strictEqual(strictestPermissionForCapabilityLabels(['send-on-behalf']), 'always-ask');
  });

  it('combines mixed labels to the strictest (read-only + send-on-behalf + write-fs → always-ask)', () => {
    assert.strictEqual(
      strictestPermissionForCapabilityLabels(['read-only', 'send-on-behalf', 'write-fs']),
      'always-ask',
    );
  });

  it('combines without always-ask (read-only + write-fs → prompt)', () => {
    assert.strictEqual(
      strictestPermissionForCapabilityLabels(['read-only', 'write-fs']),
      'prompt',
    );
  });

  it('delegate-style 10-label union escalates to always-ask', () => {
    // Mirrors PR 3's delegate label set; pins the design call that
    // delegate is naive-union always-ask under PR 4.
    const labels: CapabilityLabel[] = [
      'read-only', 'write-fs', 'run-cmd', 'browser-read', 'browser-write',
      'net-fetch', 'account-access', 'send-on-behalf', 'delete-data',
      'spend-money',
    ];
    assert.strictEqual(strictestPermissionForCapabilityLabels(labels), 'always-ask');
  });
});

describe('labelsRequiringPermission — for audit-reason building', () => {
  it('returns only the labels whose required permission matches the target', () => {
    const labels: CapabilityLabel[] = ['read-only', 'send-on-behalf', 'write-fs', 'delete-data'];
    const triggering = labelsRequiringPermission(labels, 'always-ask');
    assert.deepStrictEqual(triggering.sort(), ['delete-data', 'send-on-behalf']);
  });

  it('returns empty when no label matches', () => {
    assert.deepStrictEqual(labelsRequiringPermission(['read-only'], 'always-ask'), []);
  });

  it('returns empty for undefined / empty list', () => {
    assert.deepStrictEqual(labelsRequiringPermission(undefined, 'always-ask'), []);
    assert.deepStrictEqual(labelsRequiringPermission([], 'always-ask'), []);
  });
});

describe('escalatePermissionFromCapabilityLabels — monotonic up only', () => {
  it('escalates auto → always-ask when label demands it', () => {
    const r = escalatePermissionFromCapabilityLabels('auto', ['send-on-behalf']);
    assert.strictEqual(r.escalated, true);
    assert.strictEqual(r.permission, 'always-ask');
    assert.deepStrictEqual(r.triggeringLabels, ['send-on-behalf']);
  });

  it('escalates auto → prompt when label demands it', () => {
    const r = escalatePermissionFromCapabilityLabels('auto', ['write-fs']);
    assert.strictEqual(r.escalated, true);
    assert.strictEqual(r.permission, 'prompt');
    assert.deepStrictEqual(r.triggeringLabels, ['write-fs']);
  });

  it('does NOT weaken always-ask → auto, even if labels are read-only', () => {
    const r = escalatePermissionFromCapabilityLabels('always-ask', ['read-only']);
    assert.strictEqual(r.escalated, false);
    assert.strictEqual(r.permission, 'always-ask');
    assert.deepStrictEqual(r.triggeringLabels, []);
  });

  it('does NOT weaken prompt → auto, even if labels are read-only', () => {
    const r = escalatePermissionFromCapabilityLabels('prompt', ['read-only']);
    assert.strictEqual(r.escalated, false);
    assert.strictEqual(r.permission, 'prompt');
  });

  it('does NOT escalate when already strictest (always-ask + send-on-behalf)', () => {
    const r = escalatePermissionFromCapabilityLabels('always-ask', ['send-on-behalf']);
    assert.strictEqual(r.escalated, false);
    assert.strictEqual(r.permission, 'always-ask');
    // No triggering labels because no movement occurred.
    assert.deepStrictEqual(r.triggeringLabels, []);
  });

  it('does NOT escalate prompt + write-fs (same-level no-op)', () => {
    const r = escalatePermissionFromCapabilityLabels('prompt', ['write-fs']);
    assert.strictEqual(r.escalated, false);
    assert.strictEqual(r.permission, 'prompt');
  });

  it('triggering labels are only the ones at the escalated level (audit clarity)', () => {
    // auto → always-ask via send-on-behalf+delete-data; write-fs is along
    // for the ride but didn't drive the escalation.
    const r = escalatePermissionFromCapabilityLabels(
      'auto',
      ['write-fs', 'send-on-behalf', 'delete-data'],
    );
    assert.strictEqual(r.escalated, true);
    assert.strictEqual(r.permission, 'always-ask');
    assert.deepStrictEqual(r.triggeringLabels.sort(), ['delete-data', 'send-on-behalf']);
    assert.ok(!r.triggeringLabels.includes('write-fs'),
      'write-fs is prompt-level; it should NOT be listed as triggering an always-ask escalation');
  });

  it('handles empty / undefined labels by leaving permission untouched', () => {
    const r1 = escalatePermissionFromCapabilityLabels('prompt', undefined);
    assert.strictEqual(r1.escalated, false);
    assert.strictEqual(r1.permission, 'prompt');

    const r2 = escalatePermissionFromCapabilityLabels('prompt', []);
    assert.strictEqual(r2.escalated, false);
    assert.strictEqual(r2.permission, 'prompt');
  });
});
