import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { classifyComplexity, classifyToolTier, selectModel, autoDetectTierModels, RouterConfig, ModelTier } from './router';

describe('Model Router — classifyComplexity edge cases', () => {
  it('classifies explain/tell as fast', () => {
    assert.strictEqual(classifyComplexity('explain this function'), 'fast');
    assert.strictEqual(classifyComplexity('tell me about this module'), 'fast');
    assert.strictEqual(classifyComplexity('tell me what this does'), 'fast');
  });

  it('classifies edit/fix/modify operations as strong', () => {
    assert.strictEqual(classifyComplexity('fix the typo in config'), 'strong');
    assert.strictEqual(classifyComplexity('modify the timeout setting'), 'strong');
    assert.strictEqual(classifyComplexity('delete the unused import'), 'strong');
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

  it('classifies "debug complex" as reasoning', () => {
    assert.strictEqual(classifyComplexity('debug the complex race condition'), 'reasoning');
  });

  it('classifies "create a new app" as reasoning', () => {
    assert.strictEqual(classifyComplexity('create a new REST API app with auth'), 'reasoning');
  });

  it('classifies "optimize all performance" as reasoning', () => {
    assert.strictEqual(classifyComplexity('optimize all the database queries'), 'reasoning');
  });

  it('uses strong tools for mixed fast/strong tool calls', () => {
    assert.strictEqual(classifyComplexity('keep going', ['read_file', 'edit_file']), 'strong');
  });
});

describe('Model Router — classifyToolTier boundary cases', () => {
  it('handles mix of fast and strong as strong', () => {
    assert.strictEqual(classifyToolTier(['read_file', 'edit_file']), 'strong');
  });

  it('handles code_review as reasoning', () => {
    assert.strictEqual(classifyToolTier(['code_review']), 'reasoning');
  });

  it('handles batch_edit as reasoning', () => {
    assert.strictEqual(classifyToolTier(['batch_edit']), 'reasoning');
  });

  it('handles routine as reasoning', () => {
    assert.strictEqual(classifyToolTier(['routine']), 'reasoning');
  });

  it('fast tools include code_analysis and multi_search', () => {
    assert.strictEqual(classifyToolTier(['code_analysis', 'multi_search']), 'fast');
  });

  it('strong tools include database and test_runner', () => {
    assert.strictEqual(classifyToolTier(['database', 'test_runner']), 'strong');
  });
});

describe('Model Router — selectModel fallback behavior', () => {
  it('handles unknown tier gracefully by returning default', () => {
    const config: RouterConfig = { enabled: true, fastModel: 'fast', strongModel: 'std', reasoningModel: 'pow' };
    assert.strictEqual(selectModel('invalid' as ModelTier, config, 'fallback'), 'fallback');
  });
});

describe('Model Router — autoDetectTierModels additional cases', () => {
  it('detects o4-series as OpenAI family', () => {
    const tiers = autoDetectTierModels('o4-mini');
    assert.strictEqual(tiers.fastModel, 'gpt-4o-mini');
    assert.strictEqual(tiers.reasoningModel, 'o3');
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
