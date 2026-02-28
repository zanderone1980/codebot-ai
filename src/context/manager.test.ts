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

  it('compact never creates orphaned tool messages', () => {
    // Use a tiny context window model so compaction is forced
    const cm = new ContextManager('unknown-model-xyz'); // 8K context
    const bigContent = 'x'.repeat(10000); // ~2857 tokens — fills most of the budget

    const messages: Message[] = [
      { role: 'system', content: 'System prompt' },
      { role: 'user', content: 'Hello' },
      {
        role: 'assistant', content: '',
        tool_calls: [
          { id: 'call_1', type: 'function' as const, function: { name: 'execute', arguments: '{}' } },
        ],
      },
      { role: 'tool', content: bigContent, tool_call_id: 'call_1' },
      { role: 'user', content: 'Continue' },
      {
        role: 'assistant', content: '',
        tool_calls: [
          { id: 'call_2', type: 'function' as const, function: { name: 'think', arguments: '{}' } },
        ],
      },
      { role: 'tool', content: 'small result', tool_call_id: 'call_2' },
    ];

    const result = cm.compact(messages, true);

    // Verify no orphaned tool messages: every tool message must have
    // a preceding assistant with matching tool_calls
    const validIds = new Set<string>();
    for (const msg of result) {
      if (msg.role === 'assistant' && msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) {
          validIds.add(tc.id);
        }
      }
      if (msg.role === 'tool' && msg.tool_call_id) {
        assert.ok(
          validIds.has(msg.tool_call_id),
          `Orphaned tool message found: tool_call_id "${msg.tool_call_id}" has no matching assistant tool_call`
        );
      }
    }
  });

  it('compact keeps assistant+tool groups together or drops both', () => {
    const cm = new ContextManager('unknown-model-xyz'); // 8K context

    const messages: Message[] = [
      { role: 'system', content: 'System' },
      { role: 'user', content: 'First request' },
      {
        role: 'assistant', content: '',
        tool_calls: [
          { id: 'call_a', type: 'function' as const, function: { name: 'execute', arguments: '{}' } },
          { id: 'call_b', type: 'function' as const, function: { name: 'think', arguments: '{}' } },
        ],
      },
      { role: 'tool', content: 'result a', tool_call_id: 'call_a' },
      { role: 'tool', content: 'result b', tool_call_id: 'call_b' },
      { role: 'user', content: 'Second request' },
      { role: 'assistant', content: 'Done with everything.' },
    ];

    const result = cm.compact(messages, true);

    // Count assistant messages with tool_calls in result
    const assistantWithTools = result.filter(m => m.role === 'assistant' && m.tool_calls?.length);
    const toolMsgs = result.filter(m => m.role === 'tool');

    if (assistantWithTools.length > 0) {
      // If we kept the assistant, both tool messages should be there
      assert.strictEqual(toolMsgs.length, 2, 'If assistant with tool_calls is kept, both tool responses must be kept');
    } else {
      // If assistant was dropped, no tool messages should remain
      assert.strictEqual(toolMsgs.length, 0, 'If assistant with tool_calls is dropped, no tool responses should remain');
    }
  });

  it('compact handles multiple tool_call groups correctly', () => {
    const cm = new ContextManager('unknown-model-xyz'); // 8K context
    const mediumContent = 'x'.repeat(5000); // ~1428 tokens

    const messages: Message[] = [
      { role: 'system', content: 'System' },
      // Group 1
      { role: 'user', content: 'Do thing 1' },
      {
        role: 'assistant', content: '',
        tool_calls: [{ id: 'call_1', type: 'function' as const, function: { name: 'execute', arguments: '{}' } }],
      },
      { role: 'tool', content: mediumContent, tool_call_id: 'call_1' },
      // Group 2
      { role: 'user', content: 'Do thing 2' },
      {
        role: 'assistant', content: '',
        tool_calls: [{ id: 'call_2', type: 'function' as const, function: { name: 'think', arguments: '{}' } }],
      },
      { role: 'tool', content: 'small', tool_call_id: 'call_2' },
      // Final
      { role: 'user', content: 'Thanks' },
      { role: 'assistant', content: 'You are welcome.' },
    ];

    const result = cm.compact(messages, true);

    // Validate: no orphaned tool messages
    const validIds = new Set<string>();
    for (const msg of result) {
      if (msg.role === 'assistant' && msg.tool_calls?.length) {
        for (const tc of msg.tool_calls) validIds.add(tc.id);
      }
      if (msg.role === 'tool' && msg.tool_call_id) {
        assert.ok(
          validIds.has(msg.tool_call_id),
          `Orphaned tool message: "${msg.tool_call_id}" missing assistant`
        );
      }
    }
  });
});
