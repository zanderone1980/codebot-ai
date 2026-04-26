import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { classifyComplexity, selectModel, ModelTier, RouterConfig } from './router';

describe('classifyComplexity', () => {
  it('classifies simple read operations as fast', () => {
    assert.strictEqual(classifyComplexity('read file.ts'), 'fast');
  });

  it('classifies short questions as fast', () => {
    assert.strictEqual(classifyComplexity('what is this?'), 'fast');
  });

  it('classifies edit operations as strong', () => {
    assert.strictEqual(classifyComplexity('edit the function to handle null'), 'strong');
  });

  it('classifies refactor requests as reasoning', () => {
    assert.strictEqual(classifyComplexity('refactor the entire authentication module'), 'reasoning');
  });

  it('classifies architecture requests as reasoning', () => {
    assert.strictEqual(classifyComplexity('architect a new microservice design'), 'reasoning');
  });

  it('classifies long messages as reasoning', () => {
    const longMsg = Array(100).fill('word').join(' ');
    assert.strictEqual(classifyComplexity(longMsg), 'reasoning');
  });

  it('uses last tool calls for context', () => {
    assert.strictEqual(classifyComplexity('continue', ['browser']), 'reasoning');
    assert.strictEqual(classifyComplexity('keep going', ['read_file']), 'fast');
  });

  it('classifies security scan as reasoning', () => {
    assert.strictEqual(classifyComplexity('run a security audit on the codebase'), 'reasoning');
  });

  it('classifies test/build as strong', () => {
    assert.strictEqual(classifyComplexity('run the tests'), 'strong');
  });

  it('classifies fix operations as strong', () => {
    assert.strictEqual(classifyComplexity('fix the bug in login'), 'strong');
  });
});

describe('selectModel', () => {
  const config: RouterConfig = {
    enabled: true,
    fastModel: 'haiku',
    strongModel: 'sonnet',
    reasoningModel: 'opus',
  };

  it('selects fast model for fast tier', () => {
    const result = selectModel('fast', config, 'default-model');
    assert.strictEqual(result, 'haiku');
  });

  it('selects strong model for strong tier', () => {
    const result = selectModel('strong', config, 'default-model');
    assert.strictEqual(result, 'sonnet');
  });

  it('selects reasoning model for reasoning tier', () => {
    const result = selectModel('reasoning', config, 'default-model');
    assert.strictEqual(result, 'opus');
  });

  it('falls back to default when disabled', () => {
    const disabled: RouterConfig = { enabled: false };
    const result = selectModel('reasoning', disabled, 'default-model');
    assert.strictEqual(result, 'default-model');
  });

  it('falls back to default when tier model is missing', () => {
    const partial: RouterConfig = { enabled: true, fastModel: 'haiku' };
    const result = selectModel('reasoning', partial, 'default-model');
    assert.strictEqual(result, 'default-model');
  });
});
