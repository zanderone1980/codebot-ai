import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { formatResponsesApiError, modelRequiresResponsesApi } from './openai-responses';

describe('formatResponsesApiError (issue #8 — quota vs rate-limit messaging)', () => {
  it('429 with type=insufficient_quota → quota-exhausted message + billing URL', () => {
    const body = JSON.stringify({
      error: {
        type: 'insufficient_quota',
        message: 'You exceeded your current quota, please check your plan and billing details.',
      },
    });
    const out = formatResponsesApiError(429, body);
    assert.match(out, /Quota exhausted/);
    assert.match(out, /platform\.openai\.com\/settings\/organization\/billing/);
    assert.doesNotMatch(out, /Wait a moment/); // Don't tell them to wait — they need to add money
  });

  it('429 with type=rate_limit_exceeded → rate-limit message ("wait")', () => {
    const body = JSON.stringify({
      error: {
        type: 'rate_limit_exceeded',
        message: 'Too many requests in a short period.',
      },
    });
    const out = formatResponsesApiError(429, body);
    assert.match(out, /Rate limited/);
    assert.match(out, /Wait a moment/);
    assert.doesNotMatch(out, /billing/);
  });

  it('429 with no error type but quota in message → still detected as quota', () => {
    const body = JSON.stringify({ error: { message: 'You exceeded your current quota.' } });
    const out = formatResponsesApiError(429, body);
    assert.match(out, /Quota exhausted/);
  });

  it('401 → authentication failed message', () => {
    const body = JSON.stringify({ error: { message: 'Incorrect API key provided' } });
    const out = formatResponsesApiError(401, body);
    assert.match(out, /Authentication failed \(401\)/);
    assert.match(out, /Incorrect API key/);
  });

  it('404 → model-not-found message', () => {
    const body = JSON.stringify({ error: { message: "The model 'gpt-fake' does not exist" } });
    const out = formatResponsesApiError(404, body);
    assert.match(out, /Model not found \(404\)/);
  });

  it('handles malformed JSON body gracefully', () => {
    const out = formatResponsesApiError(500, 'not json {');
    assert.match(out, /LLM error \(500\)/);
    assert.ok(out.includes('not json'));
  });

  it('handles empty body', () => {
    const out = formatResponsesApiError(500, '');
    assert.match(out, /LLM error \(500\)/);
  });
});

describe('modelRequiresResponsesApi (routing for gpt-5 family)', () => {
  it('routes gpt-5.4 family through Responses API', () => {
    assert.strictEqual(modelRequiresResponsesApi('gpt-5.4'), true);
    assert.strictEqual(modelRequiresResponsesApi('gpt-5.4-mini'), true);
    assert.strictEqual(modelRequiresResponsesApi('gpt-5.4-2026-03-05'), true);
  });

  it('routes other gpt-5 variants through Responses API', () => {
    assert.strictEqual(modelRequiresResponsesApi('gpt-5.1'), true);
    assert.strictEqual(modelRequiresResponsesApi('gpt-5-mini'), true);
    assert.strictEqual(modelRequiresResponsesApi('gpt-5-nano'), true);
    assert.strictEqual(modelRequiresResponsesApi('gpt-5-codex'), true);
    assert.strictEqual(modelRequiresResponsesApi('gpt-5.2-codex'), true);
  });

  it('keeps gpt-4* models on chat-completions', () => {
    assert.strictEqual(modelRequiresResponsesApi('gpt-4o'), false);
    assert.strictEqual(modelRequiresResponsesApi('gpt-4o-mini'), false);
    assert.strictEqual(modelRequiresResponsesApi('gpt-4.1'), false);
    assert.strictEqual(modelRequiresResponsesApi('gpt-4-turbo'), false);
  });

  it('keeps o-series on chat-completions', () => {
    assert.strictEqual(modelRequiresResponsesApi('o1'), false);
    assert.strictEqual(modelRequiresResponsesApi('o3'), false);
    assert.strictEqual(modelRequiresResponsesApi('o4-mini'), false);
  });

  it('keeps non-OpenAI models off the Responses API path', () => {
    assert.strictEqual(modelRequiresResponsesApi('claude-sonnet-4-6'), false);
    assert.strictEqual(modelRequiresResponsesApi('llama-3.3-70b'), false);
    assert.strictEqual(modelRequiresResponsesApi(''), false);
  });

  it('is case-insensitive', () => {
    assert.strictEqual(modelRequiresResponsesApi('GPT-5.4'), true);
    assert.strictEqual(modelRequiresResponsesApi('Gpt-5-Mini'), true);
  });
});
