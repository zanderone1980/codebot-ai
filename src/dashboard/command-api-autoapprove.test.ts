/**
 * PR 16 — tests for the per-request `autoApprove` override on
 * /api/command/chat and the new `Agent.getAutoApprove()` accessor.
 *
 * Bug context: pre-PR-16 the dashboard chat handler ignored
 * body.autoApprove. The agent's autoApprove was set at construction
 * and never changed per-request, so any tool call hitting a `prompt`-
 * tier permission deadlocked the SSE stream waiting for an interactive
 * approval that never came. The CLI worked because users passed
 * --auto-approve at startup; the dashboard had no equivalent.
 *
 * What this test pins:
 *   - getAutoApprove() reflects construction value
 *   - setAutoApprove() flips it
 *   - The handler-level snapshot/restore protocol (mocked through the
 *     agent's getter/setter) doesn't leak between requests.
 *
 * Note: we don't drive the real HTTP handler here because that requires
 * a full DashboardServer + SSE client. The route logic itself is small
 * and audited inline in command-api.ts; what's worth pinning is the
 * Agent surface those calls land on.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { Agent } from '../agent';
import type { LLMProvider, Message, StreamEvent, ToolSchema } from '../types';
import { makeTestAuditDir } from '../test-audit-isolation';

function stubProvider(): LLMProvider {
  return {
    name: 'stub',
    async *chat(_m: Message[], _t?: ToolSchema[]): AsyncGenerator<StreamEvent> {
      yield { type: 'done' };
    },
  };
}

describe('Agent autoApprove getter/setter (PR 16)', () => {
  it('getAutoApprove returns false when constructed without the opt', () => {
    const agent = new Agent({
      auditDir: makeTestAuditDir(),
      provider: stubProvider(),
      model: 'claude-sonnet-4-6',
      providerName: 'anthropic',
      // autoApprove omitted → defaults false
    });
    assert.strictEqual(agent.getAutoApprove(), false);
  });

  it('getAutoApprove returns true when constructed with autoApprove:true', () => {
    const agent = new Agent({
      auditDir: makeTestAuditDir(),
      provider: stubProvider(),
      model: 'claude-sonnet-4-6',
      providerName: 'anthropic',
      autoApprove: true,
    });
    assert.strictEqual(agent.getAutoApprove(), true);
  });

  it('setAutoApprove flips the value, getAutoApprove reads the new value', () => {
    const agent = new Agent({
      auditDir: makeTestAuditDir(),
      provider: stubProvider(),
      model: 'claude-sonnet-4-6',
      providerName: 'anthropic',
    });
    assert.strictEqual(agent.getAutoApprove(), false);
    agent.setAutoApprove(true);
    assert.strictEqual(agent.getAutoApprove(), true);
    agent.setAutoApprove(false);
    assert.strictEqual(agent.getAutoApprove(), false);
  });

  it('snapshot/restore protocol used by the chat handler does not leak', () => {
    // Mirrors what command-api.ts:/api/command/chat does:
    //   const prior = agent.getAutoApprove();
    //   if (requested !== prior) agent.setAutoApprove(requested);
    //   // ... handle request ...
    //   if (requested !== prior) agent.setAutoApprove(prior);
    const agent = new Agent({
      auditDir: makeTestAuditDir(),
      provider: stubProvider(),
      model: 'claude-sonnet-4-6',
      providerName: 'anthropic',
      autoApprove: false,
    });

    // Request 1: caller asks for autoApprove, agent flips, then we restore.
    // Run the flip through a helper so TS doesn't statically narrow the
    // comparison between the request-body literal and the agent's
    // initial false state.
    const flipReq1 = (a: Agent, requested: boolean) => {
      const prior = a.getAutoApprove();
      if (requested !== prior) a.setAutoApprove(requested);
      return () => { if (requested !== prior) a.setAutoApprove(prior); };
    };
    {
      assert.strictEqual(agent.getAutoApprove(), false);
      const restore = flipReq1(agent, true);
      assert.strictEqual(agent.getAutoApprove(), true, 'flipped during request');
      restore();
      assert.strictEqual(agent.getAutoApprove(), false, 'restored after request');
    }

    // Request 2: caller doesn't request autoApprove. Snapshot===current,
    // no flip, no restore. Value stays false. Cast through a function
    // call so the comparison isn't statically narrowed by TS inference.
    const flip = (a: Agent, requested: boolean) => {
      const prior = a.getAutoApprove();
      if (requested !== prior) a.setAutoApprove(requested);
      const restore = () => { if (requested !== prior) a.setAutoApprove(prior); };
      return restore;
    };
    {
      const restore = flip(agent, false);
      assert.strictEqual(agent.getAutoApprove(), false);
      restore();
      assert.strictEqual(agent.getAutoApprove(), false);
    }
  });
});
