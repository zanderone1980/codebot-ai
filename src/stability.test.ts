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
});
