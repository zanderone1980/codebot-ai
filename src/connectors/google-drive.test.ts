/**
 * PR 18 — Google Drive §8 connector contract tests.
 *
 * Drive has 4 read-only actions, no mutating verbs. Coverage:
 *   - isGoogleDriveAuthError classification table (pure function),
 *     mirrors isGoogleCalendarAuthError from PR 14.
 *   - vaultKeyName declared
 *   - per-action capability labels (all read)
 *   - validateConnectorContract returns zero violations
 *   - read verbs deliberately have no preview / idempotency / redact
 *     (the contract requires those only on mutating verbs).
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { GoogleDriveConnector, isGoogleDriveAuthError } from './google-drive';
import { validateConnectorContract } from './connector-contract';

describe('isGoogleDriveAuthError', () => {
  it('401 → reauth (token expired/revoked)', () => {
    assert.strictEqual(isGoogleDriveAuthError(401, undefined), true);
    assert.strictEqual(isGoogleDriveAuthError(401, { error: { errors: [] } }), true);
  });

  it('200 / 404 / 500 → not reauth', () => {
    assert.strictEqual(isGoogleDriveAuthError(200, undefined), false);
    assert.strictEqual(isGoogleDriveAuthError(404, { error: { code: 404 } }), false);
    assert.strictEqual(isGoogleDriveAuthError(500, undefined), false);
  });

  it('403 with auth-class reason → reauth', () => {
    for (const reason of ['authError', 'invalidCredentials', 'insufficientPermissions']) {
      assert.strictEqual(
        isGoogleDriveAuthError(403, { error: { errors: [{ reason }] } }),
        true,
        `403 reason="${reason}" should be reauth`,
      );
    }
  });

  it('403 with rate/quota reason → NOT reauth', () => {
    for (const reason of ['rateLimitExceeded', 'userRateLimitExceeded', 'quotaExceeded', 'dailyLimitExceeded']) {
      assert.strictEqual(
        isGoogleDriveAuthError(403, { error: { errors: [{ reason }] } }),
        false,
        `403 reason="${reason}" must NOT trigger reauth`,
      );
    }
  });

  it('403 with mixed auth + rate reasons → NOT reauth (conservative)', () => {
    assert.strictEqual(
      isGoogleDriveAuthError(403, {
        error: { errors: [{ reason: 'authError' }, { reason: 'rateLimitExceeded' }] },
      }),
      false,
    );
  });

  it('403 with unrecognized / no reason → NOT reauth (fail closed)', () => {
    assert.strictEqual(
      isGoogleDriveAuthError(403, { error: { errors: [{ reason: 'mysteryProblem' }] } }),
      false,
    );
    assert.strictEqual(isGoogleDriveAuthError(403, { error: {} }), false);
    assert.strictEqual(isGoogleDriveAuthError(403, undefined), false);
  });
});

describe('GoogleDriveConnector — §8 contract surface', () => {
  const connector = new GoogleDriveConnector();

  it('declares vaultKeyName=google_drive', () => {
    assert.strictEqual(connector.vaultKeyName, 'google_drive');
  });

  it('exposes the 4 expected actions', () => {
    const names = connector.actions.map(a => a.name).sort();
    assert.deepStrictEqual(names, ['get_file_info', 'list_files', 'read_file', 'search_files']);
  });

  it('every action is read-only with the same capability triple', () => {
    for (const a of connector.actions) {
      assert.deepStrictEqual(
        a.capabilities,
        ['read-only', 'account-access', 'net-fetch'],
        `action ${a.name} should declare exactly the read triple`,
      );
    }
  });

  it('read verbs have NO preview / idempotency / redactArgsForAudit (contract exempts read)', () => {
    for (const a of connector.actions) {
      assert.strictEqual(a.preview, undefined, `${a.name} must not declare preview (read-only)`);
      assert.strictEqual(a.idempotency, undefined, `${a.name} must not declare idempotency (read-only)`);
      assert.strictEqual(a.redactArgsForAudit, undefined, `${a.name} must not declare redactArgsForAudit (read-only)`);
    }
  });

  it('contract validator passes with zero violations', () => {
    const violations = validateConnectorContract(connector);
    assert.strictEqual(violations.length, 0,
      `expected zero violations; got: ${JSON.stringify(violations)}`);
  });
});
