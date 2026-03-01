import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { getModelInfo, MODEL_REGISTRY } from './registry';

describe('Prompt Caching — registry supportsCaching (v2.1.6)', () => {
  it('all Anthropic models support caching', () => {
    const anthropicModels = Object.entries(MODEL_REGISTRY)
      .filter(([, info]) => info.provider === 'anthropic');
    assert.ok(anthropicModels.length > 0, 'should have Anthropic models');
    for (const [name, info] of anthropicModels) {
      assert.strictEqual(info.supportsCaching, true, `${name} should support caching`);
    }
  });

  it('all Gemini models support caching', () => {
    const geminiModels = Object.entries(MODEL_REGISTRY)
      .filter(([, info]) => info.provider === 'gemini');
    assert.ok(geminiModels.length > 0, 'should have Gemini models');
    for (const [name, info] of geminiModels) {
      assert.strictEqual(info.supportsCaching, true, `${name} should support caching`);
    }
  });

  it('OpenAI gpt-4o and gpt-4.1 models support caching', () => {
    assert.strictEqual(getModelInfo('gpt-4o').supportsCaching, true);
    assert.strictEqual(getModelInfo('gpt-4.1').supportsCaching, true);
    assert.strictEqual(getModelInfo('gpt-4.1-mini').supportsCaching, true);
    assert.strictEqual(getModelInfo('o3').supportsCaching, true);
    assert.strictEqual(getModelInfo('o4-mini').supportsCaching, true);
  });

  it('gpt-4-turbo does not have caching flag (not supported)', () => {
    assert.strictEqual(getModelInfo('gpt-4-turbo').supportsCaching, undefined);
  });

  it('local models do not have caching flag', () => {
    assert.strictEqual(getModelInfo('qwen2.5-coder:32b').supportsCaching, undefined);
    assert.strictEqual(getModelInfo('llama3.1:8b').supportsCaching, undefined);
  });

  it('unknown models default to no caching', () => {
    const info = getModelInfo('my-custom-local-model');
    assert.strictEqual(info.supportsCaching, undefined);
  });
});

describe('Prompt Caching — Anthropic provider cache_control injection', () => {
  it('constructs system prompt as content block array with cache_control', () => {
    // Simulate what the Anthropic provider does when cachingEnabled = true
    const systemPrompt = 'You are a helpful assistant.';
    const cachingEnabled = true;

    let body: Record<string, unknown> = {};
    if (systemPrompt) {
      if (cachingEnabled) {
        body.system = [{
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        }];
      } else {
        body.system = systemPrompt;
      }
    }

    assert.ok(Array.isArray(body.system), 'system should be an array');
    const blocks = body.system as Array<Record<string, unknown>>;
    assert.strictEqual(blocks.length, 1);
    assert.strictEqual(blocks[0].type, 'text');
    assert.strictEqual(blocks[0].text, systemPrompt);
    assert.deepStrictEqual(blocks[0].cache_control, { type: 'ephemeral' });
  });

  it('keeps system prompt as string when caching is disabled', () => {
    const systemPrompt = 'You are a helpful assistant.';
    const cachingEnabled = false;

    let body: Record<string, unknown> = {};
    if (systemPrompt) {
      if (cachingEnabled) {
        body.system = [{ type: 'text', text: systemPrompt, cache_control: { type: 'ephemeral' } }];
      } else {
        body.system = systemPrompt;
      }
    }

    assert.strictEqual(body.system, systemPrompt);
    assert.strictEqual(typeof body.system, 'string');
  });

  it('adds cache_control to last tool definition', () => {
    const tools = [
      { function: { name: 'read_file', description: 'Read a file', parameters: {} } },
      { function: { name: 'write_file', description: 'Write a file', parameters: {} } },
      { function: { name: 'execute', description: 'Run command', parameters: {} } },
    ];

    const toolDefs = tools.map(t => ({
      name: t.function.name,
      description: t.function.description,
      input_schema: t.function.parameters,
    }));

    // Simulate: mark last tool for caching
    (toolDefs[toolDefs.length - 1] as Record<string, unknown>).cache_control = { type: 'ephemeral' };

    // First two tools should NOT have cache_control
    assert.strictEqual((toolDefs[0] as Record<string, unknown>).cache_control, undefined);
    assert.strictEqual((toolDefs[1] as Record<string, unknown>).cache_control, undefined);
    // Last tool should have it
    assert.deepStrictEqual((toolDefs[2] as Record<string, unknown>).cache_control, { type: 'ephemeral' });
  });
});

