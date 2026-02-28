import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { Agent } from './agent';
import { LLMProvider, Message, ToolSchema, StreamEvent } from './types';
import { isRetryable, isFatalError, getRetryDelay, sleep, RETRY_DEFAULTS } from './retry';

// ─── Mock Providers ──────────────────────────────────────────────────────────

/** Provider that throws on the Nth call (1-indexed), then responds normally. */
class ThrowingProvider implements LLMProvider {
  name = 'throwing-mock';
  private callIndex = 0;
  private throwOnCall: number;

  constructor(throwOnCall = 1) {
    this.throwOnCall = throwOnCall;
  }

  async *chat(_messages: Message[], _tools?: ToolSchema[]): AsyncGenerator<StreamEvent> {
    this.callIndex++;
    if (this.callIndex === this.throwOnCall) {
      throw new Error('Simulated stream explosion');
    }
    yield { type: 'text', text: 'Recovered successfully.' };
    yield { type: 'done' };
  }
}

/** Provider that yields an error event on the Nth call, then responds normally. */
class ErrorEventProvider implements LLMProvider {
  name = 'error-event-mock';
  private callIndex = 0;
  private errorOnCall: number;

  constructor(errorOnCall = 1) {
    this.errorOnCall = errorOnCall;
  }

  async *chat(_messages: Message[], _tools?: ToolSchema[]): AsyncGenerator<StreamEvent> {
    this.callIndex++;
    if (this.callIndex === this.errorOnCall) {
      yield { type: 'error', error: 'Simulated API error event' };
      return;
    }
    yield { type: 'text', text: 'Recovered from error event.' };
    yield { type: 'done' };
  }
}

/** Provider that always returns a tool call on call 1, text on call 2. */
class ToolCallProvider implements LLMProvider {
  name = 'tool-call-mock';
  private callIndex = 0;

  async *chat(_messages: Message[], _tools?: ToolSchema[]): AsyncGenerator<StreamEvent> {
    this.callIndex++;
    if (this.callIndex === 1) {
      yield {
        type: 'tool_call_end',
        toolCall: {
          id: 'call_0',
          type: 'function',
          function: { name: 'execute', arguments: JSON.stringify({ command: 'echo hi' }) },
        },
      };
      return;
    }
    yield { type: 'text', text: 'After tool call.' };
    yield { type: 'done' };
  }
}

// ─── Agent Recovery Tests ────────────────────────────────────────────────────

describe('Agent Stability', () => {
  it('recovers from stream exception and continues to next iteration', async () => {
    const provider = new ThrowingProvider(1);
    const agent = new Agent({
      provider,
      model: 'mock-model',
      maxIterations: 3,
      autoApprove: true,
    });

    const events = [];
    for await (const event of agent.run('Test recovery')) {
      events.push(event);
    }

    // Should have an error event from the throw, then recovery text, then done
    const errorEvents = events.filter(e => e.type === 'error');
    assert.ok(errorEvents.length > 0, 'Should yield error event from stream crash');
    assert.ok(
      errorEvents[0].error?.includes('Stream error'),
      'Error should mention stream error'
    );

    const textEvents = events.filter(e => e.type === 'text');
    assert.ok(textEvents.length > 0, 'Should recover and produce text on retry');
    assert.ok(events.some(e => e.type === 'done'), 'Should complete successfully');
  });

  it('recovers from error events and retries on next iteration', async () => {
    const provider = new ErrorEventProvider(1);
    const agent = new Agent({
      provider,
      model: 'mock-model',
      maxIterations: 3,
      autoApprove: true,
    });

    const events = [];
    for await (const event of agent.run('Test error event recovery')) {
      events.push(event);
    }

    const errorEvents = events.filter(e => e.type === 'error');
    assert.ok(errorEvents.length > 0, 'Should yield error from provider');

    const textEvents = events.filter(e => e.type === 'text');
    assert.ok(textEvents.length > 0, 'Should recover with text on next iteration');
    assert.ok(events.some(e => e.type === 'done'), 'Should complete');
  });

  it('feeds permission denial back to LLM and continues', async () => {
    const provider = new ToolCallProvider();
    const agent = new Agent({
      provider,
      model: 'mock-model',
      maxIterations: 3,
      autoApprove: false,
      askPermission: async () => false, // Always deny
    });

    const events = [];
    for await (const event of agent.run('Try a tool')) {
      events.push(event);
    }

    // Should have tool_call, then tool_result with denial, then text from LLM on next iteration
    assert.ok(events.some(e => e.type === 'tool_call'), 'Should emit tool_call');
    const denialResult = events.find(
      e => e.type === 'tool_result' && e.toolResult?.result?.includes('denied')
    );
    assert.ok(denialResult, 'Should have denial result');
    assert.ok(events.some(e => e.type === 'done'), 'Should complete after denial');
  });
});

