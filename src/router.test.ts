import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { classifyComplexity, classifyToolTier, selectModel, autoDetectTierModels, RouterConfig, ModelTier } from './router';

describe('Model Router — classifyComplexity (v2.1.6)', () => {
  it('classifies read/search requests as fast', () => {
    assert.strictEqual(classifyComplexity('read the README file'), 'fast');
    assert.strictEqual(classifyComplexity('show me package.json'), 'fast');
    assert.strictEqual(classifyComplexity('find all TypeScript files'), 'fast');
    assert.strictEqual(classifyComplexity('search for TODO comments'), 'fast');
    assert.strictEqual(classifyComplexity('what is this function?'), 'fast');
  });

  it('classifies short questions as fast', () => {
    assert.strictEqual(classifyComplexity('hi'), 'fast');
    assert.strictEqual(classifyComplexity('whats next?'), 'fast');
    assert.strictEqual(classifyComplexity('status'), 'fast');
  });

  it('classifies refactoring requests as powerful', () => {
    assert.strictEqual(classifyComplexity('refactor the authentication module'), 'powerful');
    assert.strictEqual(classifyComplexity('redesign the database schema'), 'powerful');
    assert.strictEqual(classifyComplexity('rewrite the API layer'), 'powerful');
    assert.strictEqual(classifyComplexity('do a security scan of the codebase'), 'powerful');
  });

  it('classifies implementation requests as powerful', () => {
    assert.strictEqual(classifyComplexity('implement a new authentication system'), 'powerful');
    assert.strictEqual(classifyComplexity('create a REST API server'), 'powerful');
    assert.strictEqual(classifyComplexity('design a caching layer'), 'powerful');
  });

  it('classifies multi-file changes as powerful', () => {
    assert.strictEqual(classifyComplexity('fix all errors across the project'), 'powerful');
    assert.strictEqual(classifyComplexity('review the code for issues'), 'powerful');
    assert.strictEqual(classifyComplexity('migrate from Express to Fastify'), 'powerful');
  });

  it('classifies long instructions as powerful', () => {
    const longMsg = 'I need you to ' + 'do something very specific '.repeat(20) + 'carefully.';
    assert.strictEqual(classifyComplexity(longMsg), 'powerful');
  });

  it('defaults to standard for moderate requests', () => {
    assert.strictEqual(classifyComplexity('edit the config file to change the port number'), 'standard');
    assert.strictEqual(classifyComplexity('add a new test for the login function'), 'standard');
    assert.strictEqual(classifyComplexity('update the version in package.json'), 'standard');
  });

  it('uses last tool calls for context', () => {
    // All fast tools → fast
    assert.strictEqual(classifyComplexity('do more of that', ['read_file', 'grep']), 'fast');
    // Any powerful tool → powerful
    assert.strictEqual(classifyComplexity('continue', ['browser', 'read_file']), 'powerful');
  });
});

describe('Model Router — classifyToolTier', () => {
  it('classifies read-only tools as fast', () => {
    assert.strictEqual(classifyToolTier(['read_file', 'glob', 'grep']), 'fast');
    assert.strictEqual(classifyToolTier(['think', 'memory']), 'fast');
  });

  it('classifies write tools as standard', () => {
    assert.strictEqual(classifyToolTier(['edit_file']), 'standard');
    assert.strictEqual(classifyToolTier(['write_file', 'git']), 'standard');
    assert.strictEqual(classifyToolTier(['execute']), 'standard');
  });

  it('classifies browser/docker/ssh as powerful', () => {
    assert.strictEqual(classifyToolTier(['browser']), 'powerful');
    assert.strictEqual(classifyToolTier(['docker']), 'powerful');
    assert.strictEqual(classifyToolTier(['ssh_remote']), 'powerful');
  });

  it('upgrades to powerful if any tool is powerful', () => {
    assert.strictEqual(classifyToolTier(['read_file', 'browser', 'grep']), 'powerful');
  });

  it('returns standard for empty tool list', () => {
    assert.strictEqual(classifyToolTier([]), 'standard');
  });
});

