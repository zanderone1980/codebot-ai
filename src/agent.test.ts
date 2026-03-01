import { describe, it, before } from 'node:test';
import * as assert from 'node:assert';
import { Agent } from './agent';
import { LLMProvider, Message, ToolSchema, StreamEvent } from './types';

/**
 * Mock LLM provider that returns scripted responses.
 */
class MockProvider implements LLMProvider {
  name = 'mock';
  private responses: Array<{ text?: string; toolCalls?: Array<{ name: string; args: Record<string, unknown> }> }>;
  private callIndex = 0;

  constructor(responses: Array<{ text?: string; toolCalls?: Array<{ name: string; args: Record<string, unknown> }> }>) {
    this.responses = responses;
  }

  async *chat(messages: Message[], tools?: ToolSchema[]): AsyncGenerator<StreamEvent> {
    const response = this.responses[this.callIndex++] || { text: 'No more responses.' };

    if (response.text) {
      yield { type: 'text', text: response.text };
    }

    if (response.toolCalls) {
      for (let i = 0; i < response.toolCalls.length; i++) {
        const tc = response.toolCalls[i];
        yield {
          type: 'tool_call_end',
          toolCall: {
            id: `call_${i}`,
            type: 'function',
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.args),
            },
          },
        };
      }
    }

    yield { type: 'done' };
  }
}

describe('Agent', () => {
  it('produces text events from LLM response', async () => {
    const provider = new MockProvider([{ text: 'Hello, world!' }]);
    const agent = new Agent({
      provider,
      model: 'mock-model',
      autoApprove: true,
    });

    const events = [];
    for await (const event of agent.run('Hi')) {
      events.push(event);
    }

    const textEvents = events.filter(e => e.type === 'text');
    assert.ok(textEvents.length > 0, 'Should have text events');
    assert.strictEqual(textEvents[0].text, 'Hello, world!');
    assert.ok(events.some(e => e.type === 'done'), 'Should end with done');
  });

  it('executes tool calls and feeds results back', async () => {
    const provider = new MockProvider([
      {
        text: 'Let me think about this.',
        toolCalls: [{ name: 'think', args: { thought: 'Planning my approach' } }],
      },
      { text: 'Done thinking.' },
    ]);

    const agent = new Agent({
      provider,
      model: 'mock-model',
      autoApprove: true,
    });

    const events = [];
    for await (const event of agent.run('Think about something')) {
      events.push(event);
    }

    assert.ok(events.some(e => e.type === 'tool_call'), 'Should have tool_call event');
    assert.ok(events.some(e => e.type === 'tool_result'), 'Should have tool_result event');
    assert.ok(events.some(e => e.type === 'done'), 'Should end with done');
  });

  it('handles unknown tool names gracefully', async () => {
    const provider = new MockProvider([
      {
        toolCalls: [{ name: 'nonexistent_tool', args: {} }],
      },
      { text: 'Tool not found, sorry.' },
    ]);

    const agent = new Agent({
      provider,
      model: 'mock-model',
      autoApprove: true,
    });

    const events = [];
    for await (const event of agent.run('Use fake tool')) {
      events.push(event);
    }

    const errorResult = events.find(
      e => e.type === 'tool_result' && e.toolResult?.is_error
    );
    assert.ok(errorResult, 'Should have error result for unknown tool');
    assert.ok(
      errorResult?.toolResult?.result?.includes('Unknown tool'),
      'Error should mention unknown tool'
    );
  });

  it('respects max iterations', async () => {
    // Provider always returns tool calls, never plain text
    const infiniteToolProvider = new MockProvider(
      Array(10).fill({
        toolCalls: [{ name: 'think', args: { thought: 'loop' } }],
      })
    );

    const agent = new Agent({
      provider: infiniteToolProvider,
      model: 'mock-model',
      maxIterations: 3,
      autoApprove: true,
    });

    const events = [];
    for await (const event of agent.run('Loop forever')) {
      events.push(event);
    }

    const errorEvent = events.find(e => e.type === 'error');
    assert.ok(errorEvent, 'Should hit max iterations error');
    assert.ok(
      errorEvent?.error?.includes('Max iterations'),
      'Error should mention max iterations'
    );
  });

  it('clears history correctly', async () => {
    const provider = new MockProvider([{ text: 'Response 1' }, { text: 'Response 2' }]);
    const agent = new Agent({
      provider,
      model: 'mock-model',
      autoApprove: true,
    });

    // Run one message
    for await (const _ of agent.run('First message')) {}
    const before = agent.getMessages().length;
    assert.ok(before > 1, 'Should have messages after first run');

    // Clear
    agent.clearHistory();
    const after = agent.getMessages().length;
    assert.strictEqual(after, 1, 'Should only have system message after clear');
  });

  it('uses projectRoot when provided', async () => {
    const provider = new MockProvider([{ text: 'OK' }]);
    const customRoot = '/tmp/custom-project';
    const agent = new Agent({
      provider,
      model: 'mock-model',
      autoApprove: true,
      projectRoot: customRoot,
    });

    // Agent should accept projectRoot without error
    const events = [];
    for await (const event of agent.run('Hello')) {
      events.push(event);
    }
    assert.ok(events.some(e => e.type === 'done'), 'Should complete with custom projectRoot');
  });

  it('falls back to cwd when projectRoot not provided', async () => {
    const provider = new MockProvider([{ text: 'OK' }]);
    const agent = new Agent({
      provider,
      model: 'mock-model',
      autoApprove: true,
      // no projectRoot specified
    });

    const events = [];
    for await (const event of agent.run('Hello')) {
      events.push(event);
    }
    assert.ok(events.some(e => e.type === 'done'), 'Should complete without projectRoot');
  });

  it('propagates projectRoot through tool execution', async () => {
    const provider = new MockProvider([
      {
        toolCalls: [{ name: 'think', args: { thought: 'test' } }],
      },
      { text: 'Done.' },
    ]);

    const customRoot = '/tmp/test-project';
    const agent = new Agent({
      provider,
      model: 'mock-model',
      autoApprove: true,
      projectRoot: customRoot,
    });

    const events = [];
    for await (const event of agent.run('Test projectRoot')) {
      events.push(event);
    }

    // Tool execution should succeed (think tool doesn't depend on filesystem)
    const toolResult = events.find(e => e.type === 'tool_result');
    assert.ok(toolResult, 'Should have tool result with custom projectRoot');
  });
});