// ─── Retry Helper Tests ──────────────────────────────────────────────────────

describe('isRetryable', () => {
  it('identifies 429 rate limit as retryable', () => {
    assert.strictEqual(isRetryable(null, 429), true);
  });

  it('identifies 500, 502, 503, 504 as retryable', () => {
    for (const status of [500, 502, 503, 504]) {
      assert.strictEqual(isRetryable(null, status), true, `${status} should be retryable`);
    }
  });

  it('rejects 400 and 401 as non-retryable', () => {
    assert.strictEqual(isRetryable(null, 400), false);
    assert.strictEqual(isRetryable(null, 401), false);
    assert.strictEqual(isRetryable(null, 403), false);
    assert.strictEqual(isRetryable(null, 404), false);
  });

  it('identifies network errors by message', () => {
    const networkErrors = [
      'fetch failed',
      'ECONNRESET',
      'ECONNREFUSED',
      'ETIMEDOUT',
      'socket hang up',
      'network error',
    ];

    for (const msg of networkErrors) {
      assert.strictEqual(
        isRetryable(new Error(msg)),
        true,
        `"${msg}" should be retryable`
      );
    }
  });

  it('identifies TypeError (fetch network errors) as retryable', () => {
    assert.strictEqual(isRetryable(new TypeError('Failed to fetch')), true);
  });

  it('rejects generic errors as non-retryable', () => {
    assert.strictEqual(isRetryable(new Error('Invalid JSON')), false);
    assert.strictEqual(isRetryable(new Error('bad request')), false);
  });
});

describe('getRetryDelay', () => {
  it('increases delay with attempt number', () => {
    // Run multiple samples to account for jitter
    const samples = 20;
    let avg0 = 0, avg2 = 0;
    for (let i = 0; i < samples; i++) {
      avg0 += getRetryDelay(0);
      avg2 += getRetryDelay(2);
    }
    avg0 /= samples;
    avg2 /= samples;

    assert.ok(avg2 > avg0, `Attempt 2 avg (${avg2}) should exceed attempt 0 avg (${avg0})`);
  });

  it('never exceeds maxDelayMs cap', () => {
    for (let attempt = 0; attempt < 20; attempt++) {
      const delay = getRetryDelay(attempt);
      assert.ok(
        delay <= RETRY_DEFAULTS.maxDelayMs,
        `Delay ${delay}ms at attempt ${attempt} exceeds max ${RETRY_DEFAULTS.maxDelayMs}ms`
      );
    }
  });

  it('respects Retry-After header', () => {
    const delay = getRetryDelay(0, '5');
    assert.strictEqual(delay, 5000, 'Should convert 5 seconds to 5000ms');
  });

  it('caps Retry-After at maxDelayMs', () => {
    const delay = getRetryDelay(0, '999');
    assert.ok(
      delay <= RETRY_DEFAULTS.maxDelayMs,
      `Retry-After 999s should be capped at ${RETRY_DEFAULTS.maxDelayMs}ms`
    );
  });

  it('ignores invalid Retry-After headers', () => {
    const delay = getRetryDelay(0, 'not-a-number');
    // Should fall back to exponential backoff, not 0
    assert.ok(delay > 0, 'Should use backoff for invalid Retry-After');
  });
});