describe('Model Router — selectModel', () => {
  const config: RouterConfig = {
    enabled: true,
    fastModel: 'claude-3-5-haiku-20241022',
    standardModel: 'claude-sonnet-4-6',
    powerfulModel: 'claude-opus-4-6',
  };
  const defaultModel = 'claude-sonnet-4-6';

  it('selects fast model for fast tier', () => {
    assert.strictEqual(selectModel('fast', config, defaultModel), 'claude-3-5-haiku-20241022');
  });

  it('selects standard model for standard tier', () => {
    assert.strictEqual(selectModel('standard', config, defaultModel), 'claude-sonnet-4-6');
  });

  it('selects powerful model for powerful tier', () => {
    assert.strictEqual(selectModel('powerful', config, defaultModel), 'claude-opus-4-6');
  });

  it('falls back to default when router is disabled', () => {
    const disabled = { ...config, enabled: false };
    assert.strictEqual(selectModel('fast', disabled, defaultModel), defaultModel);
    assert.strictEqual(selectModel('powerful', disabled, defaultModel), defaultModel);
  });

  it('falls back to default when tier model is not configured', () => {
    const partial: RouterConfig = { enabled: true, fastModel: 'haiku' };
    assert.strictEqual(selectModel('fast', partial, defaultModel), 'haiku');
    assert.strictEqual(selectModel('standard', partial, defaultModel), defaultModel); // not set
    assert.strictEqual(selectModel('powerful', partial, defaultModel), defaultModel); // not set
  });
});

describe('Model Router — autoDetectTierModels', () => {
  it('detects Anthropic family tiers', () => {
    const tiers = autoDetectTierModels('claude-sonnet-4-6');
    assert.strictEqual(tiers.fastModel, 'claude-3-5-haiku-20241022');
    assert.strictEqual(tiers.standardModel, 'claude-sonnet-4-6');
    assert.strictEqual(tiers.powerfulModel, 'claude-opus-4-6');
  });

  it('detects OpenAI family tiers', () => {
    const tiers = autoDetectTierModels('gpt-4o');
    assert.strictEqual(tiers.fastModel, 'gpt-4o-mini');
    assert.strictEqual(tiers.standardModel, 'gpt-4o');
    assert.strictEqual(tiers.powerfulModel, 'o3');
  });

  it('detects Gemini family tiers', () => {
    const tiers = autoDetectTierModels('gemini-2.5-pro');
    assert.strictEqual(tiers.fastModel, 'gemini-2.0-flash');
    assert.strictEqual(tiers.standardModel, 'gemini-2.5-flash');
    assert.strictEqual(tiers.powerfulModel, 'gemini-2.5-pro');
  });

  it('detects DeepSeek family tiers', () => {
    const tiers = autoDetectTierModels('deepseek-chat');
    assert.strictEqual(tiers.fastModel, 'deepseek-chat');
    assert.strictEqual(tiers.powerfulModel, 'deepseek-reasoner');
  });

  it('detects Groq family tiers', () => {
    const tiers = autoDetectTierModels('llama-3.3-70b-versatile');
    assert.strictEqual(tiers.fastModel, 'llama-3.1-8b-instant');
    assert.strictEqual(tiers.powerfulModel, 'llama-3.3-70b-versatile');
  });

  it('returns empty for unknown models', () => {
    const tiers = autoDetectTierModels('my-custom-local-model');
    assert.strictEqual(Object.keys(tiers).length, 0);
  });

  it('works with o-series models', () => {
    const tiers = autoDetectTierModels('o3');
    assert.strictEqual(tiers.fastModel, 'gpt-4o-mini');
    assert.strictEqual(tiers.powerfulModel, 'o3');
  });
});