describe('Prompt Caching — UsageStats cache fields', () => {
  it('parses Anthropic cache usage from message_start', () => {
    // Simulate what happens when Anthropic returns cache metrics
    const usage = {
      input_tokens: 1500,
      output_tokens: 200,
      cache_creation_input_tokens: 1200,
      cache_read_input_tokens: 0,
    };

    const parsed = {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheCreationTokens: usage.cache_creation_input_tokens || 0,
      cacheReadTokens: usage.cache_read_input_tokens || 0,
    };

    assert.strictEqual(parsed.inputTokens, 1500);
    assert.strictEqual(parsed.outputTokens, 200);
    assert.strictEqual(parsed.cacheCreationTokens, 1200);
    assert.strictEqual(parsed.cacheReadTokens, 0);
  });

  it('parses Anthropic cache read on subsequent requests', () => {
    const usage = {
      input_tokens: 300,
      output_tokens: 150,
      cache_creation_input_tokens: 0,
      cache_read_input_tokens: 1200,
    };

    const parsed = {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheCreationTokens: usage.cache_creation_input_tokens || 0,
      cacheReadTokens: usage.cache_read_input_tokens || 0,
    };

    assert.strictEqual(parsed.cacheCreationTokens, 0);
    assert.strictEqual(parsed.cacheReadTokens, 1200);
  });

  it('parses OpenAI cached_tokens from usage', () => {
    // Simulate OpenAI's usage response with prompt_tokens_details
    const openaiUsage = {
      prompt_tokens: 500,
      completion_tokens: 100,
      total_tokens: 600,
      prompt_tokens_details: {
        cached_tokens: 400,
      },
    };

    const cachedTokens = openaiUsage.prompt_tokens_details?.cached_tokens || 0;
    const parsed = {
      inputTokens: openaiUsage.prompt_tokens || 0,
      outputTokens: openaiUsage.completion_tokens || 0,
      totalTokens: openaiUsage.total_tokens || 0,
      cacheReadTokens: cachedTokens,
    };

    assert.strictEqual(parsed.inputTokens, 500);
    assert.strictEqual(parsed.outputTokens, 100);
    assert.strictEqual(parsed.cacheReadTokens, 400);
  });

  it('handles missing cache fields gracefully (zero defaults)', () => {
    const usage = {
      input_tokens: 1000,
      output_tokens: 500,
    } as Record<string, number>;

    const parsed = {
      inputTokens: usage.input_tokens,
      outputTokens: usage.output_tokens,
      cacheCreationTokens: usage.cache_creation_input_tokens || 0,
      cacheReadTokens: usage.cache_read_input_tokens || 0,
    };

    assert.strictEqual(parsed.cacheCreationTokens, 0);
    assert.strictEqual(parsed.cacheReadTokens, 0);
  });
});

describe('Prompt Caching — metrics tracking', () => {
  it('increments cache_creation_tokens_total on cache creation', () => {
    // Simulate agent metrics tracking
    const counters: Map<string, number> = new Map();

    const increment = (name: string, labels: Record<string, string> = {}, delta = 1) => {
      const key = name + JSON.stringify(labels);
      counters.set(key, (counters.get(key) || 0) + delta);
    };

    // First request — cache creation
    const usage1 = { cacheCreationTokens: 1500, cacheReadTokens: 0 };
    if (usage1.cacheCreationTokens) {
      increment('cache_creation_tokens_total', {}, usage1.cacheCreationTokens);
    }
    if (usage1.cacheReadTokens) {
      increment('cache_read_tokens_total', {}, usage1.cacheReadTokens);
      increment('cache_hits_total', { source: 'prompt' });
    }

    assert.strictEqual(counters.get('cache_creation_tokens_total{}'), 1500);
    assert.strictEqual(counters.get('cache_read_tokens_total{}'), undefined);
    assert.strictEqual(counters.get('cache_hits_total{"source":"prompt"}'), undefined);

    // Second request — cache hit
    const usage2 = { cacheCreationTokens: 0, cacheReadTokens: 1500 };
    if (usage2.cacheCreationTokens) {
      increment('cache_creation_tokens_total', {}, usage2.cacheCreationTokens);
    }
    if (usage2.cacheReadTokens) {
      increment('cache_read_tokens_total', {}, usage2.cacheReadTokens);
      increment('cache_hits_total', { source: 'prompt' });
    }

    assert.strictEqual(counters.get('cache_creation_tokens_total{}'), 1500); // unchanged
    assert.strictEqual(counters.get('cache_read_tokens_total{}'), 1500);
    assert.strictEqual(counters.get('cache_hits_total{"source":"prompt"}'), 1);
  });
});