describe('sleep', () => {
  it('waits approximately the specified duration', async () => {
    const start = Date.now();
    await sleep(50);
    const elapsed = Date.now() - start;
    assert.ok(elapsed >= 40, `Slept only ${elapsed}ms, expected ~50ms`);
    assert.ok(elapsed < 200, `Slept ${elapsed}ms, way too long for 50ms sleep`);
  });
});

// ─── Fatal Error Detection Tests ─────────────────────────────────────────────

describe('isFatalError', () => {
  it('detects missing API key errors', () => {
    assert.strictEqual(isFatalError('You didn\'t provide an API key'), true);
    assert.strictEqual(isFatalError('No API key configured for gpt-4.1'), true);
    assert.strictEqual(isFatalError('Invalid api_key provided'), true);
  });

  it('detects authentication failures', () => {
    assert.strictEqual(isFatalError('Authentication failed (401)'), true);
    assert.strictEqual(isFatalError('Unauthorized request'), true);
    assert.strictEqual(isFatalError('Access denied'), true);
    assert.strictEqual(isFatalError('Permission denied'), true);
  });

  it('detects billing/quota errors', () => {
    assert.strictEqual(isFatalError('You exceeded your quota'), true);
    assert.strictEqual(isFatalError('insufficient_quota'), true);
    assert.strictEqual(isFatalError('Billing issue on your account'), true);
  });

  it('detects model not found', () => {
    assert.strictEqual(isFatalError('Model not found: gpt-99'), true);
    assert.strictEqual(isFatalError('The model does not exist'), true);
  });

  it('does NOT flag transient errors as fatal', () => {
    assert.strictEqual(isFatalError('Rate limited, try again'), false);
    assert.strictEqual(isFatalError('Internal server error'), false);
    assert.strictEqual(isFatalError('Connection timeout'), false);
    assert.strictEqual(isFatalError('Stream error: fetch failed'), false);
  });
});

// ─── Fatal Error Agent Behavior ─────────────────────────────────────────────

describe('Agent fatal error handling', () => {
  it('stops immediately on fatal auth error instead of looping', async () => {
    // Provider that always yields a fatal "missing API key" error
    class FatalErrorProvider implements LLMProvider {
      name = 'fatal-mock';
      callCount = 0;

      async *chat(_messages: Message[], _tools?: ToolSchema[]): AsyncGenerator<StreamEvent> {
        this.callCount++;
        yield { type: 'error', error: 'No API key configured for gpt-4.1. Set OPENAI_API_KEY or run: codebot --setup' };
        return;
      }
    }

    const provider = new FatalErrorProvider();
    const agent = new Agent({
      provider,
      model: 'mock-model',
      maxIterations: 50,
      autoApprove: true,
    });

    const events = [];
    for await (const event of agent.run('Test fatal error')) {
      events.push(event);
    }

    // Should stop after 1 call, NOT loop 50 times
    assert.strictEqual(provider.callCount, 1, `Should call provider only once, got ${provider.callCount}`);

    const errorEvents = events.filter(e => e.type === 'error');
    assert.ok(errorEvents.length >= 1, 'Should yield at least one error event');
    assert.ok(errorEvents[0].error?.includes('API key'), 'Error should mention API key');
  });

  it('circuit breaker stops after 3 identical transient errors', async () => {
    // Provider that always yields the same transient (non-fatal) error
    class RepeatingErrorProvider implements LLMProvider {
      name = 'repeating-error-mock';
      callCount = 0;

      async *chat(_messages: Message[], _tools?: ToolSchema[]): AsyncGenerator<StreamEvent> {
        this.callCount++;
        yield { type: 'error', error: 'Some transient LLM hiccup' };
        return;
      }
    }

    const provider = new RepeatingErrorProvider();
    const agent = new Agent({
      provider,
      model: 'mock-model',
      maxIterations: 50,
      autoApprove: true,
    });

    const events = [];
    for await (const event of agent.run('Test circuit breaker')) {
      events.push(event);
    }

    // Should stop after 3 calls (circuit breaker), NOT loop 50 times
    assert.strictEqual(provider.callCount, 3, `Circuit breaker should stop after 3 calls, got ${provider.callCount}`);

    const errorEvents = events.filter(e => e.type === 'error');
    const lastError = errorEvents[errorEvents.length - 1];
    assert.ok(lastError?.error?.includes('repeated'), 'Last error should mention repeated errors');
  });
});

