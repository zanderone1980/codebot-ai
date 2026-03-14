import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { ContextBus, BusBridgeTool } from './context-bus';
import { ROLE_REGISTRY, getToolsForRole, buildRoleSystemPrompt, AgentRole } from './roles';
import { createStrategy, PipelineStrategy, SwarmAgent, AgentRunResult } from './strategies';

function makeStubAgent(id: string, role: AgentRole, output = 'done'): SwarmAgent {
  return {
    id, role, model: 'test-model', providerName: 'test', status: 'idle' as const, depth: 0,
    async run(_prompt: string): Promise<AgentRunResult> {
      return { output, toolCalls: ['read_file'], filesModified: [], durationMs: 50, tokenUsage: { input: 100, output: 200 }, errors: 0 };
    },
  };
}

// -- ContextBus Tests --

describe('ContextBus — core messaging', () => {
  it('creates with empty state', () => {
    const bus = new ContextBus('test-swarm');
    assert.deepStrictEqual(bus.getAllMessages(), []);
  });

  it('posts and retrieves messages', () => {
    const bus = new ContextBus('test-swarm');
    const msg = bus.post({ fromAgentId: 'a1', fromRole: 'coder', type: 'contribution', target: '*', payload: { summary: 'test', content: 'hello' } });
    assert.ok(msg.id.startsWith('msg_'));
    assert.strictEqual(msg.swarmId, 'test-swarm');
    assert.strictEqual(bus.getMessageCount(), 1);
  });

  it('filters by type and round', () => {
    const bus = new ContextBus('s1');
    bus.post({ fromAgentId: 'a1', fromRole: 'coder', type: 'contribution', target: '*', payload: { summary: 's', content: 'c' }, round: 1 });
    bus.post({ fromAgentId: 'a1', fromRole: 'coder', type: 'vote', target: '*', payload: { summary: 'v', content: 'approve' }, round: 1 });
    bus.post({ fromAgentId: 'a2', fromRole: 'reviewer', type: 'contribution', target: '*', payload: { summary: 's2', content: 'c2' }, round: 2 });
    assert.strictEqual(bus.getByType('contribution', 1).length, 1);
    assert.strictEqual(bus.getByType('vote').length, 1);
    assert.strictEqual(bus.getByType('contribution').length, 2);
  });

  it('filters by role', () => {
    const bus = new ContextBus('s1');
    bus.post({ fromAgentId: 'a1', fromRole: 'coder', type: 'contribution', target: '*', payload: { summary: 's', content: 'c' } });
    bus.post({ fromAgentId: 'a2', fromRole: 'reviewer', type: 'contribution', target: '*', payload: { summary: 's', content: 'c' } });
    assert.strictEqual(bus.getByRole('coder').length, 1);
    assert.strictEqual(bus.getByRole('reviewer').length, 1);
  });

  it('assigns unique IDs to messages', () => {
    const bus = new ContextBus('test-swarm');
    const m1 = bus.post({ fromAgentId: 'a', fromRole: 'coder', type: 'contribution', target: '*', payload: { summary: 's', content: 'a' } });
    const m2 = bus.post({ fromAgentId: 'b', fromRole: 'coder', type: 'contribution', target: '*', payload: { summary: 's', content: 'b' } });
    assert.notStrictEqual(m1.id, m2.id);
  });

  it('evicts oldest messages when exceeding maxMessages', () => {
    const bus = new ContextBus('s1', 3);
    for (let i = 0; i < 5; i++) {
      bus.post({ fromAgentId: 'a1', fromRole: 'coder', type: 'contribution', target: '*', payload: { summary: `msg${i}`, content: `c${i}` } });
    }
    assert.strictEqual(bus.getMessageCount(), 3);
    const all = bus.getAllMessages();
    assert.ok(all[0].payload.summary === 'msg2');
  });

  it('clear removes all messages', () => {
    const bus = new ContextBus('s1');
    bus.post({ fromAgentId: 'a1', fromRole: 'coder', type: 'contribution', target: '*', payload: { summary: 's', content: 'c' } });
    bus.clear();
    assert.strictEqual(bus.getMessageCount(), 0);
  });

  it('subscribe receives targeted messages and skips own', () => {
    const bus = new ContextBus('s1');
    const received: unknown[] = [];
    bus.subscribe('a1', 'coder', (msg) => received.push(msg));

    // Own message — should be skipped
    bus.post({ fromAgentId: 'a1', fromRole: 'coder', type: 'contribution', target: '*', payload: { summary: 's', content: 'own' } });
    // Broadcast from other agent
    bus.post({ fromAgentId: 'a2', fromRole: 'reviewer', type: 'feedback', target: '*', payload: { summary: 's', content: 'feedback' } });
    // Targeted at agent
    bus.post({ fromAgentId: 'a3', fromRole: 'tester', type: 'request', target: 'a1', payload: { summary: 's', content: 'for-a1' } });
    // Targeted at role
    bus.post({ fromAgentId: 'a4', fromRole: 'planner', type: 'plan', target: 'coder', payload: { summary: 's', content: 'for-coder' } });
    // Targeted at different agent — should be skipped
    bus.post({ fromAgentId: 'a5', fromRole: 'reviewer', type: 'feedback', target: 'a2', payload: { summary: 's', content: 'for-a2' } });

    assert.strictEqual(received.length, 3);
  });

  it('getContextForAgent returns formatted markdown', () => {
    const bus = new ContextBus('s1');
    bus.post({ fromAgentId: 'a1', fromRole: 'coder', type: 'contribution', target: '*', payload: { summary: 'My work', content: 'I wrote code', files: ['src/a.ts'] } });
    const ctx = bus.getContextForAgent('a2', 'reviewer');
    assert.ok(ctx.includes('Swarm Context Bus'));
    assert.ok(ctx.includes('My work'));
    assert.ok(ctx.includes('src/a.ts'));
  });

  it('getContextForAgent returns empty for no visible messages', () => {
    const bus = new ContextBus('s1');
    bus.post({ fromAgentId: 'a1', fromRole: 'coder', type: 'contribution', target: 'a3', payload: { summary: 's', content: 'c' } });
    const ctx = bus.getContextForAgent('a2', 'reviewer');
    assert.strictEqual(ctx, '');
  });
});

