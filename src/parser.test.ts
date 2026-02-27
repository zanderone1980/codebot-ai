import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { parseToolCalls } from './parser';

describe('parseToolCalls', () => {
  it('parses XML tool_call tags', () => {
    const text = '<tool_call>{"name": "read_file", "arguments": {"path": "test.ts"}}</tool_call>';
    const calls = parseToolCalls(text);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].function.name, 'read_file');
    const args = JSON.parse(calls[0].function.arguments);
    assert.strictEqual(args.path, 'test.ts');
  });

  it('parses multiple tool calls', () => {
    const text = `Let me read both files.
<tool_call>{"name": "read_file", "arguments": {"path": "a.ts"}}</tool_call>
<tool_call>{"name": "read_file", "arguments": {"path": "b.ts"}}</tool_call>`;
    const calls = parseToolCalls(text);
    assert.strictEqual(calls.length, 2);
  });

  it('returns empty array when no tool calls', () => {
    const text = 'Just a regular response with no tool calls.';
    const calls = parseToolCalls(text);
    assert.strictEqual(calls.length, 0);
  });

  it('generates unique IDs for each call', () => {
    const text = `<tool_call>{"name": "a", "arguments": {}}</tool_call>
<tool_call>{"name": "b", "arguments": {}}</tool_call>`;
    const calls = parseToolCalls(text);
    assert.notStrictEqual(calls[0].id, calls[1].id);
  });

  it('handles malformed JSON gracefully', () => {
    const text = '<tool_call>{not valid json}</tool_call>';
    const calls = parseToolCalls(text);
    assert.strictEqual(calls.length, 0);
  });
});
