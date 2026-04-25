import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { ToolRegistry } from './index';
import type { CapabilityLabel } from '../types';

/**
 * PR 3 introspection test — capability label coverage.
 *
 * Per §12 of `docs/personal-agent-infrastructure.md`:
 *   "% of registered tools with capability labels — Reaches 100% by
 *    end of PR 3. Stays at 100% (S4 + the doc-rot rule)."
 *
 * This test enforces the 100% bar in CI. Any new tool added to
 * `ToolRegistry` without `capabilities = [...]` declared on its class
 * fails the build. Mechanical guardrail; the labels themselves are
 * mechanically reviewed at PR time, but absence is automated.
 *
 * It also pins the union of valid labels so a typo (`'send-on-behalv'`)
 * fails loudly instead of silently slipping through `as` casts.
 */

const VALID_LABELS: ReadonlyArray<CapabilityLabel> = [
  'read-only',
  'write-fs',
  'run-cmd',
  'browser-read',
  'browser-write',
  'net-fetch',
  'account-access',
  'send-on-behalf',
  'delete-data',
  'spend-money',
  'move-money',
];

describe('ToolRegistry — capability label coverage (PR 3 enforcement)', () => {
  // Use a default-constructed registry so the same set of tools that
  // run in production is exercised here. AppConnectorTool may be
  // absent if vault init fails on the test host; that's fine — we
  // assert against whatever IS registered.
  const registry = new ToolRegistry();
  const tools = registry.all();

  it('registers a non-zero number of tools', () => {
    assert.ok(tools.length > 0, 'expected ToolRegistry to contain tools');
  });

  it('every registered tool declares a non-empty capabilities array', () => {
    const missing: string[] = [];
    const empty: string[] = [];
    for (const t of tools) {
      if (t.capabilities === undefined) { missing.push(t.name); continue; }
      if (!Array.isArray(t.capabilities)) {
        missing.push(`${t.name} (capabilities is not an array)`);
        continue;
      }
      if (t.capabilities.length === 0) { empty.push(t.name); continue; }
    }
    assert.deepStrictEqual(missing, [],
      `tools missing capabilities: ${missing.join(', ')}`);
    assert.deepStrictEqual(empty, [],
      `tools with empty capabilities (use the union of action-level needs, never []): ${empty.join(', ')}`);
  });

  it('every declared label is a valid CapabilityLabel from the §7 union', () => {
    const validSet = new Set<string>(VALID_LABELS);
    const violations: Array<{ tool: string; label: string }> = [];
    for (const t of tools) {
      if (!t.capabilities) continue;
      for (const label of t.capabilities) {
        if (!validSet.has(label)) {
          violations.push({ tool: t.name, label });
        }
      }
    }
    assert.deepStrictEqual(violations, [],
      `unknown labels declared: ${JSON.stringify(violations)}. Valid set: ${VALID_LABELS.join(', ')}`);
  });

  it('no tool declares the move-money label (PROHIBITED per §2/§7)', () => {
    // PR 3 invariant: tools with move-money cannot exist/register.
    // This test pins that. PR 4 will additionally enforce it at the
    // gate level (rejecting any registered tool that carries it).
    const offenders = tools
      .filter(t => t.capabilities?.includes('move-money'))
      .map(t => t.name);
    assert.deepStrictEqual(offenders, [],
      `tools declaring PROHIBITED label "move-money": ${offenders.join(', ')}. Per §2, move-money tools must not exist.`);
  });

  it('capabilities array contains no duplicates', () => {
    const dupes: Array<{ tool: string; label: string }> = [];
    for (const t of tools) {
      if (!t.capabilities) continue;
      const seen = new Set<string>();
      for (const label of t.capabilities) {
        if (seen.has(label)) {
          dupes.push({ tool: t.name, label });
        }
        seen.add(label);
      }
    }
    assert.deepStrictEqual(dupes, [],
      `duplicate labels: ${JSON.stringify(dupes)}`);
  });
});
