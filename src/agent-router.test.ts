import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { Agent } from './agent';
import type { LLMProvider, AgentEvent, ToolSchema, Message, StreamEvent } from './types';
import type { RouterConfig } from './router';
import { makeTestAuditDir } from './test-audit-isolation';

/**
 * PR 5 — agent-router integration tests.
 *
 * Pins the contract that:
 *   - When `routerConfig` is absent or `enabled: false`, the agent's
 *     model is NEVER mutated across turns. Byte-identical to pre-PR-5.
 *   - When `routerConfig.enabled === true` and the user message
 *     classifies to a tier whose configured model differs from the
 *     current one, the agent swaps `this.model` and writes a
 *     `router:switch` audit entry.
 *   - When the desired tier model lives on a different provider
 *     family, the agent falls open to the current model and writes
 *     a `router:fallback` audit entry. PR 5 is same-provider only.
 *
 * Provider used here is a tiny stub that records the model the agent
 * thinks it's using on each `chat()` call (via the agent's
 * `getActiveModel()` accessor we expose for this test). We never make
 * real network calls.
 */

interface RecordingProvider extends LLMProvider {
  /** Models the agent claimed to be using each turn — read by tests. */
  modelsSeen: string[];
}

function makeRecordingProvider(name: string): RecordingProvider {
  const modelsSeen: string[] = [];
  return {
    name,
    modelsSeen,
    // Each chat() call yields a single 'done' event so the agent loop
    // exits cleanly after one iteration without trying to invoke tools.
    async *chat(_messages: Message[], _tools?: ToolSchema[]): AsyncGenerator<StreamEvent> {
      yield { type: 'done' };
    },
  } as RecordingProvider;
}

/**
 * Drive a single user turn through the agent and return the model the
 * agent thinks it's on at the moment of the chat call (captured by
 * patching the provider's chat fn to read the agent's current model).
 */
async function runOneTurn(
  agent: Agent,
  userMsg: string,
): Promise<void> {
  // Drain the run() generator to completion. The provider above yields
  // 'done' immediately so this returns after one loop iteration.
  for await (const _ev of agent.run(userMsg)) {
    void _ev;
  }
}

/**
 * Patched provider that captures `getActiveModel()` from the agent
 * inside chat(). We expose it via a closure so the test can read it
 * after run() returns.
 */
function makeModelCapturingProvider(getModel: () => string): { provider: LLMProvider; modelsSeen: string[] } {
  const modelsSeen: string[] = [];
  const provider: LLMProvider = {
    name: 'stub',
    async *chat(_messages: Message[]): AsyncGenerator<StreamEvent> {
      modelsSeen.push(getModel());
      yield { type: 'done' };
    },
  };
  return { provider, modelsSeen };
}

describe('Agent — router OFF: behavior unchanged', () => {
  it('routerConfig undefined → model is never mutated', async () => {
    let agentRef: Agent | null = null;
    const { provider, modelsSeen } = makeModelCapturingProvider(() =>
      (agentRef as unknown as { model: string }).model,
    );
    const agent = new Agent({
      auditDir: makeTestAuditDir(),
      provider,
      model: 'claude-sonnet-4-6',
      providerName: 'anthropic',
      maxIterations: 1,
      autoApprove: true,
      // routerConfig deliberately omitted
    });
    agentRef = agent;

    await runOneTurn(agent, 'refactor the entire codebase');
    await runOneTurn(agent, 'just read this file');

    assert.deepStrictEqual(modelsSeen, ['claude-sonnet-4-6', 'claude-sonnet-4-6'],
      `model must NOT change when routerConfig is absent; saw ${JSON.stringify(modelsSeen)}`);
  });

  it('routerConfig.enabled === false → model is never mutated', async () => {
    let agentRef: Agent | null = null;
    const { provider, modelsSeen } = makeModelCapturingProvider(() =>
      (agentRef as unknown as { model: string }).model,
    );
    const routerConfig: RouterConfig = {
      enabled: false,
      fastModel: 'claude-3-5-haiku-20241022',
      strongModel: 'claude-sonnet-4-6',
      reasoningModel: 'claude-opus-4-7',
    };
    const agent = new Agent({
      auditDir: makeTestAuditDir(),
      provider,
      model: 'claude-sonnet-4-6',
      providerName: 'anthropic',
      maxIterations: 1,
      autoApprove: true,
      routerConfig,
    });
    agentRef = agent;

    await runOneTurn(agent, 'refactor the entire codebase');
    assert.deepStrictEqual(modelsSeen, ['claude-sonnet-4-6'],
      `enabled:false must NOT route; saw ${JSON.stringify(modelsSeen)}`);
  });
});

