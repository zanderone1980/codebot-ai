/**
 * PR 22 — Jira §8 connector contract tests.
 *
 * Coverage:
 *   - isJiraAuthError classification (401 reauth; 403 NOT reauth —
 *     Atlassian's project/license/workflow permission failures should
 *     NOT trigger an unnecessary reconnect prompt; 429 rate limit;
 *     anything else fail-closed)
 *   - vaultKeyName declared
 *   - per-action capability labels
 *   - preview functions for all three writes (create_issue lists
 *     project/type/summary/priority/assignee/labels/desc-hash; update_issue
 *     enumerates only changed fields; add_comment hashes comment with
 *     "retrying creates a duplicate comment" warning)
 *   - redactArgsForAudit hashes description / comment, preserves
 *     project / summary / issue_key / assignee / labels
 *   - idempotency declarations: all three writes unsupported with
 *     specific reasons (POST /issue, transition non-idempotency,
 *     comment dedup gap)
 *   - validateConnectorContract returns zero violations
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { JiraConnector, isJiraAuthError } from './jira';
import { validateConnectorContract } from './connector-contract';

describe('isJiraAuthError', () => {
  it('401 → reauth', () => {
    assert.strictEqual(isJiraAuthError(401, undefined), true);
    assert.strictEqual(isJiraAuthError(401, { errorMessages: ['Unauthorized'] }), true);
  });

  it('403 → NOT reauth (Atlassian uses 403 for permission, not creds)', () => {
    assert.strictEqual(
      isJiraAuthError(403, { errorMessages: ['You do not have permission to view this issue.'] }),
      false,
    );
    assert.strictEqual(isJiraAuthError(403, undefined), false);
  });

  it('429 → NOT reauth (rate limit)', () => {
    assert.strictEqual(isJiraAuthError(429, undefined), false);
  });

  it('200 / 404 / 500 → not reauth', () => {
    assert.strictEqual(isJiraAuthError(200, undefined), false);
    assert.strictEqual(isJiraAuthError(404, undefined), false);
    assert.strictEqual(isJiraAuthError(500, undefined), false);
  });
});

describe('JiraConnector — §8 contract surface', () => {
  const connector = new JiraConnector();

  it('declares vaultKeyName=jira', () => {
    assert.strictEqual(connector.vaultKeyName, 'jira');
  });

  it('exposes the 5 expected actions', () => {
    const names = connector.actions.map(a => a.name).sort();
    assert.deepStrictEqual(names, ['add_comment', 'create_issue', 'list_issues', 'search', 'update_issue']);
  });

  it('per-action capability labels match the §8 spec', () => {
    const byName = Object.fromEntries(connector.actions.map(a => [a.name, a]));
    assert.deepStrictEqual(byName.list_issues.capabilities, ['read-only', 'account-access', 'net-fetch']);
    assert.deepStrictEqual(byName.search.capabilities, ['read-only', 'account-access', 'net-fetch']);
    assert.deepStrictEqual(byName.create_issue.capabilities, ['account-access', 'net-fetch', 'send-on-behalf']);
    assert.deepStrictEqual(byName.update_issue.capabilities, ['account-access', 'net-fetch', 'send-on-behalf']);
    assert.deepStrictEqual(byName.add_comment.capabilities, ['account-access', 'net-fetch', 'send-on-behalf']);
  });

  it('idempotency: create_issue unsupported, names POST-creates-new', () => {
    const a = connector.actions.find(x => x.name === 'create_issue')!;
    assert.strictEqual(a.idempotency?.kind, 'unsupported');
    if (a.idempotency?.kind === 'unsupported') {
      assert.match(a.idempotency.reason, /Idempotency-Key/i);
      assert.match(a.idempotency.reason, /two distinct issues/);
    }
  });

  it('idempotency: update_issue unsupported, names transition gotcha', () => {
    const a = connector.actions.find(x => x.name === 'update_issue')!;
    assert.strictEqual(a.idempotency?.kind, 'unsupported');
    if (a.idempotency?.kind === 'unsupported') {
      assert.match(a.idempotency.reason, /transition/);
      assert.match(a.idempotency.reason, /not safe to retry/i);
    }
  });

  it('idempotency: add_comment unsupported, names duplicate-comment gap', () => {
    const a = connector.actions.find(x => x.name === 'add_comment')!;
    assert.strictEqual(a.idempotency?.kind, 'unsupported');
    if (a.idempotency?.kind === 'unsupported') {
      assert.match(a.idempotency.reason, /duplicate|two visible comments/i);
    }
  });

  it('preview: create_issue shows fields + hashes description', async () => {
    const a = connector.actions.find(x => x.name === 'create_issue')!;
    const p = await a.preview!({
      project: 'PROJ',
      summary: 'Fix login bug',
      issuetype: 'Bug',
      priority: 'High',
      assignee: 'user-id-123',
      labels: 'auth, regression',
      description: 'The login form fails on Firefox with 500 error',
    }, '');
    assert.match(p.summary, /Project:\s+PROJ/);
    assert.match(p.summary, /Type:\s+Bug/);
    assert.match(p.summary, /Summary:\s+Fix login bug/);
    assert.match(p.summary, /Priority:\s+High/);
    assert.match(p.summary, /Assignee:\s+user-id-123/);
    assert.match(p.summary, /Labels:\s+auth, regression/);
    assert.match(p.summary, /sha256:[a-f0-9]{16}/);
    assert.ok(!p.summary.includes('500 error'));
    assert.deepStrictEqual(p.details?.labels, ['auth', 'regression']);
  });

  it('preview: update_issue lists only changed fields', async () => {
    const a = connector.actions.find(x => x.name === 'update_issue')!;
    const p = await a.preview!({
      issue_key: 'PROJ-42',
      summary: 'New title',
      status: 'In Progress',
    }, '');
    assert.match(p.summary, /Would update Jira PROJ-42/);
    assert.match(p.summary, /summary -> New title/);
    assert.match(p.summary, /status \(transition\) -> In Progress/);
    assert.match(p.summary, /transition is a separate POST/);
    assert.strictEqual(p.details?.changedFields, 2);
  });

  it('preview: add_comment hashes comment + names duplicate-on-retry', async () => {
    const a = connector.actions.find(x => x.name === 'add_comment')!;
    const p = await a.preview!({ issue_key: 'PROJ-7', comment: 'private investigation notes' }, '');
    assert.match(p.summary, /Would add comment to Jira PROJ-7/);
    assert.match(p.summary, /sha256:[a-f0-9]{16}/);
    assert.match(p.summary, /Idempotency:\s+NONE/);
    assert.match(p.summary, /duplicate comment/);
    assert.ok(!p.summary.includes('investigation notes'));
  });

  it('redactArgsForAudit: create_issue hashes description; project/summary/labels preserved', () => {
    const a = connector.actions.find(x => x.name === 'create_issue')!;
    const out = a.redactArgsForAudit!({
      project: 'PROJ',
      summary: 'Fix bug',
      description: 'sensitive details about the auth flaw',
      labels: 'security, p0',
    });
    assert.strictEqual(out.project, 'PROJ');
    assert.strictEqual(out.summary, 'Fix bug');
    assert.strictEqual(out.labels, 'security, p0');
    assert.match(out.description as string, /^<redacted sha256:[a-f0-9]{16} len:\d+>$/);
    assert.ok(!JSON.stringify(out).includes('auth flaw'));
  });

  it('redactArgsForAudit: add_comment hashes comment, preserves issue_key', () => {
    const a = connector.actions.find(x => x.name === 'add_comment')!;
    const out = a.redactArgsForAudit!({
      issue_key: 'PROJ-99',
      comment: 'forensic write-up — DO NOT POST',
    });
    assert.strictEqual(out.issue_key, 'PROJ-99');
    assert.match(out.comment as string, /^<redacted sha256:[a-f0-9]{16} len:\d+>$/);
    assert.ok(!JSON.stringify(out).includes('forensic'));
  });

  it('contract validator passes with zero violations', () => {
    const violations = validateConnectorContract(connector);
    assert.strictEqual(violations.length, 0,
      `expected zero violations; got: ${JSON.stringify(violations)}`);
  });
});
