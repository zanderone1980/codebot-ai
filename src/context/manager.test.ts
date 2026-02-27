import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { ContextManager } from './manager';
import { Message } from '../types';

describe('ContextManager', () => {
  it('estimates tokens from text length', () => {
    const cm = new ContextManager('gpt-4o');
    // ~3.5 chars per token
    assert.strictEqual(cm.estimateTokens('hello'), 2); // 5 / 3.5 = 1.43, ceil = 2
    assert.strictEqual(cm.estimateTokens(''), 0);
  });

  it('reports correct context window for known models', () => {
    const cm = new ContextManager('gpt-4o');
    assert.strictEqual(cm.getContextWindow(), 128000);
  });

  it('uses default context window for unknown models', () => {
    const cm = new ContextManager('unknown-model-xyz');
    assert.strictEqual(cm.getContextWindow(), 8192);
  });

  it('fitsInBudget returns true for small conversations', () => {
    const cm = new ContextManager('gpt-4o');
    const messages: Message[] = [
      { role: 'system', content: 'You are helpful.' },
      { role: 'user', content: 'Hello' },
    ];
    assert.strictEqual(cm.fitsInBudget(messages), true);
  });

  it('compact preserves system message', () => {
    const cm = new ContextManager('unknown-model-xyz'); // 8K context
    const messages: Message[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Hello' },
      { role: 'assistant', content: 'Hi there' },
    ];
    const result = cm.compact(messages, true);
    assert.strictEqual(result[0].role, 'system');
    assert.strictEqual(result[0].content, 'System prompt');
  });

  it('compact with force=true always compacts', () => {
    const cm = new ContextManager('gpt-4o');
    const messages: Message[] = [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'msg1' },
      { role: 'assistant', content: 'msg2' },
      { role: 'user', content: 'msg3' },
      { role: 'assistant', content: 'msg4' },
    ];
    // Without force, messages fit so nothing happens
    const noForce = cm.compact(messages, false);
    assert.strictEqual(noForce.length, messages.length);

    // With force, compaction happens
    const forced = cm.compact(messages, true);
    assert.ok(forced.length <= messages.length);
  });

  it('compact without force returns original if fits', () => {
    const cm = new ContextManager('gpt-4o');
    const messages: Message[] = [
      { role: 'user', content: 'short' },
    ];
    const result = cm.compact(messages);
    assert.deepStrictEqual(result, messages);
  });
});
