/**
 * Capability allowlist parsing & validation (PR 11).
 *
 * Purpose
 * -------
 * §7 of `docs/personal-agent-infrastructure.md` makes capability-driven
 * permission gates immune to `--auto-approve`. That is correct — it means
 * a connector tool labeled `account-access` cannot silently fire just
 * because the user asked for autonomous mode. But it also makes
 * unattended runs of read-only connector actions impossible: every
 * `github.list_prs`, every `gmail.list_threads`, every `slack.list_channels`
 * needs an interactive `y` keystroke.
 *
 * The allowlist gives the user a deliberate, auditable escape hatch:
 *
 *     codebot --auto-approve --allow-capability account-access,net-fetch ...
 *
 * Rules
 * -----
 * 1. Only labels named *explicitly* on the CLI are permitted. No wildcards.
 * 2. The four labels in `NEVER_ALLOWABLE` are rejected at parse time. Even
 *    if the user types `--allow-capability move-money`, this module fails
 *    fast with a hard error — there is no path that silently strips them.
 * 3. Unknown labels are also rejected at parse time. We compare against
 *    the closed `CapabilityLabel` union, so `--allow-capability foobar`
 *    is a startup error, not a silent no-op.
 *
 * What this module is NOT
 * -----------------------
 * - It does NOT store anything to disk. The allowlist is session-scoped.
 *   Persistent allowlists are deliberately deferred (more thinking needed
 *   on the audit / revocation story).
 * - It does NOT decide whether to bypass a gate. That's the agent's job;
 *   this module only validates the user's input.
 */

import type { CapabilityLabel } from './types';

/**
 * Labels that this PR refuses to allowlist, ever.
 *
 * - `move-money` is §2 PROHIBITED at the registration layer; this is a
 *   defense-in-depth duplicate, not the primary block.
 * - `spend-money`, `send-on-behalf`, `delete-data` are deferred to a
 *   future stronger-flag PR. Right now the only way to invoke a tool
 *   with one of these labels is interactive approval per call.
 */
export const NEVER_ALLOWABLE: ReadonlySet<CapabilityLabel> = Object.freeze(
  new Set<CapabilityLabel>([
    'move-money',
    'spend-money',
    'send-on-behalf',
    'delete-data',
  ]),
);

/**
 * The closed set of labels that may legitimately be passed to
 * `--allow-capability`. Computed from the public union minus the never-
 * allowable list. Keep in sync with `LABEL_TO_PERMISSION` in
 * `capability-gating.ts` if new labels are added.
 */
export const CURRENTLY_ALLOWABLE: ReadonlySet<CapabilityLabel> = Object.freeze(
  new Set<CapabilityLabel>([
    'read-only',
    'browser-read',
    'write-fs',
    'run-cmd',
    'net-fetch',
    'account-access',
    'browser-write',
  ]),
);

export class CapabilityAllowlistError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CapabilityAllowlistError';
  }
}

/**
 * Parse a comma-separated `--allow-capability` value into a validated
 * Set. Throws `CapabilityAllowlistError` on any unknown or never-allowed
 * label so the CLI can surface a precise, actionable startup failure.
 *
 * Whitespace around tokens is trimmed. Empty tokens are ignored. Case
 * matching is exact (lowercase, hyphen-separated) to keep the audit row
 * unambiguous and the closed set obvious.
 */
export function parseAllowCapabilityFlag(raw: string): Set<CapabilityLabel> {
  const allowed = new Set<CapabilityLabel>();
  if (!raw || !raw.trim()) return allowed;

  const tokens = raw.split(',').map(t => t.trim()).filter(t => t.length > 0);

  for (const token of tokens) {
    // Hard exclusions — fail before considering whether the label is even
    // a real CapabilityLabel, so the user gets a precise error rather
    // than a generic "unknown label."
    if (NEVER_ALLOWABLE.has(token as CapabilityLabel)) {
      throw new CapabilityAllowlistError(
        `Refusing to allowlist capability "${token}": this label is not eligible ` +
        `for --allow-capability. Labels in the never-allowable set ` +
        `(${[...NEVER_ALLOWABLE].join(', ')}) require interactive per-call approval ` +
        `or a future stronger-flag mechanism. See docs/personal-agent-infrastructure.md §7.`,
      );
    }
    if (!CURRENTLY_ALLOWABLE.has(token as CapabilityLabel)) {
      throw new CapabilityAllowlistError(
        `Unknown or unsupported capability label "${token}". ` +
        `Allowable labels: ${[...CURRENTLY_ALLOWABLE].sort().join(', ')}.`,
      );
    }
    allowed.add(token as CapabilityLabel);
  }

  return allowed;
}
