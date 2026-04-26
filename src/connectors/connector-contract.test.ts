import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  validateConnectorContract,
  scoreConnector,
  assertContractClean,
  formatScoreTable,
} from './connector-contract';
import { ConnectorReauthError, isConnectorReauthError } from './base';
import type { Connector, ConnectorAction } from './base';
import { TestConnector } from './test-connector';

/**
 * PR 7 — connector contract tests.
 *
 * Pins:
 *   - The validator catches each rule violation correctly.
 *   - `assertContractClean` throws a recognizable error when something
 *     is missing, and is silent when everything is in place.
 *   - `ConnectorReauthError` is structurally catchable BEFORE any
 *     string formatting (the kind === 'reauth-required' check works
 *     across realm-decoded errors too).
 *   - Test fixture (`TestConnector`) passes the contract clean.
 */

describe('validateConnectorContract — rule coverage', () => {
  it('flags actions with no capabilities (rule: missing-capabilities)', () => {
    const c: Connector = {
      name: 'fixture-no-caps',
      displayName: 'Fixture',
      description: '',
      authType: 'api_key',
      actions: [
        {
          name: 'do_something',
          description: 'no capabilities declared',
          parameters: { type: 'object', properties: {} },
          execute: async () => 'ok',
        },
      ],
      validate: async () => true,
    };
    const violations = validateConnectorContract(c);
    assert.strictEqual(violations.length, 1);
    assert.strictEqual(violations[0].rule, 'missing-capabilities');
    assert.strictEqual(violations[0].action, 'do_something');
  });

  it('does NOT cascade other rules when capabilities are missing', () => {
    // The validator returns early for an action without labels — without
    // labels we cannot meaningfully apply the mutating-verb rules.
    // Multiple violations on the same action would just be noise.
    const c: Connector = {
      name: 'fixture-cascade',
      displayName: '',
      description: '',
      authType: 'api_key',
      actions: [
        {
          name: 'no_labels',
          description: '',
          parameters: { type: 'object', properties: {} },
          execute: async () => 'ok',
        },
      ],
      validate: async () => true,
    };
    const violations = validateConnectorContract(c);
    assert.strictEqual(violations.length, 1, 'only the foundational rule should fire');
  });

  it('flags mutating verb missing preview', () => {
    const c: Connector = {
      name: 'fixture-no-preview',
      displayName: '',
      description: '',
      authType: 'api_key',
      actions: [
        {
          name: 'send_thing',
          description: '',
          parameters: { type: 'object', properties: {} },
          capabilities: ['send-on-behalf'],
          // no preview, no idempotency, no redact — three violations expected
          execute: async () => 'ok',
        },
      ],
      validate: async () => true,
    };
    const rules = validateConnectorContract(c).map((v) => v.rule).sort();
    assert.deepStrictEqual(
      rules,
      ['missing-idempotency-declaration', 'missing-preview-for-mutating-verb', 'missing-redact-for-mutating-verb'],
    );
  });

  it('flags mutating verb missing redactArgsForAudit', () => {
    const action: ConnectorAction = {
      name: 'delete_thing',
      description: '',
      parameters: { type: 'object', properties: {} },
      capabilities: ['delete-data'],
      preview: async () => ({ summary: 'would delete' }),
      idempotencyKeyArg: 'rid',
      // no redactArgsForAudit
      execute: async () => 'ok',
    };
    const c: Connector = {
      name: 'fixture-no-redact', displayName: '', description: '',
      authType: 'api_key', actions: [action], validate: async () => true,
    };
    const rules = validateConnectorContract(c).map((v) => v.rule);
    assert.deepStrictEqual(rules, ['missing-redact-for-mutating-verb']);
  });

  it('flags mutating verb missing both idempotencyKeyArg AND idempotencyUnsupportedReason', () => {
    const action: ConnectorAction = {
      name: 'send_thing',
      description: '',
      parameters: { type: 'object', properties: {} },
      capabilities: ['send-on-behalf'],
      preview: async () => ({ summary: 'would send' }),
      redactArgsForAudit: (a) => ({ ...a }),
      // neither idempotencyKeyArg nor idempotencyUnsupportedReason
      execute: async () => 'ok',
    };
    const c: Connector = {
      name: 'fixture-no-idem', displayName: '', description: '',
      authType: 'api_key', actions: [action], validate: async () => true,
    };
    const rules = validateConnectorContract(c).map((v) => v.rule);
    assert.deepStrictEqual(rules, ['missing-idempotency-declaration']);
  });

  it('idempotencyUnsupportedReason satisfies the rule (escape hatch for services without dedup)', () => {
    // Concrete real-world case: Slack chat.postMessage has no client-side
    // dedup key. The contract MUST allow honest "we know, here's why"
    // declaration — anything else forces dishonest fake idempotency args.
    const action: ConnectorAction = {
      name: 'post_message',
      description: '',
      parameters: { type: 'object', properties: {} },
      capabilities: ['send-on-behalf'],
      preview: async () => ({ summary: 'would post' }),
      redactArgsForAudit: (a) => ({ ...a }),
      idempotencyUnsupportedReason: 'Slack chat.postMessage has no client-side dedup key.',
      // no idempotencyKeyArg — explicitly documented as unsupported
      execute: async () => 'ok',
    };
    const c: Connector = {
      name: 'fixture-no-dedup-supported', displayName: '', description: '',
      authType: 'api_key', actions: [action], validate: async () => true,
    };
    assert.deepStrictEqual(validateConnectorContract(c), [],
      'unsupportedReason must be accepted as an honest declaration');
  });

  it('both idempotencyKeyArg AND idempotencyUnsupportedReason allowed (partial dedup with documented gap)', () => {
    // A connector might support dedup for some args paths but not
    // others, or want to record a known limitation alongside the key.
    // The contract should not force exclusivity.
    const action: ConnectorAction = {
      name: 'send_thing',
      description: '',
      parameters: { type: 'object', properties: {} },
      capabilities: ['send-on-behalf'],
      preview: async () => ({ summary: 'would send' }),
      redactArgsForAudit: (a) => ({ ...a }),
      idempotencyKeyArg: 'request_id',
      idempotencyUnsupportedReason: 'Server only dedupes within a 5-minute window.',
      execute: async () => 'ok',
    };
    const c: Connector = {
      name: 'fixture-both', displayName: '', description: '',
      authType: 'api_key', actions: [action], validate: async () => true,
    };
    assert.deepStrictEqual(validateConnectorContract(c), [],
      'declaring both should be allowed — the gap note is documentation, not exclusion');
  });

  it('empty-string idempotencyUnsupportedReason does NOT satisfy the rule', () => {
    // Empty string would be too easy a way to defeat the contract
    // ("technically declared"). Validator requires non-empty reason.
    const action: ConnectorAction = {
      name: 'send_thing',
      description: '',
      parameters: { type: 'object', properties: {} },
      capabilities: ['send-on-behalf'],
      preview: async () => ({ summary: 'would send' }),
      redactArgsForAudit: (a) => ({ ...a }),
      idempotencyUnsupportedReason: '',
      execute: async () => 'ok',
    };
    const c: Connector = {
      name: 'fixture-empty-reason', displayName: '', description: '',
      authType: 'api_key', actions: [action], validate: async () => true,
    };
    const rules = validateConnectorContract(c).map((v) => v.rule);
    assert.deepStrictEqual(rules, ['missing-idempotency-declaration'],
      'empty reason string is not an honest declaration');
  });

  it('does NOT require preview / idempotency / redact for read-only verbs', () => {
    const action: ConnectorAction = {
      name: 'read_thing',
      description: '',
      parameters: { type: 'object', properties: {} },
      capabilities: ['read-only', 'account-access', 'net-fetch'],
      execute: async () => 'ok',
    };
    const c: Connector = {
      name: 'fixture-read-only', displayName: '', description: '',
      authType: 'api_key', actions: [action], validate: async () => true,
    };
    assert.deepStrictEqual(validateConnectorContract(c), []);
  });
});