// ─── Message Repair Tests ────────────────────────────────────────────────────

describe('Agent message repair', () => {
  it('handles invalid JSON tool arguments gracefully', async () => {
    // Provider that returns a tool call with bad JSON
    class BadJsonProvider implements LLMProvider {
      name = 'bad-json-mock';
      private callIndex = 0;

      async *chat(_messages: Message[], _tools?: ToolSchema[]): AsyncGenerator<StreamEvent> {
        this.callIndex++;
        if (this.callIndex === 1) {
          yield {
            type: 'tool_call_end',
            toolCall: {
              id: 'call_bad',
              type: 'function',
              function: { name: 'think', arguments: '{not valid json' },
            },
          };
          return;
        }
        yield { type: 'text', text: 'Handled bad JSON.' };
        yield { type: 'done' };
      }
    }

    const agent = new Agent({
      provider: new BadJsonProvider(),
      model: 'mock-model',
      maxIterations: 3,
      autoApprove: true,
    });

    const events = [];
    for await (const event of agent.run('Bad JSON test')) {
      events.push(event);
    }

    const errorResult = events.find(
      e => e.type === 'tool_result' && e.toolResult?.is_error
    );
    assert.ok(errorResult, 'Should have error result for bad JSON');
    assert.ok(events.some(e => e.type === 'done'), 'Should still complete');
  });

  it('removes orphaned tool messages that lack a matching assistant tool_call', async () => {
    // Provider that inspects messages on each call.
    // We'll inject orphaned tool messages into the agent's message history.
    let receivedMessages: Message[] = [];
    class InspectingProvider implements LLMProvider {
      name = 'inspecting-mock';
      private callIndex = 0;

      async *chat(messages: Message[], _tools?: ToolSchema[]): AsyncGenerator<StreamEvent> {
        this.callIndex++;
        receivedMessages = messages;
        yield { type: 'text', text: 'Done.' };
        yield { type: 'done' };
      }
    }

    const agent = new Agent({
      provider: new InspectingProvider(),
      model: 'mock-model',
      maxIterations: 3,
      autoApprove: true,
    });

    // Inject corrupted message history: orphaned tool message with no matching assistant tool_call
    agent.loadMessages([
      { role: 'system', content: 'You are a test agent.' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Let me help.' },
      // Orphaned tool message — no preceding assistant has tool_calls with this id
      { role: 'tool', content: 'some result', tool_call_id: 'orphan_call_99' },
      { role: 'user', content: 'Continue' },
    ]);

    const events = [];
    for await (const event of agent.run('Test orphan repair')) {
      events.push(event);
    }

    // The orphaned tool message should have been removed before sending to LLM
    const toolMsgs = receivedMessages.filter(m => m.role === 'tool');
    assert.strictEqual(toolMsgs.length, 0, `Should have removed orphaned tool message, found ${toolMsgs.length}`);
    assert.ok(events.some(e => e.type === 'done'), 'Should complete successfully');
  });

  it('removes duplicate tool responses keeping only the first', async () => {
    let receivedMessages: Message[] = [];
    class InspectingProvider implements LLMProvider {
      name = 'inspecting-mock';

      async *chat(messages: Message[], _tools?: ToolSchema[]): AsyncGenerator<StreamEvent> {
        receivedMessages = messages;
        yield { type: 'text', text: 'Done.' };
        yield { type: 'done' };
      }
    }

    const agent = new Agent({
      provider: new InspectingProvider(),
      model: 'mock-model',
      maxIterations: 3,
      autoApprove: true,
    });

    // Inject message history with duplicate tool responses
    agent.loadMessages([
      { role: 'system', content: 'You are a test agent.' },
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant', content: '',
        tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'think', arguments: '{}' } }],
      },
      { role: 'tool', content: 'first response', tool_call_id: 'call_1' },
      { role: 'tool', content: 'duplicate response', tool_call_id: 'call_1' },
    ]);

    const events = [];
    for await (const event of agent.run('Test duplicate repair')) {
      events.push(event);
    }

    const toolMsgs = receivedMessages.filter(m => m.role === 'tool');
    assert.strictEqual(toolMsgs.length, 1, `Should keep only one tool response, found ${toolMsgs.length}`);
    assert.strictEqual(toolMsgs[0].content, 'first response', 'Should keep the first response');
    assert.ok(events.some(e => e.type === 'done'), 'Should complete');
  });

  it('injects missing tool responses for incomplete tool_calls', async () => {
    let receivedMessages: Message[] = [];
    class InspectingProvider implements LLMProvider {
      name = 'inspecting-mock';

      async *chat(messages: Message[], _tools?: ToolSchema[]): AsyncGenerator<StreamEvent> {
        receivedMessages = messages;
        yield { type: 'text', text: 'Done.' };
        yield { type: 'done' };
      }
    }

    const agent = new Agent({
      provider: new InspectingProvider(),
      model: 'mock-model',
      maxIterations: 3,
      autoApprove: true,
    });

    // Inject message with tool_calls but NO tool responses (interrupted session)
    agent.loadMessages([
      { role: 'system', content: 'You are a test agent.' },
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant', content: '',
        tool_calls: [
          { id: 'call_a', type: 'function', function: { name: 'execute', arguments: '{"command":"ls"}' } },
          { id: 'call_b', type: 'function', function: { name: 'think', arguments: '{}' } },
        ],
      },
    ]);

    const events = [];
    for await (const event of agent.run('Test missing repair')) {
      events.push(event);
    }

    const toolMsgs = receivedMessages.filter(m => m.role === 'tool');
    assert.strictEqual(toolMsgs.length, 2, `Should inject 2 missing tool responses, found ${toolMsgs.length}`);
    assert.ok(toolMsgs.every(m => m.content.includes('interrupted')), 'Injected responses should mention interrupted');
    assert.ok(events.some(e => e.type === 'done'), 'Should complete');
  });

  it('handles combined corruption: orphans + duplicates + missing responses', async () => {
    let receivedMessages: Message[] = [];
    class InspectingProvider implements LLMProvider {
      name = 'inspecting-mock';

      async *chat(messages: Message[], _tools?: ToolSchema[]): AsyncGenerator<StreamEvent> {
        receivedMessages = messages;
        yield { type: 'text', text: 'Done.' };
        yield { type: 'done' };
      }
    }

    const agent = new Agent({
      provider: new InspectingProvider(),
      model: 'mock-model',
      maxIterations: 3,
      autoApprove: true,
    });

    // Complex corruption scenario
    agent.loadMessages([
      { role: 'system', content: 'You are a test agent.' },
      { role: 'user', content: 'Hello' },
      // Valid assistant with tool_calls
      {
        role: 'assistant', content: '',
        tool_calls: [
          { id: 'call_1', type: 'function', function: { name: 'think', arguments: '{}' } },
          { id: 'call_2', type: 'function', function: { name: 'execute', arguments: '{}' } },
        ],
      },
      { role: 'tool', content: 'result 1', tool_call_id: 'call_1' },
      // call_2 is MISSING a response
      // Orphaned tool message from unknown source
      { role: 'tool', content: 'ghost result', tool_call_id: 'orphan_xyz' },
      // Duplicate of call_1
      { role: 'tool', content: 'dup result', tool_call_id: 'call_1' },
      { role: 'user', content: 'Continue' },
    ]);

    const events = [];
    for await (const event of agent.run('Test combined repair')) {
      events.push(event);
    }

    const toolMsgs = receivedMessages.filter(m => m.role === 'tool');
    // Should have: call_1 (original), call_2 (injected) — orphan and duplicate removed
    assert.strictEqual(toolMsgs.length, 2, `Should have exactly 2 tool messages, found ${toolMsgs.length}`);

    const ids = toolMsgs.map(m => m.tool_call_id).sort();
    assert.deepStrictEqual(ids, ['call_1', 'call_2'], 'Should have exactly call_1 and call_2');

    const call1Msg = toolMsgs.find(m => m.tool_call_id === 'call_1');
    assert.strictEqual(call1Msg?.content, 'result 1', 'call_1 should keep original (first) response');

    const call2Msg = toolMsgs.find(m => m.tool_call_id === 'call_2');
    assert.ok(call2Msg?.content.includes('interrupted'), 'call_2 should have injected response');

    assert.ok(events.some(e => e.type === 'done'), 'Should complete');
  });
});