describe('Agent — router ON, same provider: routes per tier', () => {
  it('"refactor" classifies as reasoning → swaps to reasoningModel', async () => {
    let agentRef: Agent | null = null;
    const { provider, modelsSeen } = makeModelCapturingProvider(() =>
      (agentRef as unknown as { model: string }).model,
    );
    const routerConfig: RouterConfig = {
      enabled: true,
      fastModel: 'claude-3-5-haiku-20241022',
      strongModel: 'claude-sonnet-4-6',
      reasoningModel: 'claude-opus-4-7',
    };
    const agent = new Agent({
      auditDir: makeTestAuditDir(),
      provider,
      model: 'claude-sonnet-4-6',
      providerName: 'anthropic',
      maxIterations: 1,
      autoApprove: true,
      routerConfig,
    });
    agentRef = agent;

    await runOneTurn(agent, 'refactor the entire payment module across all services');

    assert.deepStrictEqual(modelsSeen, ['claude-opus-4-7'],
      `reasoning tier should pick reasoningModel; saw ${JSON.stringify(modelsSeen)}`);
  });

  it('"read this file" classifies as fast → swaps to fastModel', async () => {
    let agentRef: Agent | null = null;
    const { provider, modelsSeen } = makeModelCapturingProvider(() =>
      (agentRef as unknown as { model: string }).model,
    );
    const routerConfig: RouterConfig = {
      enabled: true,
      fastModel: 'claude-3-5-haiku-20241022',
      strongModel: 'claude-sonnet-4-6',
      reasoningModel: 'claude-opus-4-7',
    };
    const agent = new Agent({
      auditDir: makeTestAuditDir(),
      provider,
      model: 'claude-sonnet-4-6',
      providerName: 'anthropic',
      maxIterations: 1,
      autoApprove: true,
      routerConfig,
    });
    agentRef = agent;

    await runOneTurn(agent, 'read this file');

    assert.deepStrictEqual(modelsSeen, ['claude-3-5-haiku-20241022'],
      `fast tier should pick fastModel; saw ${JSON.stringify(modelsSeen)}`);
  });
});

describe('Agent — router ON, cross-provider: falls open to current model', () => {
  it('refuses to switch when desired tier model is on a different provider family', async () => {
    let agentRef: Agent | null = null;
    const { provider, modelsSeen } = makeModelCapturingProvider(() =>
      (agentRef as unknown as { model: string }).model,
    );
    // Anthropic agent, but reasoningModel is OpenAI — must NOT switch.
    const routerConfig: RouterConfig = {
      enabled: true,
      fastModel: 'claude-3-5-haiku-20241022',
      strongModel: 'claude-sonnet-4-6',
      reasoningModel: 'gpt-4o',  // different family!
    };
    const agent = new Agent({
      auditDir: makeTestAuditDir(),
      provider,
      model: 'claude-sonnet-4-6',
      providerName: 'anthropic',
      maxIterations: 1,
      autoApprove: true,
      routerConfig,
    });
    agentRef = agent;

    await runOneTurn(agent, 'refactor the entire payment module across all services');

    assert.deepStrictEqual(modelsSeen, ['claude-sonnet-4-6'],
      `cross-provider routing must fall open to current model; saw ${JSON.stringify(modelsSeen)}`);
  });
});

// ── PR 11: router no-op receipts ───────────────────────────────────
// Pre-PR-11, when classifyComplexity picked a tier whose configured
// model equals the current model, maybeRouteModel returned silently —
// the audit chain showed nothing. The PR-brief run on 2026-04-26
// surfaced this as a real receipt gap. This test pins the new
// `router:no_op` row.
describe('Agent — router ON, no-op audit receipt (PR 11)', () => {
  it('emits router:no_op when desired tier maps to current model', async () => {
    let agentRef: Agent | null = null;
    const { provider } = makeModelCapturingProvider(() =>
      (agentRef as unknown as { model: string }).model,
    );
    const routerConfig: RouterConfig = {
      enabled: true,
      fastModel: 'claude-3-5-haiku-20241022',
      strongModel: 'claude-sonnet-4-6',   // matches current model
      reasoningModel: 'claude-opus-4-7',
    };
    const auditDir = makeTestAuditDir();
    const agent = new Agent({
      auditDir,
      provider,
      model: 'claude-sonnet-4-6',
      providerName: 'anthropic',
      maxIterations: 1,
      autoApprove: true,
      routerConfig,
    });
    agentRef = agent;

    // Classify as strong (so strongModel = current = no swap). "update"
    // matches the strong-tier pattern in classifyComplexity, and the
    // configured strongModel above equals the constructor model, so
    // selectModel('strong') === current → maybeRouteModel returns at
    // the no_op branch.
    await runOneTurn(agent, 'update the readme');

    // Read audit entries for THIS session and assert there's exactly
    // one router-related row, and it's a no_op (not a switch / fallback).
    const fs = await import('node:fs');
    const path = await import('node:path');
    const files = fs.readdirSync(auditDir).filter(f => f.startsWith('audit-'));
    const allLines: string[] = [];
    for (const f of files) {
      allLines.push(...fs.readFileSync(path.join(auditDir, f), 'utf-8').split('\n').filter(Boolean));
    }
    const routerRows = allLines
      .map(l => JSON.parse(l))
      .filter(e => e.tool === 'router');

    assert.strictEqual(routerRows.length, 1,
      `expected exactly 1 router audit row; saw ${routerRows.length}: ${JSON.stringify(routerRows)}`);
    assert.strictEqual(routerRows[0].action, 'no_op',
      `expected action=no_op; saw ${routerRows[0].action}`);
    assert.strictEqual(routerRows[0].args.currentModel, 'claude-sonnet-4-6');
  });
});
