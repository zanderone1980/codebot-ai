/**
 * PR 14 — Google Calendar §8 connector contract tests.
 *
 * Coverage:
 *   - `isGoogleCalendarAuthError` classification table (pure function)
 *   - vaultKeyName declared
 *   - per-action capability labels
 *   - preview functions (no-network, deterministic)
 *   - redactArgsForAudit hashes description + redacts attendees
 *   - idempotency declarations: arg form for create_event, unsupported
 *     reasons for update_event and delete_event
 *   - validateConnectorContract on the live connector instance returns
 *     zero violations
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { GoogleCalendarConnector, isGoogleCalendarAuthError } from './google-calendar';
import { validateConnectorContract } from './connector-contract';

describe('isGoogleCalendarAuthError', () => {
  it('401 → reauth (token expired/revoked)', () => {
    assert.strictEqual(isGoogleCalendarAuthError(401, undefined), true);
    assert.strictEqual(isGoogleCalendarAuthError(401, { error: { errors: [] } }), true);
  });

  it('200 → not reauth', () => {
    assert.strictEqual(isGoogleCalendarAuthError(200, undefined), false);
  });

  it('404 → not reauth', () => {
    assert.strictEqual(isGoogleCalendarAuthError(404, { error: { code: 404 } }), false);
  });

  it('403 with auth-class reason → reauth', () => {
    for (const reason of ['authError', 'invalidCredentials', 'insufficientPermissions']) {
      assert.strictEqual(
        isGoogleCalendarAuthError(403, { error: { errors: [{ reason }] } }),
        true,
        `403 reason="${reason}" should be reauth`,
      );
    }
  });

  it('403 with rate-limit / quota reason → NOT reauth', () => {
    for (const reason of ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded']) {
      assert.strictEqual(
        isGoogleCalendarAuthError(403, { error: { errors: [{ reason }] } }),
        false,
        `403 reason="${reason}" must NOT trigger reauth — user retries, doesn't reconnect`,
      );
    }
  });

  it('403 with mixed auth + rate reasons → NOT reauth (conservative)', () => {
    // If both an auth reason and a rate reason appear in the same
    // response, treat as non-auth so the user retries rather than gets
    // pushed into an unnecessary reconnect flow.
    assert.strictEqual(
      isGoogleCalendarAuthError(403, {
        error: { errors: [{ reason: 'authError' }, { reason: 'rateLimitExceeded' }] },
      }),
      false,
    );
  });

  it('403 with unrecognized reason → NOT reauth (fail closed)', () => {
    assert.strictEqual(
      isGoogleCalendarAuthError(403, { error: { errors: [{ reason: 'mysteryProblem' }] } }),
      false,
    );
  });

  it('403 with no errors[] → NOT reauth', () => {
    assert.strictEqual(isGoogleCalendarAuthError(403, { error: {} }), false);
    assert.strictEqual(isGoogleCalendarAuthError(403, undefined), false);
  });
});

describe('GoogleCalendarConnector — §8 contract surface', () => {
  const connector = new GoogleCalendarConnector();

  it('declares vaultKeyName=google_calendar', () => {
    assert.strictEqual(connector.vaultKeyName, 'google_calendar');
  });

  it('exposes the 5 expected actions', () => {
    const names = connector.actions.map(a => a.name).sort();
    assert.deepStrictEqual(names, ['create_event', 'delete_event', 'find_free_time', 'list_events', 'update_event']);
  });

  it('per-action capability labels match the §8 spec', () => {
    const byName = Object.fromEntries(connector.actions.map(a => [a.name, a]));
    assert.deepStrictEqual(byName.list_events.capabilities, ['read-only', 'account-access', 'net-fetch']);
    assert.deepStrictEqual(byName.find_free_time.capabilities, ['read-only', 'account-access', 'net-fetch']);
    assert.deepStrictEqual(byName.create_event.capabilities, ['account-access', 'net-fetch', 'send-on-behalf']);
    assert.deepStrictEqual(byName.update_event.capabilities, ['account-access', 'net-fetch', 'send-on-behalf']);
    assert.deepStrictEqual(byName.delete_event.capabilities, ['account-access', 'net-fetch', 'send-on-behalf', 'delete-data']);
  });

  it('idempotency: create_event uses request_id (Calendar API supports it)', () => {
    const a = connector.actions.find(x => x.name === 'create_event')!;
    assert.deepStrictEqual(a.idempotency, { kind: 'arg', arg: 'request_id' });
  });

  it('idempotency: update_event is unsupported with ETag-vs-idempotency reason', () => {
    const a = connector.actions.find(x => x.name === 'update_event')!;
    assert.strictEqual(a.idempotency?.kind, 'unsupported');
    if (a.idempotency?.kind === 'unsupported') {
      assert.match(a.idempotency.reason, /ETag/);
      assert.match(a.idempotency.reason, /not idempotency/i);
    }
  });

  it('idempotency: delete_event documents HTTP-410-natural-idempotency gap', () => {
    const a = connector.actions.find(x => x.name === 'delete_event')!;
    assert.strictEqual(a.idempotency?.kind, 'unsupported');
    if (a.idempotency?.kind === 'unsupported') {
      assert.match(a.idempotency.reason, /410 Gone/);
      assert.match(a.idempotency.reason, /no client-supplied idempotency key/);
    }
  });

  it('preview: create_event hashes description + counts attendees, no network', async () => {
    const a = connector.actions.find(x => x.name === 'create_event')!;
    assert.ok(a.preview, 'preview required for send-on-behalf');
    const p = await a.preview!({
      title: 'Sync',
      start: '2026-05-01T10:00:00-07:00',
      end: '2026-05-01T11:00:00-07:00',
      description: 'long body — secret stuff inside',
      attendees: 'a@x.com, b@y.com, c@z.com',
      location: 'Room 1',
      request_id: 'idem-123',
    }, '');
    assert.match(p.summary, /Would create Google Calendar event/);
    assert.match(p.summary, /Title:\s+Sync/);
    assert.match(p.summary, /Attendees:\s+3 email\(s\)/);
    assert.match(p.summary, /sha256:[a-f0-9]{16}/);
    assert.match(p.summary, /request_id:\s+idem-123/);
    assert.strictEqual(p.details?.attendeeCount, 3);
    // Raw description must NOT appear in summary or details.
    assert.ok(!p.summary.includes('secret stuff'));
    assert.ok(!JSON.stringify(p.details).includes('secret stuff'));
  });

  it('preview: update_event lists changed fields only', async () => {
    const a = connector.actions.find(x => x.name === 'update_event')!;
    const p = await a.preview!({
      event_id: 'evt-abc',
      title: 'New title',
      description: 'changed body',
    }, '');
    assert.match(p.summary, /Would update Google Calendar event evt-abc/);
    assert.match(p.summary, /title → New title/);
    assert.match(p.summary, /description → 12 chars \(sha256:/);
    assert.ok(!p.summary.includes('changed body'));
    assert.strictEqual(p.details?.changedFields, 2);
  });

  it('preview: delete_event names the destructive scope', async () => {
    const a = connector.actions.find(x => x.name === 'delete_event')!;
    const p = await a.preview!({ event_id: 'evt-zzz', calendar: 'work@x.com' }, '');
    assert.match(p.summary, /Would DELETE Google Calendar event/);
    assert.match(p.summary, /attendees' calendars/);
    assert.match(p.summary, /Not recoverable/);
  });

  it('redactArgsForAudit: create_event hashes description + redacts attendees, keeps title/start/location', () => {
    const a = connector.actions.find(x => x.name === 'create_event')!;
    const out = a.redactArgsForAudit!({
      title: '1:1',
      start: '2026-05-01T10:00:00Z',
      location: 'Room 1',
      description: 'private notes here',
      attendees: 'a@x.com,b@y.com',
    });
    assert.strictEqual(out.title, '1:1');
    assert.strictEqual(out.start, '2026-05-01T10:00:00Z');
    assert.strictEqual(out.location, 'Room 1');
    assert.match(out.description as string, /^<redacted sha256:[a-f0-9]{16} len:\d+>$/);
    assert.match(out.attendees as string, /^<redacted 2 email\(s\) sha256:[a-f0-9]{16} len:\d+>$/);
    // Raw values must not survive.
    assert.ok(!JSON.stringify(out).includes('private notes'));
    assert.ok(!JSON.stringify(out).includes('a@x.com'));
  });

  it('redactArgsForAudit: empty description / no attendees passes through cleanly', () => {
    const a = connector.actions.find(x => x.name === 'create_event')!;
    const out = a.redactArgsForAudit!({
      title: 'Solo block',
      start: '2026-05-01T10:00:00Z',
    });
    assert.strictEqual(out.title, 'Solo block');
    assert.strictEqual(out.description, undefined);
    assert.strictEqual(out.attendees, undefined);
  });

  it('contract validator passes with zero violations', () => {
    const violations = validateConnectorContract(connector);
    assert.strictEqual(violations.length, 0,
      `expected zero violations; got: ${JSON.stringify(violations)}`);
  });
});