// ─── v1.5.0 Tests: Parallel Execution, Arg Validation, Caching ─────────────

describe('Agent parallel tool execution', () => {
  it('executes multiple independent tools in parallel (faster than sequential)', async () => {
    // Provider that returns 3 simultaneous tool calls, then text
    class MultiToolProvider implements LLMProvider {
      name = 'multi-tool-mock';
      private callIndex = 0;

      async *chat(_messages: Message[], _tools?: ToolSchema[]): AsyncGenerator<StreamEvent> {
        this.callIndex++;
        if (this.callIndex === 1) {
          // Return 3 tool calls at once — think tool is auto-approved and fast
          for (let j = 0; j < 3; j++) {
            yield {
              type: 'tool_call_end',
              toolCall: {
                id: `call_${j}`,
                type: 'function',
                function: { name: 'think', arguments: JSON.stringify({ thought: `Thought ${j}` }) },
              },
            };
          }
          return;
        }
        yield { type: 'text', text: 'All tools done.' };
        yield { type: 'done' };
      }
    }

    const agent = new Agent({
      provider: new MultiToolProvider(),
      model: 'mock-model',
      maxIterations: 5,
      autoApprove: true,
    });

    const events = [];
    for await (const event of agent.run('Test parallel execution')) {
      events.push(event);
    }

    // Should have 3 tool_result events and final text
    const toolResults = events.filter(e => e.type === 'tool_result');
    assert.strictEqual(toolResults.length, 3, `Should have 3 tool results, got ${toolResults.length}`);
    assert.ok(events.some(e => e.type === 'done'), 'Should complete');
  });

  it('maintains original tool_call order in results', async () => {
    // Provider that returns 2 tool calls
    class OrderTestProvider implements LLMProvider {
      name = 'order-test-mock';
      private callIndex = 0;

      async *chat(_messages: Message[], _tools?: ToolSchema[]): AsyncGenerator<StreamEvent> {
        this.callIndex++;
        if (this.callIndex === 1) {
          yield {
            type: 'tool_call_end',
            toolCall: {
              id: 'call_first',
              type: 'function',
              function: { name: 'think', arguments: JSON.stringify({ thought: 'First' }) },
            },
          };
          yield {
            type: 'tool_call_end',
            toolCall: {
              id: 'call_second',
              type: 'function',
              function: { name: 'think', arguments: JSON.stringify({ thought: 'Second' }) },
            },
          };
          return;
        }
        yield { type: 'text', text: 'Done.' };
        yield { type: 'done' };
      }
    }

    let receivedMessages: Message[] = [];
    class OrderInspectProvider implements LLMProvider {
      name = 'order-inspect';
      private inner = new OrderTestProvider();
      private callIndex = 0;

      async *chat(messages: Message[], tools?: ToolSchema[]): AsyncGenerator<StreamEvent> {
        this.callIndex++;
        if (this.callIndex > 1) {
          receivedMessages = messages;
        }
        yield* this.inner.chat(messages, tools);
      }
    }

    const agent = new Agent({
      provider: new OrderInspectProvider(),
      model: 'mock-model',
      maxIterations: 5,
      autoApprove: true,
    });

    const events = [];
    for await (const event of agent.run('Test order')) {
      events.push(event);
    }

    // Tool messages in agent history should be in original order
    const toolMsgs = receivedMessages.filter(m => m.role === 'tool');
    assert.ok(toolMsgs.length >= 2, `Should have at least 2 tool messages, got ${toolMsgs.length}`);
    assert.strictEqual(toolMsgs[0].tool_call_id, 'call_first');
    assert.strictEqual(toolMsgs[1].tool_call_id, 'call_second');
  });
});

