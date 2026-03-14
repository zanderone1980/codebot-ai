import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { classifyComplexity, classifyToolTier, selectModel, autoDetectTierModels, RouterConfig, ModelTier } from './router';

describe('Model Router — classifyComplexity edge cases', () => {
  it('classifies explain/describe as fast', () => {
    assert.strictEqual(classifyComplexity('explain this function'), 'fast');
    assert.strictEqual(classifyComplexity('describe the architecture'), 'fast');
    assert.strictEqual(classifyComplexity('tell me about this module'), 'fast');
  });

  it('classifies edit/fix/modify operations as standard', () => {
    assert.strictEqual(classifyComplexity('fix the typo in config'), 'standard');
    assert.strictEqual(classifyComplexity('modify the timeout setting'), 'standard');
    assert.strictEqual(classifyComplexity('delete the unused import'), 'standard');
  });

  it('classifies check/look as fast', () => {
    assert.strictEqual(classifyComplexity('check if the build passes'), 'fast');
    assert.strictEqual(classifyComplexity('look at the logs'), 'fast');
    assert.strictEqual(classifyComplexity('see what changed'), 'fast');
  });

  it('classifies "how to" questions as fast', () => {
    assert.strictEqual(classifyComplexity('how do I run the tests?'), 'fast');
    assert.strictEqual(classifyComplexity('how does the router work?'), 'fast');
  });

  it('classifies "debug complex" as powerful', () => {
    assert.strictEqual(classifyComplexity('debug the complex race condition'), 'powerful');
  });

  it('classifies "create a new app" as powerful', () => {
    assert.strictEqual(classifyComplexity('create a new REST API app with auth'), 'powerful');
  });

  it('classifies "optimize all performance" as powerful', () => {
    assert.strictEqual(classifyComplexity('optimize all the database queries'), 'powerful');
  });

  it('uses standard tools for mixed fast/standard tool calls', () => {
    assert.strictEqual(classifyComplexity('keep going', ['read_file', 'edit_file']), 'standard');
  });
});

describe('Model Router — classifyToolTier boundary cases', () => {
  it('handles mix of fast and standard as standard', () => {
    assert.strictEqual(classifyToolTier(['read_file', 'edit_file']), 'standard');
  });

  it('handles code_review as powerful', () => {
    assert.strictEqual(classifyToolTier(['code_review']), 'powerful');
  });

  it('handles batch_edit as powerful', () => {
    assert.strictEqual(classifyToolTier(['batch_edit']), 'powerful');
  });

  it('handles routine as powerful', () => {
    assert.strictEqual(classifyToolTier(['routine']), 'powerful');
  });

  it('fast tools include code_analysis and multi_search', () => {
    assert.strictEqual(classifyToolTier(['code_analysis', 'multi_search']), 'fast');
  });

  it('standard tools include database and test_runner', () => {
    assert.strictEqual(classifyToolTier(['database', 'test_runner']), 'standard');
  });
});

describe('Model Router — selectModel fallback behavior', () => {
  it('handles unknown tier gracefully by returning default', () => {
    const config: RouterConfig = { enabled: true, fastModel: 'fast', standardModel: 'std', powerfulModel: 'pow' };
    assert.strictEqual(selectModel('invalid' as ModelTier, config, 'fallback'), 'fallback');
  });
});

describe('Model Router — autoDetectTierModels additional cases', () => {
  it('detects o4-series as OpenAI family', () => {
    const tiers = autoDetectTierModels('o4-mini');
    assert.strictEqual(tiers.fastModel, 'gpt-4o-mini');
    assert.strictEqual(tiers.powerfulModel, 'o3');
  });

  it('detects groq with groq keyword', () => {
    const tiers = autoDetectTierModels('groq-llama');
    assert.strictEqual(tiers.fastModel, 'llama-3.1-8b-instant');
  });

  it('returns empty for completely unknown provider', () => {
    const tiers = autoDetectTierModels('mistral-large');
    assert.strictEqual(Object.keys(tiers).length, 0);
  });
});
