/**
 * PR 11 — Agent capability-allowlist + per-action resolution integration tests.
 *
 * Honest test premise: with the per-action capability resolution fix
 * (effectiveCapabilities) shipped alongside --allow-capability, the
 * landscape is:
 *
 *   - Read actions (e.g. `github.list_prs`) declare narrow labels whose
 *     strictest gate is `prompt`. The `app` tool's static permission is
 *     also `prompt`. No escalation fires. `--auto-approve` bypasses the
 *     prompt naturally. NO allowlist required.
 *
 *   - Write actions (e.g. `github.create_issue`) declare `send-on-behalf`,
 *     which forces the gate to `always-ask`. send-on-behalf is in
 *     NEVER_ALLOWABLE → cannot be allowlisted. Therefore: blocked under
 *     --auto-approve, with the new "blocked: required capability labels"
 *     deny-reason wording. Allowlist makes no difference for these.
 *
 *   - The allowlist matters where escalation legitimately fires AND
 *     the triggering labels are NOT in NEVER_ALLOWABLE — the synthetic
 *     tool case below.
 *
 * What the PR-brief blocker bug actually was: pre-PR-11, the agent
 * escalated against `tool.capabilities` (the worst-case union over every
 * connector action ever registered, which included send-on-behalf). So
 * even pure read-only `list_prs` got gated as `always-ask` and timed
 * out unattended. The fix is the per-action narrowing, not the allowlist.
 * The allowlist is the principled escape hatch for the smaller class of
 * tools where escalation correctly fires for non-NEVER_ALLOWABLE labels.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Agent } from './agent';
import type { LLMProvider, AgentEvent, ToolSchema, Message, StreamEvent, Tool } from './types';
import type { CapabilityLabel } from './types';
import { parseAllowCapabilityFlag } from './capability-allowlist';
import { makeTestAuditDir } from './test-audit-isolation';

function makeOneToolCallProvider(toolCall: { name: string; args: Record<string, unknown> }): LLMProvider {
  let yielded = false;
  return {
    name: 'stub',
    async *chat(_messages: Message[], _tools?: ToolSchema[]): AsyncGenerator<StreamEvent> {
      if (!yielded) {
        yielded = true;
        yield {
          type: 'tool_call_end',
          toolCall: {
            id: 'tc1',
            type: 'function',
            function: { name: toolCall.name, arguments: JSON.stringify(toolCall.args) },
          },
        };
      }
      yield { type: 'done' };
    },
  };
}

async function drainRun(agent: Agent, msg: string): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  for await (const ev of agent.run(msg)) events.push(ev);
  return events;
}

function readAuditRows(auditDir: string): Array<Record<string, unknown>> {
  const files = fs.readdirSync(auditDir).filter(f => f.startsWith('audit-'));
  const rows: Array<Record<string, unknown>> = [];
  for (const f of files) {
    const lines = fs.readFileSync(path.join(auditDir, f), 'utf-8').split('\n').filter(Boolean);
    for (const l of lines) rows.push(JSON.parse(l));
  }
  return rows;
}

describe('PR 11 — per-action resolution unblocks read connector actions', () => {
  it('app github.list_prs proceeds under --auto-approve (per-action narrowing kicks in)', async () => {
    const auditDir = makeTestAuditDir();
    const provider = makeOneToolCallProvider({
      name: 'app',
      args: { action: 'github.list_prs', owner: 'X', repo: 'Y', state: 'open' },
    });
    const agent = new Agent({
      auditDir, provider,
      model: 'claude-sonnet-4-6', providerName: 'anthropic',
      maxIterations: 2, autoApprove: true,
    });

    await drainRun(agent, 'list prs');

    const rows = readAuditRows(auditDir);
    // No PR-11 unattended-block deny row. The tool either succeeds or
    // returns its own application-level error (no GitHub token in the
    // test vault is fine — what matters is the gate didn't fire).
    const blockRow = rows.find(r =>
      r.tool === 'app' && r.action === 'deny' &&
      typeof r.reason === 'string' &&
      r.reason.startsWith('blocked: required capability labels'),
    );
    assert.strictEqual(blockRow, undefined,
      `read action must NOT be blocked under --auto-approve after per-action fix; saw ${JSON.stringify(blockRow)}`);
  });

  it('app github.create_issue is blocked under --auto-approve (send-on-behalf is NEVER_ALLOWABLE)', async () => {
    const auditDir = makeTestAuditDir();
    const provider = makeOneToolCallProvider({
      name: 'app',
      args: { action: 'github.create_issue', owner: 'X', repo: 'Y', title: 't', body: 'b' },
    });
    const agent = new Agent({
      auditDir, provider,
      model: 'claude-sonnet-4-6', providerName: 'anthropic',
      maxIterations: 2, autoApprove: true,
    });

    await drainRun(agent, 'create issue');

    const rows = readAuditRows(auditDir);
    const denyRow = rows.find(r => r.tool === 'app' && r.action === 'deny');
    assert.ok(denyRow, `expected deny row; got ${JSON.stringify(rows.map(r => `${r.tool}/${r.action}`))}`);
    assert.match(
      denyRow.reason as string,
      /^blocked: required capability labels \[.*send-on-behalf.*\] are not permitted by --allow-capability in unattended mode$/,
    );
  });

  it('app github.create_issue is STILL blocked even with --allow-capability=account-access,net-fetch', async () => {
    const auditDir = makeTestAuditDir();
    const provider = makeOneToolCallProvider({
      name: 'app',
      args: { action: 'github.create_issue', owner: 'X', repo: 'Y', title: 't', body: 'b' },
    });
    const allowed = parseAllowCapabilityFlag('account-access,net-fetch');
    const agent = new Agent({
      auditDir, provider,
      model: 'claude-sonnet-4-6', providerName: 'anthropic',
      maxIterations: 2, autoApprove: true,
      allowedCapabilities: allowed,
    });

    await drainRun(agent, 'create issue');

    const rows = readAuditRows(auditDir);
    const denyRow = rows.find(r => r.tool === 'app' && r.action === 'deny');
    assert.ok(denyRow, 'send-on-behalf must remain immune even with partial allowlist');
    assert.match(denyRow.reason as string, /send-on-behalf/);
  });

  it('hard exclusion: parseAllowCapabilityFlag rejects send-on-behalf', () => {
    assert.throws(
      () => parseAllowCapabilityFlag('account-access,send-on-behalf,net-fetch'),
      /Refusing to allowlist capability "send-on-behalf"/,
    );
  });

  it('hard exclusion: parseAllowCapabilityFlag rejects move-money', () => {
    assert.throws(
      () => parseAllowCapabilityFlag('move-money'),
      /Refusing to allowlist capability "move-money"/,
    );
  });
});

// ── Synthetic tool: this is where the allowlist actually does work ──
//
// A tool whose static `permission` is `auto` but which carries
// `account-access` (a `prompt`-tier label) escalates auto → prompt.
// Pre-PR-11, that escalation was immune to --auto-approve, so the tool
// was unrunnable unattended. With --allow-capability=account-access the
// triggering label is allowlisted, escalation no longer counts as
// "challenged," and --auto-approve bypasses cleanly.
class SyntheticAccountAccessTool implements Tool {
  name = 'syn_account_read';
  description = 'Synthetic tool — auto-permission, account-access label';
  permission: Tool['permission'] = 'auto';
  capabilities: CapabilityLabel[] = ['read-only', 'account-access', 'net-fetch'];
  parameters = { type: 'object', properties: { q: { type: 'string' } } };
  async execute(_args: Record<string, unknown>): Promise<string> {
    return 'syn ok';
  }
}

describe('PR 11 — allowlist is load-bearing for auto-permission tools with prompt-tier labels', () => {
  it('without allowlist: auto+account-access escalates and blocks under --auto-approve', async () => {
    const auditDir = makeTestAuditDir();
    const provider = makeOneToolCallProvider({ name: 'syn_account_read', args: { q: 'hi' } });
    const agent = new Agent({
      auditDir, provider,
      model: 'claude-sonnet-4-6', providerName: 'anthropic',
      maxIterations: 2, autoApprove: true,
    });
    // Inject the synthetic tool into the agent's registry post-construction.
    (agent as unknown as { tools: { register: (t: Tool) => void } }).tools.register(new SyntheticAccountAccessTool());

    await drainRun(agent, 'go');

    const rows = readAuditRows(auditDir);
    const denyRow = rows.find(r => r.tool === 'syn_account_read' && r.action === 'deny');
    assert.ok(denyRow, `expected deny row for synthetic tool; saw ${JSON.stringify(rows.map(r=>`${r.tool}/${r.action}`))}`);
    assert.match(denyRow.reason as string, /^blocked: required capability labels \[.*\] are not permitted by --allow-capability in unattended mode$/);
  });

  it('with allowlist=account-access,net-fetch: escalation is satisfied, tool runs', async () => {
    const auditDir = makeTestAuditDir();
    const provider = makeOneToolCallProvider({ name: 'syn_account_read', args: { q: 'hi' } });
    const agent = new Agent({
      auditDir, provider,
      model: 'claude-sonnet-4-6', providerName: 'anthropic',
      maxIterations: 2, autoApprove: true,
      allowedCapabilities: parseAllowCapabilityFlag('account-access,net-fetch'),
    });
    (agent as unknown as { tools: { register: (t: Tool) => void } }).tools.register(new SyntheticAccountAccessTool());

    await drainRun(agent, 'go');

    const rows = readAuditRows(auditDir);
    const allowRow = rows.find(r => r.tool === 'capability' && r.action === 'capability_allow');
    assert.ok(allowRow, 'expected capability_allow session-start row');
    // sanitizeArgs in audit.ts JSON-stringifies object values, so labels
    // round-trips as a string. Parse before asserting structure — the
    // serialization is part of the audit-row contract for any nested
    // value, not a test artifact.
    const labelsRaw = (allowRow.args as Record<string, unknown>).labels as string;
    const labels = JSON.parse(labelsRaw) as string[];
    assert.deepStrictEqual(labels.slice().sort(), ['account-access', 'net-fetch']);
    const blockRow = rows.find(r =>
      r.tool === 'syn_account_read' && r.action === 'deny' &&
      typeof r.reason === 'string' &&
      r.reason.startsWith('blocked: required capability labels'),
    );
    assert.strictEqual(blockRow, undefined, 'allowlist should clear the unattended block');
  });
});
