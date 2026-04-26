/**
 * Connector contract validator (PR 7 of personal-agent-infrastructure.md).
 *
 * Pure module. Walks a `Connector` and reports violations against the
 * §8 binding contract:
 *   - credential source (vault key name, declared)
 *   - capability labels per verb
 *   - auth/reauth (catchable structured error — contract on the
 *     connector code, not statically detectable here)
 *   - audit redaction for sensitive args
 *   - dry-run / preview for `send-on-behalf` / `delete-data` /
 *     `spend-money` verbs
 *   - idempotency / duplicate-submit (or explicit gap)
 *
 * Hard-fail rule (per §8 + Alex's PR 7 review):
 *   - **Existing connectors:** measured, NON-FAILING compliance report.
 *   - **New / migrated connector PRs:** must pass `assertContractClean`
 *     with zero violations. Reviewer rejects otherwise.
 *
 * The 11 production connectors registered today are *not* required to
 * pass this in PR 7 — they migrate one PR at a time (PR 8 = Gmail
 * first). The contract-compliance test reports their score for
 * visibility; it does not break the build.
 */

import type { Connector, ConnectorAction } from './base';
import type { CapabilityLabel } from '../types';

/**
 * Mutating capability labels — verbs carrying any of these MUST
 * implement `preview` per §8.
 */
const MUTATING_LABELS: ReadonlyArray<CapabilityLabel> = [
  'send-on-behalf',
  'delete-data',
  'spend-money',
];

export interface ContractViolation {
  connector: string;
  /** Action name when the violation is verb-scoped; undefined for connector-level. */
  action?: string;
  rule:
    | 'missing-capabilities'
    | 'missing-preview-for-mutating-verb'
    | 'missing-idempotency-declaration'
    | 'missing-redact-for-mutating-verb';
  hint: string;
}

export interface ContractScore {
  connector: string;
  totalActions: number;
  /** Actions that fully satisfy the contract for their declared capability set. */
  compliantActions: number;
  /** All violations encountered (multiple per action possible). */
  violations: ContractViolation[];
}

/**
 * Collect every contract violation for `c`. Pure — no side effects.
 * Returns an empty array iff every action satisfies the contract for
 * its declared capability set.
 */
export function validateConnectorContract(c: Connector): ContractViolation[] {
  const out: ContractViolation[] = [];

  for (const action of c.actions) {
    visitAction(c.name, action, out);
  }

  return out;
}

function visitAction(connector: string, action: ConnectorAction, out: ContractViolation[]): void {
  // Rule 1 — every action must declare its capability labels.
  // Without labels, AppConnectorTool can't make per-verb decisions and
  // we can't even tell whether the other rules apply. This is the
  // foundational rule: a verb without labels is the contract failing
  // at step zero.
  if (!action.capabilities || action.capabilities.length === 0) {
    out.push({
      connector,
      action: action.name,
      rule: 'missing-capabilities',
      hint: `Declare \`capabilities: CapabilityLabel[]\` on action "${action.name}". See §7 for the label set.`,
    });
    // Without labels we cannot meaningfully apply the mutating-verb
    // rules — return early, more violations would just be noise.
    return;
  }

  // Rule 2 — mutating verbs MUST support preview.
  const mutating = action.capabilities.filter((l) => MUTATING_LABELS.includes(l));
  if (mutating.length > 0) {
    if (typeof action.preview !== 'function') {
      out.push({
        connector,
        action: action.name,
        rule: 'missing-preview-for-mutating-verb',
        hint: `Action "${action.name}" carries [${mutating.join(', ')}] and must implement \`preview(args, credential)\`. The agent calls preview, shows the user, and only invokes execute() on approval.`,
      });
    }
    // Rule 3 — mutating verbs need a redaction function. Default
    // identity is fine for read-only verbs but a write/delete/spend
    // call should declare what it considers sensitive — even if the
    // declaration is "everything is fine, identity is correct here."
    // The contract is "make a deliberate call," not "default through."
    if (typeof action.redactArgsForAudit !== 'function') {
      out.push({
        connector,
        action: action.name,
        rule: 'missing-redact-for-mutating-verb',
        hint: `Action "${action.name}" carries [${mutating.join(', ')}] and must declare \`redactArgsForAudit(args)\`. If no redaction is needed, declare it explicitly returning args unchanged — the contract is a deliberate call, not a default.`,
      });
    }
  }

  // Rule 4 — idempotency. We don't *require* a key (some services don't
  // support it). But we DO require an explicit declaration on every
  // mutating verb: either `idempotencyKeyArg` set, OR
  // `idempotencyUnsupportedReason` documenting why no key exists.
  // Setting NEITHER is the violation — that's the implicit-gap pattern
  // we're trying to prevent. Read-only verbs are exempt entirely.
  const hasIdempotencyKey = typeof action.idempotencyKeyArg === 'string' && action.idempotencyKeyArg.length > 0;
  const hasUnsupportedReason = typeof action.idempotencyUnsupportedReason === 'string' && action.idempotencyUnsupportedReason.length > 0;
  if (mutating.length > 0 && !hasIdempotencyKey && !hasUnsupportedReason) {
    out.push({
      connector,
      action: action.name,
      rule: 'missing-idempotency-declaration',
      hint: `Action "${action.name}" is mutating and must declare either \`idempotencyKeyArg\` (name of the args field carrying a user-supplied dedup key) OR \`idempotencyUnsupportedReason\` (documented gap when the service has no dedup mechanism). Setting neither is the implicit-gap pattern §8 prohibits.`,
    });
  }
}

/**
 * Aggregate score for a single connector. Used by the
 * contract-compliance test to print a per-connector table without
 * failing the build. New connector PRs use `assertContractClean`
 * instead, which throws on any violation.
 */
export function scoreConnector(c: Connector): ContractScore {
  const violations = validateConnectorContract(c);
  // An action is "compliant" if no violations name it specifically.
  const offending = new Set(violations.map((v) => v.action).filter(Boolean));
  const compliantActions = c.actions.filter((a) => !offending.has(a.name)).length;
  return {
    connector: c.name,
    totalActions: c.actions.length,
    compliantActions,
    violations,
  };
}

/**
 * Hard-fail variant for new / migrated connector PRs (per §8).
 * Throws an Error listing every violation.
 *
 *   import { assertContractClean } from './connector-contract';
 *   it('Gmail connector passes the §8 contract', () => {
 *     assertContractClean(new GmailConnector());
 *   });
 */
export function assertContractClean(c: Connector): void {
  const violations = validateConnectorContract(c);
  if (violations.length === 0) return;
  const lines = violations.map(
    (v) => `  [${v.rule}] ${v.connector}.${v.action ?? '*'}: ${v.hint}`,
  );
  throw new Error(
    `Connector "${c.name}" has ${violations.length} contract violation(s):\n${lines.join('\n')}`,
  );
}

/** Pretty-print a list of connector scores as a table for test output. */
export function formatScoreTable(scores: ContractScore[]): string {
  if (scores.length === 0) return '(no connectors)';
  const lines: string[] = ['Connector contract compliance (§8 of personal-agent-infrastructure.md):'];
  for (const s of scores) {
    const pct = s.totalActions === 0 ? '—' : `${Math.round((s.compliantActions / s.totalActions) * 100)}%`;
    lines.push(`  ${s.connector.padEnd(18)}  ${s.compliantActions}/${s.totalActions} actions clean  (${pct})`);
  }
  return lines.join('\n');
}
