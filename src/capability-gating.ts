/**
 * Capability-label gating helpers (PR 4 of personal-agent-infrastructure.md).
 *
 * Pure module — no side effects. Maps each `CapabilityLabel` to the
 * permission level §7 of the architecture doc says is required, then
 * combines a tool's declared labels into a single "strictest" permission.
 *
 * Used by `_prepareToolCall` (`src/agent.ts`) to escalate the effective
 * permission monotonically upward — never weaken what policy or the tool
 * already declared.
 *
 * Naming: deliberately avoids `checkToolCapabilities`, which already
 * exists in `src/agent/tool-executor.ts` for resource-level restrictions
 * (e.g. `tools.capabilities.execute.shell_commands: ['npm']`). The two
 * concepts share the word "capability" but are distinct layers.
 */

import type { CapabilityLabel } from './types';

export type Permission = 'auto' | 'prompt' | 'always-ask';

/**
 * Mapping from §7. Each label declares the gate it implies in isolation.
 * The combine rule (`strictestPermissionForCapabilityLabels`) picks the
 * strictest across all of a tool's labels.
 *
 *   read-only / browser-read              → 'auto'
 *   write-fs / run-cmd / net-fetch /
 *     account-access                       → 'prompt'
 *   send-on-behalf / delete-data /
 *     browser-write / spend-money          → 'always-ask'
 *   move-money                             → 'always-ask' (never reached;
 *                                            registration rejects first)
 */
export const LABEL_TO_PERMISSION: Readonly<Record<CapabilityLabel, Permission>> = Object.freeze({
  'read-only':       'auto',
  'browser-read':    'auto',
  'write-fs':        'prompt',
  'run-cmd':         'prompt',
  'net-fetch':       'prompt',
  'account-access':  'prompt',
  'send-on-behalf':  'always-ask',
  'delete-data':     'always-ask',
  'browser-write':   'always-ask',
  'spend-money':     'always-ask',
  'move-money':      'always-ask',
});

export function permissionRank(p: Permission): number {
  return p === 'always-ask' ? 2 : p === 'prompt' ? 1 : 0;
}

/**
 * Compute the strictest permission implied by a list of capability labels.
 * Returns `'auto'` for an empty list (no escalation).
 */
export function strictestPermissionForCapabilityLabels(
  labels: ReadonlyArray<CapabilityLabel> | undefined,
): Permission {
  if (!labels || labels.length === 0) return 'auto';
  let strictest: Permission = 'auto';
  for (const label of labels) {
    const required = LABEL_TO_PERMISSION[label];
    if (required && permissionRank(required) > permissionRank(strictest)) {
      strictest = required;
    }
  }
  return strictest;
}

/**
 * Return the subset of labels whose required gate matches the given
 * target permission. Used to build human-readable audit reasons:
 *   "capability labels require always-ask: send-on-behalf, delete-data"
 */
export function labelsRequiringPermission(
  labels: ReadonlyArray<CapabilityLabel> | undefined,
  target: Permission,
): CapabilityLabel[] {
  if (!labels) return [];
  return labels.filter((l) => LABEL_TO_PERMISSION[l] === target);
}

/**
 * Result of evaluating capability-driven escalation against an existing
 * effective permission.
 *
 * `escalated` is true iff the labels demand a stricter gate than was
 * already in effect. `triggeringLabels` is the subset of labels that
 * *cause* the escalation (the ones whose required permission equals
 * `permission`); used for audit-log reasons. When not escalating, both
 * are empty / false.
 */
export interface CapabilityEscalation {
  escalated: boolean;
  permission: Permission;
  triggeringLabels: CapabilityLabel[];
}

/**
 * Decide whether (and how) capability labels escalate `current` upward.
 * Pure: no side effects, no audit calls — caller decides what to do.
 */
export function escalatePermissionFromCapabilityLabels(
  current: Permission,
  labels: ReadonlyArray<CapabilityLabel> | undefined,
): CapabilityEscalation {
  const capPermission = strictestPermissionForCapabilityLabels(labels);
  if (permissionRank(capPermission) > permissionRank(current)) {
    return {
      escalated: true,
      permission: capPermission,
      triggeringLabels: labelsRequiringPermission(labels, capPermission),
    };
  }
  return { escalated: false, permission: current, triggeringLabels: [] };
}
