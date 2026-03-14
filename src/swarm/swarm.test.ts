import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { ContextBus } from './context-bus';
import { SwarmScorer } from './scorer';
import { ROLE_REGISTRY, getToolsForRole, buildRoleSystemPrompt, AgentRole } from './roles';
import { createStrategy } from './strategies';

describe('ContextBus', () => {
  it('creates with empty state', () => {
    const bus = new ContextBus();
    assert.deepStrictEqual(bus.getAllMessages(), []);
  });

  it('posts and retrieves messages', () => {
    const bus = new ContextBus();
    bus.post('agent-1', 'contribution', { content: 'hello' });
    const msgs = bus.getAllMessages();
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].fromAgentId, 'agent-1');
    assert.strictEqual(msgs[0].type, 'contribution');
  });

  it('filters messages by agent', () => {
    const bus = new ContextBus();
    bus.post('agent-1', 'contribution', { content: 'a' });
    bus.post('agent-2', 'contribution', { content: 'b' });
    const msgs = bus.getMessagesFrom('agent-1');
    assert.strictEqual(msgs.length, 1);
    assert.strictEqual(msgs[0].payload.content, 'a');
  });

  it('filters messages by type', () => {
    const bus = new ContextBus();
    bus.post('agent-1', 'contribution', { content: 'work' });
    bus.post('agent-1', 'request', { content: 'help' });
    const msgs = bus.getMessagesByType('request');
    assert.strictEqual(msgs.length, 1);
  });
});

describe('Roles', () => {
  it('ROLE_REGISTRY contains expected roles', () => {
    const roles: AgentRole[] = ['architect', 'coder', 'reviewer', 'tester', 'researcher'];
    for (const role of roles) {
      assert.ok(ROLE_REGISTRY[role], `Missing role: ${role}`);
    }
  });

  it('getToolsForRole returns filtered tools', () => {
    // Pass empty tool array — should return empty
    const tools = getToolsForRole('coder', []);
    assert.ok(Array.isArray(tools));
  });

  it('buildRoleSystemPrompt returns non-empty string', () => {
    const prompt = buildRoleSystemPrompt('Base prompt here', 'researcher');
    assert.ok(typeof prompt === 'string');
    assert.ok(prompt.length > 20);
  });
});

describe('SwarmScorer', () => {
  it('creates instance', () => {
    const scorer = new SwarmScorer();
    assert.ok(scorer);
  });
});

describe('Strategy creation', () => {
  it('creates debate strategy', () => {
    const strategy = createStrategy('debate');
    assert.ok(strategy);
  });

  it('creates pipeline strategy', () => {
    const strategy = createStrategy('pipeline');
    assert.ok(strategy);
  });

  it('creates moa strategy', () => {
    const strategy = createStrategy('moa');
    assert.ok(strategy);
  });

  it('creates fan-out strategy', () => {
    const strategy = createStrategy('fan-out');
    assert.ok(strategy);
  });

  it('creates generator-critic strategy', () => {
    const strategy = createStrategy('generator-critic');
    assert.ok(strategy);
  });

  it('throws on unknown strategy', () => {
    assert.throws(() => createStrategy('nonexistent'), /Unknown strategy/);
  });
});
