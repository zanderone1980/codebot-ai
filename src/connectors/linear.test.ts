/**
 * PR 23 — Linear §8 connector contract tests.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { LinearConnector, isLinearAuthError } from './linear';
import { validateConnectorContract } from './connector-contract';

describe('isLinearAuthError', () => {
  it('401 → reauth', () => {
    assert.strictEqual(isLinearAuthError(401, undefined), true);
  });

  it('429 → not reauth', () => {
    assert.strictEqual(isLinearAuthError(429, undefined), false);
  });

  it('200 with auth-message error → reauth', () => {
    assert.strictEqual(
      isLinearAuthError(200, { errors: [{ message: 'Authentication required' }] }),
      true,
    );
    assert.strictEqual(
      isLinearAuthError(200, { errors: [{ message: 'Invalid API key' }] }),
      true,
    );
    assert.strictEqual(
      isLinearAuthError(200, { errors: [{ message: 'token expired' }] }),
      true,
    );
  });

  it('200 with non-auth error → NOT reauth', () => {
    assert.strictEqual(
      isLinearAuthError(200, { errors: [{ message: 'Issue with id "FOO-1" not found' }] }),
      false,
    );
    assert.strictEqual(
      isLinearAuthError(200, { errors: [{ message: 'Validation error: title required' }] }),
      false,
    );
  });

  it('200 with no errors → NOT reauth', () => {
    assert.strictEqual(isLinearAuthError(200, { errors: [] }), false);
    assert.strictEqual(isLinearAuthError(200, undefined), false);
    assert.strictEqual(isLinearAuthError(200, {}), false);
  });

  it('500 → NOT reauth', () => {
    assert.strictEqual(isLinearAuthError(500, undefined), false);
  });
});

describe('LinearConnector — §8 contract surface', () => {
  const connector = new LinearConnector();

  it('declares vaultKeyName=linear', () => {
    assert.strictEqual(connector.vaultKeyName, 'linear');
  });

  it('exposes the 4 expected actions', () => {
    const names = connector.actions.map(a => a.name).sort();
    assert.deepStrictEqual(names, ['create_issue', 'list_issues', 'list_teams', 'update_issue']);
  });

  it('per-action capability labels', () => {
    const byName = Object.fromEntries(connector.actions.map(a => [a.name, a]));
    assert.deepStrictEqual(byName.list_issues.capabilities, ['read-only', 'account-access', 'net-fetch']);
    assert.deepStrictEqual(byName.list_teams.capabilities, ['read-only', 'account-access', 'net-fetch']);
    assert.deepStrictEqual(byName.create_issue.capabilities, ['account-access', 'net-fetch', 'send-on-behalf']);
    assert.deepStrictEqual(byName.update_issue.capabilities, ['account-access', 'net-fetch', 'send-on-behalf']);
  });

  it('idempotency: create_issue unsupported, names clientMutationId-is-just-echo', () => {
    const a = connector.actions.find(x => x.name === 'create_issue')!;
    assert.strictEqual(a.idempotency?.kind, 'unsupported');
    if (a.idempotency?.kind === 'unsupported') {
      assert.match(a.idempotency.reason, /clientMutationId/);
      assert.match(a.idempotency.reason, /echoed back/);
    }
  });

  it('idempotency: update_issue unsupported, names concurrent-edits gap', () => {
    const a = connector.actions.find(x => x.name === 'update_issue')!;
    assert.strictEqual(a.idempotency?.kind, 'unsupported');
    if (a.idempotency?.kind === 'unsupported') {
      assert.match(a.idempotency.reason, /concurrent edits/);
    }
  });

  it('preview: create_issue maps priority number to label, hashes desc', async () => {
    const a = connector.actions.find(x => x.name === 'create_issue')!;
    const p = await a.preview!({
      title: 'Wire feature flag',
      team_id: 'team-uuid',
      priority: 1,
      assignee_id: 'user-uuid',
      labels: 'bug,p0',
      description: 'detailed plan with internal context',
    }, '');
    assert.match(p.summary, /Title:\s+Wire feature flag/);
    assert.match(p.summary, /Team ID:\s+team-uuid/);
    assert.match(p.summary, /Priority:\s+Urgent/);
    assert.match(p.summary, /Assignee:\s+user-uuid/);
    assert.match(p.summary, /Label IDs:\s+bug, p0/);
    assert.match(p.summary, /sha256:[a-f0-9]{16}/);
    assert.ok(!p.summary.includes('internal context'));
  });

  it('preview: update_issue lists changed fields + warns on concurrency', async () => {
    const a = connector.actions.find(x => x.name === 'update_issue')!;
    const p = await a.preview!({ issue_id: 'TEAM-42', title: 'New', state_id: 'state-x' }, '');
    assert.match(p.summary, /TEAM-42/);
    assert.match(p.summary, /title -> New/);
    assert.match(p.summary, /state_id -> state-x/);
    assert.match(p.summary, /Idempotency:\s+NONE/);
    assert.strictEqual(p.details?.changedFields, 2);
  });

  it('redactArgsForAudit: create_issue hashes description, preserves title/team_id', () => {
    const a = connector.actions.find(x => x.name === 'create_issue')!;
    const out = a.redactArgsForAudit!({
      title: 'Task',
      team_id: 'team-x',
      description: 'sensitive product details',
    });
    assert.strictEqual(out.title, 'Task');
    assert.strictEqual(out.team_id, 'team-x');
    assert.match(out.description as string, /^<redacted sha256:[a-f0-9]{16} len:\d+>$/);
    assert.ok(!JSON.stringify(out).includes('sensitive product'));
  });

  it('contract validator passes with zero violations', () => {
    const violations = validateConnectorContract(connector);
    assert.strictEqual(violations.length, 0,
      `expected zero violations; got: ${JSON.stringify(violations)}`);
  });
});
