/**
 * Test connector — fully-compliant fixture for PR 7's §8 contract.
 *
 * NOT REGISTERED IN PRODUCTION. This file exports a `Connector` whose
 * actions exercise every required field on the contract: capability
 * labels, preview for mutating verbs, idempotency keys, audit
 * redaction. Tests construct it directly to prove the contract scaffold
 * is consistent end-to-end without rewriting any of the 11 production
 * connectors.
 *
 * If you're adding a new production connector, this file is your
 * reference — every field declared here is mandatory under the
 * §8 contract and `assertContractClean` will fail without them.
 */

import type { Connector, ConnectorAction, ConnectorPreview } from './base';
import { ConnectorReauthError } from './base';
import { createHash } from 'crypto';

/** Stable hash suitable for audit redaction. SHA-256, hex-encoded. */
function hashAndLength(value: string): { hash: string; length: number } {
  return {
    hash: createHash('sha256').update(value).digest('hex').substring(0, 16),
    length: value.length,
  };
}

const readThing: ConnectorAction = {
  name: 'read_thing',
  description: 'Read a thing by id. Read-only — no preview / idempotency required.',
  parameters: {
    type: 'object',
    properties: { id: { type: 'string' } },
    required: ['id'],
  },
  capabilities: ['read-only', 'account-access', 'net-fetch'],
  // No preview, no idempotencyKeyArg, no redactArgsForAudit — read-only
  // verbs are exempt from those requirements per the contract.
  execute: async (args, _credential) => {
    return `read: ${args.id as string}`;
  },
};

const sendThing: ConnectorAction = {
  name: 'send_thing',
  description: 'Send a thing — exercises send-on-behalf, preview, idempotency, redaction.',
  parameters: {
    type: 'object',
    properties: {
      to: { type: 'string' },
      body: { type: 'string' },
      request_id: { type: 'string', description: 'Idempotency key (passed through to the service)' },
    },
    required: ['to', 'body'],
  },
  capabilities: ['account-access', 'net-fetch', 'send-on-behalf'],
  idempotencyKeyArg: 'request_id',
  // Preview shows what would happen without firing the send.
  preview: async (args, _credential): Promise<ConnectorPreview> => {
    const to = String(args.to ?? '');
    const body = String(args.body ?? '');
    const bodyDigest = hashAndLength(body);
    return {
      summary: `Would send to ${to} (body: ${bodyDigest.length} chars, sha256:${bodyDigest.hash})`,
      details: { to, bodyHash: bodyDigest.hash, bodyLength: bodyDigest.length },
    };
  },
  // Body is sensitive — replace with hash + length. Preserves auditor's
  // ability to detect "something was there" without leaking content.
  redactArgsForAudit: (args) => {
    const out: Record<string, unknown> = { ...args };
    if (typeof args.body === 'string') {
      const d = hashAndLength(args.body);
      out.body = `<redacted sha256:${d.hash} len:${d.length}>`;
    }
    return out;
  },
  execute: async (args, _credential) => {
    return `sent to ${args.to as string}`;
  },
};

const deleteThing: ConnectorAction = {
  name: 'delete_thing',
  description: 'Delete a thing — exercises delete-data, preview, idempotency, redaction.',
  parameters: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      request_id: { type: 'string' },
    },
    required: ['id'],
  },
  capabilities: ['account-access', 'net-fetch', 'delete-data'],
  idempotencyKeyArg: 'request_id',
  preview: async (args, _credential): Promise<ConnectorPreview> => ({
    summary: `Would delete thing id="${args.id as string}"`,
    details: { id: args.id },
  }),
  // No body field; default identity-style redaction is appropriate here,
  // but the contract still requires the function to be DECLARED — even
  // if it's the trivial passthrough. That's the deliberate-call rule.
  redactArgsForAudit: (args) => ({ ...args }),
  execute: async (args, _credential) => {
    return `deleted ${args.id as string}`;
  },
};

const reauthTrip: ConnectorAction = {
  name: 'reauth_trip',
  description: 'Always throws a structured ConnectorReauthError. Read-only label set; for tests.',
  parameters: { type: 'object', properties: {} },
  capabilities: ['read-only', 'account-access', 'net-fetch'],
  execute: async () => {
    throw new ConnectorReauthError('test-connector', 'token expired');
  },
};

export class TestConnector implements Connector {
  name = 'test-connector';
  displayName = 'Test Connector';
  description = 'Fully-compliant §8 contract fixture. Never registered in production.';
  authType: Connector['authType'] = 'api_key';
  envKey = 'TEST_CONNECTOR_TOKEN';
  vaultKeyName = 'test-connector';
  actions: ConnectorAction[] = [readThing, sendThing, deleteThing, reauthTrip];
  async validate(_credential: string): Promise<boolean> {
    return true;
  }
}