// -- BusBridgeTool Tests --

describe('BusBridgeTool — swarm_bus tool', () => {
  it('post action adds a message to the bus', async () => {
    const bus = new ContextBus('s1');
    const tool = new BusBridgeTool(bus, 'a1', 'coder');
    const result = await tool.execute({ action: 'post', summary: 'Update', content: 'Did some work', target: '*' });
    assert.ok(result.includes('Message posted'));
    assert.strictEqual(bus.getMessageCount(), 1);
  });

  it('read action returns context', async () => {
    const bus = new ContextBus('s1');
    bus.post({ fromAgentId: 'a2', fromRole: 'reviewer', type: 'feedback', target: '*', payload: { summary: 'Review', content: 'Looks good' } });
    const tool = new BusBridgeTool(bus, 'a1', 'coder');
    const result = await tool.execute({ action: 'read' });
    assert.ok(result.includes('Looks good'));
  });

  it('read action returns no messages text when empty', async () => {
    const bus = new ContextBus('s1');
    const tool = new BusBridgeTool(bus, 'a1', 'coder');
    const result = await tool.execute({ action: 'read' });
    assert.ok(result.includes('No messages'));
  });

  it('vote action posts a vote message', async () => {
    const bus = new ContextBus('s1');
    const tool = new BusBridgeTool(bus, 'a1', 'coder');
    const result = await tool.execute({ action: 'vote', summary: 'My vote', vote: 'approve', reason: 'Good approach' });
    assert.ok(result.includes('Vote'));
    assert.strictEqual(bus.getByType('vote').length, 1);
  });

  it('unknown action returns error message', async () => {
    const bus = new ContextBus('s1');
    const tool = new BusBridgeTool(bus, 'a1', 'coder');
    const result = await tool.execute({ action: 'invalid' });
    assert.ok(result.includes('Unknown action'));
  });

  it('has correct tool metadata', () => {
    const bus = new ContextBus('s1');
    const tool = new BusBridgeTool(bus, 'a1', 'coder');
    assert.strictEqual(tool.name, 'swarm_bus');
    assert.strictEqual(tool.permission, 'auto');
    assert.ok(tool.description.length > 0);
  });
});

// -- Roles Tests --

