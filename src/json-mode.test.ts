import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { buildToolCallSchema, parseJsonModeResponse, parseToolCalls } from './parser';
import { getModelInfo, MODEL_REGISTRY } from './providers/registry';

describe('JSON Mode — registry supportsJsonMode (v2.1.6)', () => {
  it('OpenAI gpt-4o and gpt-4.1 support JSON mode', () => {
    assert.strictEqual(getModelInfo('gpt-4o').supportsJsonMode, true);
    assert.strictEqual(getModelInfo('gpt-4o-mini').supportsJsonMode, true);
    assert.strictEqual(getModelInfo('gpt-4.1').supportsJsonMode, true);
    assert.strictEqual(getModelInfo('gpt-4-turbo').supportsJsonMode, true);
  });

  it('Gemini models support JSON mode', () => {
    assert.strictEqual(getModelInfo('gemini-2.5-pro').supportsJsonMode, true);
    assert.strictEqual(getModelInfo('gemini-2.0-flash').supportsJsonMode, true);
  });

  it('Mistral models support JSON mode', () => {
    assert.strictEqual(getModelInfo('mistral-large-latest').supportsJsonMode, true);
    assert.strictEqual(getModelInfo('codestral-latest').supportsJsonMode, true);
  });

  it('Anthropic models do not declare JSON mode (native tool use is better)', () => {
    assert.strictEqual(getModelInfo('claude-sonnet-4-6').supportsJsonMode, undefined);
    assert.strictEqual(getModelInfo('claude-opus-4-6').supportsJsonMode, undefined);
  });

  it('local models do not declare JSON mode', () => {
    assert.strictEqual(getModelInfo('llama3.1:8b').supportsJsonMode, undefined);
    assert.strictEqual(getModelInfo('qwen2.5-coder:32b').supportsJsonMode, undefined);
  });
});

describe('JSON Mode — buildToolCallSchema', () => {
  it('generates valid JSON schema with tool names as enum', () => {
    const schema = buildToolCallSchema(['read_file', 'write_file', 'execute']);

    assert.strictEqual(schema.type, 'json_schema');
    const inner = (schema.json_schema as Record<string, unknown>);
    assert.strictEqual(inner.name, 'tool_calls');
    assert.strictEqual(inner.strict, true);

    const s = inner.schema as Record<string, unknown>;
    const props = s.properties as Record<string, Record<string, unknown>>;
    assert.ok(props.text, 'should have text property');
    assert.ok(props.tool_calls, 'should have tool_calls property');

    // Check tool_calls items have name enum
    const items = (props.tool_calls as Record<string, unknown>).items as Record<string, Record<string, unknown>>;
    const nameEnum = (items.properties as Record<string, Record<string, unknown>>).name.enum as string[];
    assert.deepStrictEqual(nameEnum, ['read_file', 'write_file', 'execute']);
  });

  it('requires text and tool_calls fields', () => {
    const schema = buildToolCallSchema(['think']);
    const inner = (schema.json_schema as Record<string, unknown>).schema as Record<string, unknown>;
    const required = inner.required as string[];
    assert.ok(required.includes('text'));
    assert.ok(required.includes('tool_calls'));
  });
});

describe('JSON Mode — parseJsonModeResponse', () => {
  it('parses a valid structured response with tool calls', () => {
    const json = JSON.stringify({
      text: 'Let me read that file.',
      tool_calls: [
        { name: 'read_file', arguments: { path: '/tmp/test.ts' } },
      ],
    });

    const result = parseJsonModeResponse(json);
    assert.strictEqual(result.text, 'Let me read that file.');
    assert.strictEqual(result.toolCalls.length, 1);
    assert.strictEqual(result.toolCalls[0].function.name, 'read_file');
    assert.strictEqual(result.toolCalls[0].function.arguments, '{"path":"/tmp/test.ts"}');
    assert.strictEqual(result.toolCalls[0].id, 'call_0');
  });

  it('parses multiple tool calls', () => {
    const json = JSON.stringify({
      text: '',
      tool_calls: [
        { name: 'glob', arguments: { pattern: '**/*.ts' } },
        { name: 'grep', arguments: { pattern: 'TODO', path: 'src/' } },
      ],
    });

    const result = parseJsonModeResponse(json);
    assert.strictEqual(result.toolCalls.length, 2);
    assert.strictEqual(result.toolCalls[0].function.name, 'glob');
    assert.strictEqual(result.toolCalls[1].function.name, 'grep');
    assert.strictEqual(result.toolCalls[1].id, 'call_1');
  });

  it('handles empty tool_calls array', () => {
    const json = JSON.stringify({
      text: 'Here is your answer.',
      tool_calls: [],
    });

    const result = parseJsonModeResponse(json);
    assert.strictEqual(result.text, 'Here is your answer.');
    assert.strictEqual(result.toolCalls.length, 0);
  });

  it('handles malformed JSON gracefully', () => {
    const result = parseJsonModeResponse('this is not json at all');
    assert.strictEqual(result.text, 'this is not json at all');
    assert.strictEqual(result.toolCalls.length, 0);
  });

  it('handles JSON embedded in other text', () => {
    const text = 'Here is my response:\n' + JSON.stringify({
      text: 'Reading the file.',
      tool_calls: [{ name: 'read_file', arguments: { path: 'src/index.ts' } }],
    });

    const result = parseJsonModeResponse(text);
    assert.strictEqual(result.toolCalls.length, 1);
    assert.strictEqual(result.toolCalls[0].function.name, 'read_file');
  });

  it('handles missing arguments gracefully', () => {
    const json = JSON.stringify({
      text: '',
      tool_calls: [{ name: 'think', arguments: undefined }],
    });

    const result = parseJsonModeResponse(json);
    assert.strictEqual(result.toolCalls.length, 1);
    assert.strictEqual(result.toolCalls[0].function.arguments, '{}');
  });
});

describe('JSON Mode — parseToolCalls integration', () => {
  it('parseToolCalls picks up JSON-mode structured output as first fallback', () => {
    const json = JSON.stringify({
      text: 'Working on it.',
      tool_calls: [
        { name: 'execute', arguments: { command: 'npm test' } },
      ],
    });

    const calls = parseToolCalls(json);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].function.name, 'execute');
  });

  it('still handles XML tool_call tags', () => {
    const text = '<tool_call>{"name": "read_file", "arguments": {"path": "/tmp/x"}}</tool_call>';
    const calls = parseToolCalls(text);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].function.name, 'read_file');
  });

  it('still handles function notation', () => {
    const text = 'read_file({"path": "/tmp/x"})';
    const calls = parseToolCalls(text);
    assert.strictEqual(calls.length, 1);
    assert.strictEqual(calls[0].function.name, 'read_file');
  });
});
