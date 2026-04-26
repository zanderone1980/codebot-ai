/**
 * Connector framework — base interfaces for app integrations.
 *
 * Terminology: "action" in this code == "verb" in
 * `docs/personal-agent-infrastructure.md` §8 (the connector contract).
 * They mean the same thing. We keep "action" in code to avoid renaming
 * 11 production connectors mechanically.
 *
 * PR 7 (2026-04-25) adds 4 optional contract fields to ConnectorAction
 * + 1 to Connector. All optional — existing connectors compile and run
 * unchanged. New / migrated connector PRs must pass the contract
 * validator (`validateConnectorContract` in connector-contract.ts) with
 * zero violations; the 11 existing connectors are measured but not
 * failed by CI until they migrate one-by-one.
 */

import type { CapabilityLabel } from '../types';

/**
 * Result of a preview / dry-run call. Per §8, any verb that mutates
 * remote state (`send-on-behalf`, `delete-data`, `spend-money`) MUST
 * support preview mode. The agent loop will call preview, show the
 * user, and only invoke `execute()` after approval.
 */
export interface ConnectorPreview {
  /** Human-readable summary the user reviews before authorizing. */
  summary: string;
  /** Structured snapshot — for dashboard / JSON consumers. Free-form. */
  details?: Record<string, unknown>;
}

export interface ConnectorAction {
  // ── Existing fields ──
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  execute(args: Record<string, unknown>, credential: string): Promise<string>;

  // ── PR 7 contract additions (all optional) ──

  /**
   * Capability labels that apply to THIS verb (per §7). More specific
   * than AppConnectorTool's tool-level union. Read-only verbs declare
   * `['read-only', 'account-access', 'net-fetch']`; write verbs add
   * `'send-on-behalf'`; delete verbs add `'delete-data'`; checkout
   * verbs add `'spend-money'`.
   *
   * In PR 7 these labels are METADATA ONLY — AppConnectorTool's gating
   * still uses its tool-level union. Per-verb gating is a future PR.
   */
  capabilities?: CapabilityLabel[];

  /**
   * Optional dry-run. Per §8 connector contract, REQUIRED for any verb
   * whose `capabilities` include `'send-on-behalf'`, `'delete-data'`,
   * or `'spend-money'`. Returns what *would* happen without executing.
   */
  preview?(args: Record<string, unknown>, credential: string): Promise<ConnectorPreview>;

  /**
   * Name of the args field that carries the user-supplied idempotency
   * key (e.g. `'message_id'` for Gmail send). Set when the underlying
   * service supports duplicate-submit protection.
   *
   * If the service does NOT support idempotency, leave this undefined
   * and set `idempotencyUnsupportedReason` instead — that's the
   * explicit "documented gap" the §8 contract requires. Setting
   * neither on a mutating verb fails `assertContractClean`.
   */
  idempotencyKeyArg?: string;

  /**
   * Documented reason that this verb does NOT support idempotency
   * (the underlying service has no message-id / request-id / dedup
   * mechanism). Set this instead of `idempotencyKeyArg` to honestly
   * declare the gap. Reason should be a short technical sentence —
   * e.g. `'Slack chat.postMessage has no client-side dedup key.'`.
   *
   * The contract validator accepts either `idempotencyKeyArg` OR
   * `idempotencyUnsupportedReason` for mutating verbs. Setting both
   * is allowed (a connector might support a partial dedup signal but
   * also document a known gap). Setting neither is a violation.
   */
  idempotencyUnsupportedReason?: string;

  /**
   * Returns a sanitized version of args for audit logging. Default
   * (when omitted): identity — args pass through raw.
   *
   * Override for verbs that carry secrets, full message bodies, or
   * PII. Output should redact to a hash + length, not omit silently
   * — auditors need to know SOMETHING was there.
   */
  redactArgsForAudit?(args: Record<string, unknown>): Record<string, unknown>;
}

export interface Connector {
  /** Lowercase slug: 'github', 'slack', 'jira', 'linear' */
  name: string;
  /** Human-readable: 'GitHub', 'Slack', 'Jira', 'Linear' */
  displayName: string;
  description: string;
  authType: 'api_key' | 'oauth' | 'webhook_url';
  /** Auto-detect env var: 'GITHUB_TOKEN' */
  envKey?: string;
  /** For multi-key auth like Jira (token + email + url) */
  requiredEnvKeys?: string[];
  actions: ConnectorAction[];
  /** Test if the credential is valid (makes a real API call) */
  validate(credential: string): Promise<boolean>;

  // ── PR 7 contract additions (all optional) ──

  /**
   * Vault key under which this connector's credential is stored. When
   * omitted, defaults to `connector.name` (current behavior). Surfacing
   * it explicitly lets the contract validator + audit log declare
   * provenance without ambiguity.
   */
  vaultKeyName?: string;
}

/**
 * Structured re-authentication signal (PR 7 contract — auth/reauth
 * behavior). Connectors throw this when they detect the credential is
 * expired, revoked, or insufficient. AppConnectorTool catches it and
 * formats a recognizable error string for the tool caller.
 *
 * Tests assert `err instanceof ConnectorReauthError` or
 * `isConnectorReauthError(err)` BEFORE any string formatting —
 * the structure is the contract, the string is the rendering.
 *
 * Existing connectors that throw raw HTTP errors continue to work;
 * opting into structured reauth is per-connector and gradual.
 */
export class ConnectorReauthError extends Error {
  /**
   * Discriminator for downstream code that prefers structural matching
   * to `instanceof` (e.g. cross-realm error objects). Same string for
   * every instance: `'reauth-required'`.
   */
  readonly kind = 'reauth-required' as const;

  constructor(public readonly service: string, message?: string) {
    super(message ?? `Re-authentication required for ${service}`);
    this.name = 'ConnectorReauthError';
  }
}

/** Type guard. Useful for cross-realm or transport-decoded errors. */
export function isConnectorReauthError(err: unknown): err is ConnectorReauthError {
  return (
    err instanceof ConnectorReauthError ||
    (typeof err === 'object' && err !== null && (err as { kind?: unknown }).kind === 'reauth-required')
  );
}
