import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { banner, BANNER_1, BANNER_2, BANNER_3, randomGreeting, compactBanner, MASCOT_1, MASCOT_2, MASCOT_3 } from './banner';

describe('Banner', () => {
  it('banner function returns string with version and model', () => {
    const result = banner('1.0.0', 'qwen3:8b', 'ollama @ localhost:11434', 'abc123', false);
    assert.ok(result.includes('1.0.0'), 'Should contain version');
    assert.ok(result.includes('qwen3:8b'), 'Should contain model name');
    assert.ok(result.includes('CodeBot AI'), 'Should contain product name');
  });

  it('shows autonomous mode when enabled', () => {
    const result = banner('1.0.0', 'test', 'test', 'abc', true);
    assert.ok(result.includes('AUTONOMOUS'), 'Should show autonomous mode');
  });

  it('all three banners produce output', () => {
    const b1 = BANNER_1('1.0.0', 'test', 'test', 'abc', false);
    const b2 = BANNER_2('1.0.0', 'test', 'test', 'abc', false);
    const b3 = BANNER_3('1.0.0', 'test', 'test', 'abc', false);
    assert.ok(b1.length > 0, 'Banner 1 should have content');
    assert.ok(b2.length > 0, 'Banner 2 should have content');
    assert.ok(b3.length > 0, 'Banner 3 should have content');
  });

  it('mascot ASCII art has distinctive features', () => {
    assert.ok(MASCOT_1.includes('▄██▄'), 'Pixel Bot should have block eyes');
    assert.ok(MASCOT_2.includes('●'), 'Monitor Bot should have dot eyes');
    assert.ok(MASCOT_3.includes('░░'), 'Visor Helmet should have visor glass');
  });

  it('randomGreeting returns a string', () => {
    const greeting = randomGreeting();
    assert.ok(typeof greeting === 'string', 'Should return string');
    assert.ok(greeting.length > 0, 'Should not be empty');
  });

  it('compactBanner returns single-line banner', () => {
    const compact = compactBanner('1.0.0', 'test-model');
    assert.ok(compact.includes('CodeBot AI'), 'Should contain product name');
    assert.ok(compact.includes('test-model'), 'Should contain model');
    assert.ok(!compact.includes('\n'), 'Should be single line');
  });
});