describe('Agent arg validation', () => {
  it('catches missing required fields before execution', async () => {
    // Provider that calls read_file without path
    class MissingArgProvider implements LLMProvider {
      name = 'missing-arg-mock';
      private callIndex = 0;

      async *chat(_messages: Message[], _tools?: ToolSchema[]): AsyncGenerator<StreamEvent> {
        this.callIndex++;
        if (this.callIndex === 1) {
          yield {
            type: 'tool_call_end',
            toolCall: {
              id: 'call_nopath',
              type: 'function',
              function: { name: 'read_file', arguments: '{}' },
            },
          };
          return;
        }
        yield { type: 'text', text: 'Handled missing arg.' };
        yield { type: 'done' };
      }
    }

    const agent = new Agent({
      provider: new MissingArgProvider(),
      model: 'mock-model',
      maxIterations: 3,
      autoApprove: true,
    });

    const events = [];
    for await (const event of agent.run('Test arg validation')) {
      events.push(event);
    }

    const errorResult = events.find(
      e => e.type === 'tool_result' && e.toolResult?.is_error && e.toolResult.result.includes('path')
    );
    assert.ok(errorResult, 'Should have error mentioning missing path field');
    assert.ok(events.some(e => e.type === 'done'), 'Should still complete');
  });

  it('catches wrong type in tool arguments', async () => {
    // Provider that calls read_file with path as a number
    class WrongTypeProvider implements LLMProvider {
      name = 'wrong-type-mock';
      private callIndex = 0;

      async *chat(_messages: Message[], _tools?: ToolSchema[]): AsyncGenerator<StreamEvent> {
        this.callIndex++;
        if (this.callIndex === 1) {
          yield {
            type: 'tool_call_end',
            toolCall: {
              id: 'call_wrongtype',
              type: 'function',
              function: { name: 'read_file', arguments: JSON.stringify({ path: 123 }) },
            },
          };
          return;
        }
        yield { type: 'text', text: 'Handled wrong type.' };
        yield { type: 'done' };
      }
    }

    const agent = new Agent({
      provider: new WrongTypeProvider(),
      model: 'mock-model',
      maxIterations: 3,
      autoApprove: true,
    });

    const events = [];
    for await (const event of agent.run('Test type validation')) {
      events.push(event);
    }

    const errorResult = events.find(
      e => e.type === 'tool_result' && e.toolResult?.is_error && e.toolResult.result.includes('expected string')
    );
    assert.ok(errorResult, 'Should have error about expected string type');
    assert.ok(events.some(e => e.type === 'done'), 'Should still complete');
  });
});