describe('Swarm Roles — role registry', () => {
  it('ROLE_REGISTRY contains expected roles', () => {
    const roles: AgentRole[] = ['architect', 'coder', 'reviewer', 'tester', 'security_auditor', 'researcher', 'debugger', 'synthesizer', 'planner'];
    for (const role of roles) {
      assert.ok(ROLE_REGISTRY[role], `Missing role: ${role}`);
      assert.ok(ROLE_REGISTRY[role].displayName);
      assert.ok(ROLE_REGISTRY[role].description);
      assert.ok(ROLE_REGISTRY[role].systemPromptSuffix);
    }
  });

  it('getToolsForRole filters correctly for architect (allowedTools set)', () => {
    const allTools = [
      { name: 'read', description: '', parameters: {}, permission: 'auto' as const, execute: async () => '' },
      { name: 'write', description: '', parameters: {}, permission: 'auto' as const, execute: async () => '' },
      { name: 'think', description: '', parameters: {}, permission: 'auto' as const, execute: async () => '' },
    ];
    const tools = getToolsForRole('architect', allTools);
    const names = tools.map(t => t.name);
    assert.ok(names.includes('read'));
    assert.ok(names.includes('think'));
    assert.ok(!names.includes('write'));
  });

  it('getToolsForRole for coder allows all except denied', () => {
    const allTools = [
      { name: 'read', description: '', parameters: {}, permission: 'auto' as const, execute: async () => '' },
      { name: 'browser', description: '', parameters: {}, permission: 'auto' as const, execute: async () => '' },
      { name: 'edit', description: '', parameters: {}, permission: 'auto' as const, execute: async () => '' },
    ];
    const tools = getToolsForRole('coder', allTools);
    const names = tools.map(t => t.name);
    assert.ok(names.includes('read'));
    assert.ok(names.includes('edit'));
    assert.ok(!names.includes('browser'));
  });

  it('getToolsForRole returns filtered tools for empty array', () => {
    const tools = getToolsForRole('coder', []);
    assert.ok(Array.isArray(tools));
    assert.strictEqual(tools.length, 0);
  });

  it('buildRoleSystemPrompt appends role suffix', () => {
    const prompt = buildRoleSystemPrompt('Base prompt', 'architect');
    assert.ok(prompt.startsWith('Base prompt'));
    assert.ok(prompt.includes('AGENT ROLE: Architect'));
  });

  it('buildRoleSystemPrompt returns base for unknown role', () => {
    const prompt = buildRoleSystemPrompt('Base', 'unknown' as AgentRole);
    assert.strictEqual(prompt, 'Base');
  });

  it('each role has a preferredTier', () => {
    for (const [key, config] of Object.entries(ROLE_REGISTRY)) {
      assert.ok(['fast', 'standard', 'powerful'].includes(config.preferredTier), `${key} has invalid tier: ${config.preferredTier}`);
    }
  });
});

// -- Strategy Factory Tests --

describe('Swarm Strategies — createStrategy factory', () => {
  it('creates debate strategy', () => {
    const s = createStrategy('debate');
    assert.strictEqual(s.name, 'debate');
  });

  it('creates moa strategy', () => {
    const s = createStrategy('moa');
    assert.strictEqual(s.name, 'moa');
  });

  it('creates pipeline strategy', () => {
    const s = createStrategy('pipeline');
    assert.strictEqual(s.name, 'pipeline');
  });

  it('creates fan-out strategy', () => {
    const s = createStrategy('fan-out');
    assert.strictEqual(s.name, 'fan-out');
  });

  it('creates generator-critic strategy', () => {
    const s = createStrategy('generator-critic');
    assert.strictEqual(s.name, 'generator-critic');
  });

  it('throws for unknown strategy', () => {
    assert.throws(() => createStrategy('nonexistent'), /Unknown strategy/);
  });

  it('debate strategy accepts config', () => {
    const s = createStrategy('debate', { maxRounds: 5, consensusThreshold: 0.9 });
    assert.strictEqual(s.name, 'debate');
  });

  it('fan-out strategy accepts config', () => {
    const s = createStrategy('fan-out', { maxParallel: 4 });
    assert.strictEqual(s.name, 'fan-out');
  });
});

// -- Pipeline Strategy Execution --

describe('PipelineStrategy — sequential execution', () => {
  it('executes agents in role order', async () => {
    const strategy = new PipelineStrategy();
    const agents = [
      makeStubAgent('a-coder', 'coder', 'code result'),
      makeStubAgent('a-planner', 'planner', 'plan result'),
    ];
    const bus = new ContextBus('s1');

    const events: unknown[] = [];
    for await (const event of strategy.execute(agents, 'build feature', bus, 's1')) {
      events.push(event);
    }

    // Planner should run first (lower pipeline order), then coder
    const completeEvents = (events as Array<{type: string; role: string}>).filter(e => e.type === 'agent_complete');
    assert.strictEqual(completeEvents.length, 2);
    assert.strictEqual(completeEvents[0].role, 'planner');
    assert.strictEqual(completeEvents[1].role, 'coder');
  });

  it('posts contributions to bus during execution', async () => {
    const strategy = new PipelineStrategy();
    const agents = [makeStubAgent('a1', 'coder', 'my output')];
    const bus = new ContextBus('s1');

    for await (const _event of strategy.execute(agents, 'task', bus, 's1')) {
      // consume events
    }

    assert.ok(bus.getMessageCount() > 0);
    const contributions = bus.getByType('contribution');
    assert.ok(contributions.length > 0);
  });
});
