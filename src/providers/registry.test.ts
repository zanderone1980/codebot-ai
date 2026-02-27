import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { getModelInfo, detectProvider, MODEL_REGISTRY, PROVIDER_DEFAULTS } from './registry';

describe('getModelInfo', () => {
  it('returns info for exact model match', () => {
    const info = getModelInfo('gpt-4o');
    assert.strictEqual(info.contextWindow, 128000);
    assert.strictEqual(info.supportsToolCalling, true);
    assert.strictEqual(info.provider, 'openai');
  });

  it('returns info for Anthropic models', () => {
    const info = getModelInfo('claude-sonnet-4-6');
    assert.strictEqual(info.contextWindow, 200000);
    assert.strictEqual(info.provider, 'anthropic');
  });

  it('returns defaults for unknown models', () => {
    const info = getModelInfo('totally-unknown-model');
    assert.strictEqual(info.contextWindow, 8192);
    assert.strictEqual(info.supportsToolCalling, false);
  });

  it('handles prefix matching for ollama models', () => {
    const info = getModelInfo('qwen2.5-coder:32b');
    assert.strictEqual(info.supportsToolCalling, true);
    assert.strictEqual(info.contextWindow, 32768);
  });
});

describe('detectProvider', () => {
  it('detects anthropic from claude models', () => {
    assert.strictEqual(detectProvider('claude-opus-4-6'), 'anthropic');
    assert.strictEqual(detectProvider('claude-sonnet-4-6'), 'anthropic');
    assert.strictEqual(detectProvider('claude-haiku-4-5-20251001'), 'anthropic');
  });

  it('detects openai from gpt models', () => {
    assert.strictEqual(detectProvider('gpt-4o'), 'openai');
    assert.strictEqual(detectProvider('gpt-4.1'), 'openai');
    assert.strictEqual(detectProvider('o1'), 'openai');
    assert.strictEqual(detectProvider('o3-mini'), 'openai');
  });

  it('detects gemini', () => {
    assert.strictEqual(detectProvider('gemini-2.5-pro'), 'gemini');
  });

  it('detects deepseek', () => {
    assert.strictEqual(detectProvider('deepseek-chat'), 'deepseek');
  });

  it('detects xai from grok models', () => {
    assert.strictEqual(detectProvider('grok-3'), 'xai');
  });

  it('detects mistral', () => {
    assert.strictEqual(detectProvider('mistral-large-latest'), 'mistral');
    assert.strictEqual(detectProvider('codestral-latest'), 'mistral');
  });

  it('returns undefined for local models', () => {
    assert.strictEqual(detectProvider('qwen2.5-coder:32b'), undefined);
    assert.strictEqual(detectProvider('llama3.1:8b'), undefined);
  });
});

describe('PROVIDER_DEFAULTS', () => {
  it('has all expected providers', () => {
    const providers = Object.keys(PROVIDER_DEFAULTS);
    assert.ok(providers.includes('anthropic'));
    assert.ok(providers.includes('openai'));
    assert.ok(providers.includes('gemini'));
    assert.ok(providers.includes('deepseek'));
    assert.ok(providers.includes('groq'));
    assert.ok(providers.includes('mistral'));
    assert.ok(providers.includes('xai'));
  });

  it('each provider has baseUrl and envKey', () => {
    for (const [, defaults] of Object.entries(PROVIDER_DEFAULTS)) {
      assert.ok(defaults.baseUrl, 'missing baseUrl');
      assert.ok(defaults.envKey, 'missing envKey');
      assert.ok(defaults.baseUrl.startsWith('https://'), 'baseUrl should be https');
    }
  });
});

describe('MODEL_REGISTRY', () => {
  it('has models for all cloud providers', () => {
    const providers = new Set(
      Object.values(MODEL_REGISTRY)
        .map(info => info.provider)
        .filter(Boolean)
    );
    assert.ok(providers.has('anthropic'));
    assert.ok(providers.has('openai'));
    assert.ok(providers.has('gemini'));
    assert.ok(providers.has('deepseek'));
    assert.ok(providers.has('groq'));
    assert.ok(providers.has('mistral'));
    assert.ok(providers.has('xai'));
  });

  it('all models have contextWindow and supportsToolCalling', () => {
    for (const [name, info] of Object.entries(MODEL_REGISTRY)) {
      assert.ok(typeof info.contextWindow === 'number', `${name} missing contextWindow`);
      assert.ok(typeof info.supportsToolCalling === 'boolean', `${name} missing supportsToolCalling`);
      assert.ok(info.contextWindow > 0, `${name} has invalid contextWindow`);
    }
  });
});