describe('TestConnector — fully-compliant fixture passes the contract', () => {
  it('produces zero violations', () => {
    assert.deepStrictEqual(validateConnectorContract(new TestConnector()), []);
  });

  it('assertContractClean is silent on a clean connector', () => {
    assert.doesNotThrow(() => assertContractClean(new TestConnector()));
  });

  it('scoreConnector reports all actions clean', () => {
    const score = scoreConnector(new TestConnector());
    assert.strictEqual(score.compliantActions, score.totalActions);
    assert.strictEqual(score.violations.length, 0);
  });

  it('preview returns the documented shape (summary required, details optional)', async () => {
    const tc = new TestConnector();
    const send = tc.actions.find((a) => a.name === 'send_thing')!;
    assert.ok(typeof send.preview === 'function');
    const result = await send.preview!({ to: 'alice@example.com', body: 'hi' }, 'fake-credential');
    assert.ok(typeof result.summary === 'string' && result.summary.length > 0);
    // details is optional but our fixture provides it
    assert.ok(typeof result.details === 'object');
  });

  it('redactArgsForAudit replaces sensitive fields with hash + length', () => {
    const tc = new TestConnector();
    const send = tc.actions.find((a) => a.name === 'send_thing')!;
    const redacted = send.redactArgsForAudit!({ to: 'alice@x.com', body: 'top secret' });
    assert.strictEqual(redacted.to, 'alice@x.com', 'non-sensitive fields pass through');
    assert.match(String(redacted.body), /^<redacted sha256:[a-f0-9]+ len:\d+>$/,
      'body should be hash+length, not the original string');
  });
});

