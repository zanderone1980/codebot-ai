/**
 * PR 19 — Notion §8 connector contract tests.
 *
 * Coverage:
 *   - isNotionAuthError classification table (pure function)
 *   - vaultKeyName declared
 *   - per-action capability labels
 *   - preview functions for create_page + update_page (no network,
 *     deterministic, hash content, count paragraphs, name parent and
 *     destructive scope explicitly)
 *   - redactArgsForAudit hashes content + preserves identifiers (title,
 *     parent_id, page_id) so a forensic reader can identify what got
 *     created or appended without seeing the body text
 *   - idempotency declarations: both create_page and update_page are
 *     'unsupported' with explicit reason strings (Notion has no client
 *     idempotency key on either endpoint)
 *   - validateConnectorContract returns zero violations
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { NotionConnector, isNotionAuthError } from './notion';
import { validateConnectorContract } from './connector-contract';

describe('isNotionAuthError', () => {
  it('401 → reauth', () => {
    assert.strictEqual(isNotionAuthError(401, undefined), true);
    assert.strictEqual(isNotionAuthError(401, { object: 'error', code: 'unauthorized' }), true);
  });

  it('200 / 404 / 500 → not reauth', () => {
    assert.strictEqual(isNotionAuthError(200, undefined), false);
    assert.strictEqual(isNotionAuthError(404, { code: 'object_not_found' }), false);
    assert.strictEqual(isNotionAuthError(500, undefined), false);
  });

  it('429 → not reauth (rate limit, never reconnect)', () => {
    assert.strictEqual(isNotionAuthError(429, { code: 'rate_limited' }), false);
    assert.strictEqual(isNotionAuthError(429, undefined), false);
  });

  it('403/400 with auth-class code → reauth', () => {
    for (const code of ['unauthorized', 'restricted_resource']) {
      assert.strictEqual(
        isNotionAuthError(403, { code }),
        true,
        `403 code="${code}" should be reauth`,
      );
      assert.strictEqual(
        isNotionAuthError(400, { code }),
        true,
        `400 code="${code}" should be reauth`,
      );
    }
  });

  it('403/400 with non-auth code → NOT reauth', () => {
    for (const code of ['rate_limited', 'validation_error', 'object_not_found', 'conflict_error', 'internal_server_error', 'service_unavailable']) {
      assert.strictEqual(
        isNotionAuthError(403, { code }),
        false,
        `403 code="${code}" must NOT trigger reauth`,
      );
      assert.strictEqual(
        isNotionAuthError(400, { code }),
        false,
        `400 code="${code}" must NOT trigger reauth`,
      );
    }
  });

  it('403 with unrecognized code → NOT reauth (fail closed)', () => {
    assert.strictEqual(
      isNotionAuthError(403, { code: 'mystery_thing' }),
      false,
    );
  });

  it('403 with no body → NOT reauth', () => {
    assert.strictEqual(isNotionAuthError(403, undefined), false);
    assert.strictEqual(isNotionAuthError(403, {}), false);
  });
});

describe('NotionConnector — §8 contract surface', () => {
  const connector = new NotionConnector();

  it('declares vaultKeyName=notion', () => {
    assert.strictEqual(connector.vaultKeyName, 'notion');
  });

  it('exposes the 5 expected actions', () => {
    const names = connector.actions.map(a => a.name).sort();
    assert.deepStrictEqual(names, ['create_page', 'list_databases', 'query_database', 'search', 'update_page']);
  });

  it('per-action capability labels match the §8 spec', () => {
    const byName = Object.fromEntries(connector.actions.map(a => [a.name, a]));
    assert.deepStrictEqual(byName.search.capabilities, ['read-only', 'account-access', 'net-fetch']);
    assert.deepStrictEqual(byName.list_databases.capabilities, ['read-only', 'account-access', 'net-fetch']);
    assert.deepStrictEqual(byName.query_database.capabilities, ['read-only', 'account-access', 'net-fetch']);
    assert.deepStrictEqual(byName.create_page.capabilities, ['account-access', 'net-fetch', 'send-on-behalf']);
    assert.deepStrictEqual(byName.update_page.capabilities, ['account-access', 'net-fetch', 'send-on-behalf']);
  });

  it('idempotency: create_page is unsupported with no-client-key reason', () => {
    const a = connector.actions.find(x => x.name === 'create_page')!;
    assert.strictEqual(a.idempotency?.kind, 'unsupported');
    if (a.idempotency?.kind === 'unsupported') {
      assert.match(a.idempotency.reason, /client_request_id/i);
      assert.match(a.idempotency.reason, /Idempotency-Key/i);
    }
  });

  it('idempotency: update_page is unsupported with append-only reason', () => {
    const a = connector.actions.find(x => x.name === 'update_page')!;
    assert.strictEqual(a.idempotency?.kind, 'unsupported');
    if (a.idempotency?.kind === 'unsupported') {
      assert.match(a.idempotency.reason, /APPENDS/);
      assert.match(a.idempotency.reason, /append-only/i);
    }
  });

  it('preview: create_page hashes content, names paragraph count + parent', async () => {
    const a = connector.actions.find(x => x.name === 'create_page')!;
    assert.ok(a.preview, 'preview required for send-on-behalf');
    const p = await a.preview!({
      title: 'Sprint notes',
      parent_id: 'abc123',
      parent_type: 'database',
      content: 'first paragraph\nsecond paragraph\n\nthird with secret stuff',
    }, '');
    assert.match(p.summary, /Would create Notion page/);
    assert.match(p.summary, /Title:\s+Sprint notes/);
    assert.match(p.summary, /Parent ID:\s+abc123/);
    assert.match(p.summary, /Parent type:\s+database/);
    assert.match(p.summary, /sha256:[a-f0-9]{16}/);
    assert.match(p.summary, /3 paragraph\(s\)/);
    // The body text MUST NOT leak in summary or details.
    assert.ok(!p.summary.includes('secret stuff'));
    assert.ok(!JSON.stringify(p.details).includes('secret stuff'));
    assert.strictEqual(p.details?.paragraphCount, 3);
  });

  it('preview: update_page declares append-only + no idempotency', async () => {
    const a = connector.actions.find(x => x.name === 'update_page')!;
    const p = await a.preview!({
      page_id: 'page-xyz',
      content: 'append this\nand this',
    }, '');
    assert.match(p.summary, /Would APPEND to Notion page/);
    assert.match(p.summary, /Page ID:\s+page-xyz/);
    assert.match(p.summary, /Append-only/);
    assert.match(p.summary, /Idempotency:\s+none/);
    assert.match(p.summary, /2 paragraph\(s\)/);
    assert.strictEqual(p.details?.paragraphCount, 2);
  });

  it('preview: update_page with empty content names the would-error case', async () => {
    const a = connector.actions.find(x => x.name === 'update_page')!;
    const p = await a.preview!({ page_id: 'page-xyz' }, '');
    assert.match(p.summary, /\(empty — would error\)/);
  });

  it('redactArgsForAudit: create_page hashes content, preserves title + parent_id', () => {
    const a = connector.actions.find(x => x.name === 'create_page')!;
    const out = a.redactArgsForAudit!({
      title: 'Q3 OKRs',
      parent_id: 'db-abc-123',
      parent_type: 'database',
      content: 'detailed plan with confidential numbers',
    });
    assert.strictEqual(out.title, 'Q3 OKRs');
    assert.strictEqual(out.parent_id, 'db-abc-123');
    assert.strictEqual(out.parent_type, 'database');
    assert.match(out.content as string, /^<redacted sha256:[a-f0-9]{16} len:\d+>$/);
    assert.ok(!JSON.stringify(out).includes('confidential'));
  });

  it('redactArgsForAudit: update_page hashes content, preserves page_id', () => {
    const a = connector.actions.find(x => x.name === 'update_page')!;
    const out = a.redactArgsForAudit!({
      page_id: 'page-zzz',
      content: 'sensitive customer feedback',
    });
    assert.strictEqual(out.page_id, 'page-zzz');
    assert.match(out.content as string, /^<redacted sha256:[a-f0-9]{16} len:\d+>$/);
    assert.ok(!JSON.stringify(out).includes('sensitive'));
  });

  it('redactArgsForAudit: empty/missing content passes through', () => {
    const a = connector.actions.find(x => x.name === 'create_page')!;
    const out = a.redactArgsForAudit!({ title: 'Empty', parent_id: 'p-1' });
    assert.strictEqual(out.title, 'Empty');
    assert.strictEqual(out.content, undefined);
  });

  it('contract validator passes with zero violations', () => {
    const violations = validateConnectorContract(connector);
    assert.strictEqual(violations.length, 0,
      `expected zero violations; got: ${JSON.stringify(violations)}`);
  });
});