describe('assertContractClean — hard fail for new connector PRs', () => {
  it('throws on any violation, with message naming each rule', () => {
    const c: Connector = {
      name: 'fixture-noncompliant',
      displayName: '', description: '',
      authType: 'api_key',
      actions: [
        {
          name: 'send_thing',
          description: '',
          parameters: { type: 'object', properties: {} },
          capabilities: ['send-on-behalf'],
          execute: async () => 'ok',
          // missing preview, idempotency, redact
        },
      ],
      validate: async () => true,
    };
    assert.throws(
      () => assertContractClean(c),
      (e: Error) => {
        return /3 contract violation\(s\)/.test(e.message)
          && /missing-preview-for-mutating-verb/.test(e.message)
          && /missing-idempotency-declaration/.test(e.message)
          && /missing-redact-for-mutating-verb/.test(e.message);
      },
    );
  });
});

describe('ConnectorReauthError — structural catchability', () => {
  it('is catchable by instanceof', () => {
    let caught: unknown;
    try { throw new ConnectorReauthError('gmail', 'token expired'); }
    catch (e) { caught = e; }
    assert.ok(caught instanceof ConnectorReauthError);
  });

  it('exposes kind === "reauth-required" for cross-realm structural matching', () => {
    const e = new ConnectorReauthError('gmail');
    assert.strictEqual(e.kind, 'reauth-required');
    assert.strictEqual(e.service, 'gmail');
  });

  it('isConnectorReauthError handles cross-realm decoded errors (plain object with kind)', () => {
    const decoded = { kind: 'reauth-required', service: 'gmail', message: 'expired' };
    assert.strictEqual(isConnectorReauthError(decoded), true);
  });

  it('isConnectorReauthError rejects plain Error and unrelated objects', () => {
    assert.strictEqual(isConnectorReauthError(new Error('boom')), false);
    assert.strictEqual(isConnectorReauthError({ kind: 'something-else' }), false);
    assert.strictEqual(isConnectorReauthError(null), false);
    assert.strictEqual(isConnectorReauthError(undefined), false);
  });

  it('TestConnector reauth_trip throws ConnectorReauthError that can be matched by kind BEFORE rendering', async () => {
    const tc = new TestConnector();
    const trip = tc.actions.find((a) => a.name === 'reauth_trip')!;
    let caught: unknown;
    try { await trip.execute({}, 'creds'); }
    catch (e) { caught = e; }
    // Tests assert the structure is the contract — not just a string.
    assert.ok(isConnectorReauthError(caught), 'must be structurally catchable');
    assert.strictEqual((caught as ConnectorReauthError).kind, 'reauth-required');
    assert.strictEqual((caught as ConnectorReauthError).service, 'test-connector');
  });
});

describe('formatScoreTable — readable output for compliance report', () => {
  it('renders compliant connector with 100%', () => {
    const out = formatScoreTable([scoreConnector(new TestConnector())]);
    assert.match(out, /test-connector\s+\d+\/\d+ actions clean\s+\(100%\)/);
  });

  it('handles zero connectors', () => {
    assert.match(formatScoreTable([]), /no connectors/);
  });
});
