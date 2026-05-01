/**
 * AnthropicProvider regression tests.
 *
 * Restored to source in PR 26.5 — the dist/providers/anthropic.test.js
 * had been hanging around as a "stale dist" with no .ts counterpart,
 * which made the failing tests look like ambient noise on `main`. The
 * three bugs the tests actually pin are real:
 *
 * 1. Truncated `input_json_delta` at message_delta — the provider used
 *    to flush every accumulated tool_use block as `tool_call_end`
 *    even when its `block.input` was incomplete JSON. The agent loop
 *    surfaced that as "Invalid JSON arguments for <tool>", which
 *    pointed the blame at the model when the real cause was a
 *    truncated stream. The guard validates `block.input` with
 *    JSON.parse first; on failure it emits `error` and SUPPRESSES
 *    the tool_call_end.
 *
 * 2. Same shape on the post-loop fallback flush, which fires when
 *    the stream ends entirely without a `message_delta` event
 *    (CHUNK_TIMEOUT, server hangup, max_tokens mid-tool_use).
 *
 * 3. SSE chunk-boundary scoping. Anthropic's wire format is two-line
 *    records: `event: <name>\ndata: <json>\n\n`. When a chunk
 *    boundary lands BETWEEN those two lines, the data: line in the
 *    next chunk needs the event name from the previous chunk. The
 *    parser used to declare `currentEvent` inside the chunk-read
 *    loop, which reset to `''` on every chunk and silently dropped
 *    the data line. Caught cold in
 *    ~/.codebot/debug/sse-anthropic-2026-04-21T04-11-47-837Z.jsonl:
 *      chunk A (28B): "event: content_block_delta\nd"
 *      chunk B (543B): "ata: {...partial_json:\"head[1\"}\n\n..."
 *    The fix moves the declaration outside the loop so it survives
 *    chunk boundaries.
 */

import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { AnthropicProvider } from './anthropic';
import type { StreamEvent } from '../types';

/**
 * Build a mock fetch that returns a streaming Response whose body
 * yields the given SSE lines. Each entry becomes one Uint8Array
 * chunk, so chunk boundaries are deterministic.
 */
function mockFetchWithSSE(sseLines: string[]): typeof fetch {
  return (async () => {
    const encoder = new TextEncoder();
    const stream = new ReadableStream({
      start(controller) {
        for (const line of sseLines) {
          controller.enqueue(encoder.encode(line));
        }
        controller.close();
      },
    });
    return new Response(stream, {
      status: 200,
      headers: { 'Content-Type': 'text/event-stream' },
    });
  }) as unknown as typeof fetch;
}

async function collect(provider: AnthropicProvider): Promise<StreamEvent[]> {
  const events: StreamEvent[] = [];
  for await (const ev of provider.chat([{ role: 'user', content: 'ignored' }])) {
    events.push(ev);
  }
  return events;
}

describe('AnthropicProvider truncated-tool_use guard', () => {
  it('truncated input_json_delta at message_delta → emits error, NOT tool_call_end', async () => {
    const originalFetch = globalThis.fetch;
    // SSE sequence: tool_use block opens, two input_json_delta chunks
    // build an INCOMPLETE JSON object ('{"content":"hello' — no closing
    // quote or brace), then message_delta tells us the message is done.
    // With the guard, this must yield an `error` event, not a malformed
    // tool_call_end.
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"write_file","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"content\\":\\"hel"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"lo"}}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"max_tokens"},"usage":{"output_tokens":5}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    globalThis.fetch = mockFetchWithSSE(sse);
    try {
      const provider = new AnthropicProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-3-5-sonnet-20241022',
      });
      const events = await collect(provider);
      const toolCallEnds = events.filter(e => e.type === 'tool_call_end');
      const errors = events.filter(e => e.type === 'error');
      assert.strictEqual(toolCallEnds.length, 0,
        `Expected no tool_call_end for a truncated stream; got ${toolCallEnds.length}. ` +
        `Events: ${JSON.stringify(events.map(e => e.type))}`);
      assert.ok(errors.length >= 1, `Expected an error event; got ${errors.length}`);
      const errMsg = errors[0].error || '';
      assert.match(errMsg, /incomplete tool_use/, `Error message: ${errMsg}`);
      assert.match(errMsg, /write_file/, `Error should name the tool: ${errMsg}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('complete input_json_delta at message_delta → emits tool_call_end with valid JSON', async () => {
    const originalFetch = globalThis.fetch;
    // Control case: the same stream but COMPLETE. Must produce one
    // tool_call_end with parseable arguments and zero errors.
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"write_file","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"content\\":\\"hel"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"lo\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":10}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    globalThis.fetch = mockFetchWithSSE(sse);
    try {
      const provider = new AnthropicProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-3-5-sonnet-20241022',
      });
      const events = await collect(provider);
      const toolCallEnds = events.filter(e => e.type === 'tool_call_end');
      const errors = events.filter(e => e.type === 'error');
      assert.strictEqual(errors.length, 0, `Expected no errors; got ${JSON.stringify(errors)}`);
      assert.strictEqual(toolCallEnds.length, 1, 'Expected exactly one tool_call_end');
      const tc = toolCallEnds[0].toolCall as { function: { name: string; arguments: string } };
      assert.strictEqual(tc.function.name, 'write_file');
      const parsed = JSON.parse(tc.function.arguments);
      assert.strictEqual(parsed.content, 'hello');
    } finally {
      globalThis.fetch = originalFetch;
    }
  });

  it('stream ends before message_delta (fallback flush) with incomplete JSON → emits error', async () => {
    const originalFetch = globalThis.fetch;
    // Stream is cut off entirely — no message_delta, no message_stop.
    // The fallback flush path at the end of chat() hits this case.
    const sse = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"write_file","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"content\\":\\"hel"}}\n\n',
      // ...stream ends here
    ];
    globalThis.fetch = mockFetchWithSSE(sse);
    try {
      const provider = new AnthropicProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-3-5-sonnet-20241022',
      });
      const events = await collect(provider);
      const toolCallEnds = events.filter(e => e.type === 'tool_call_end');
      const errors = events.filter(e => e.type === 'error');
      assert.strictEqual(toolCallEnds.length, 0, `Expected no tool_call_end on aborted stream; got ${toolCallEnds.length}`);
      assert.ok(errors.length >= 1, 'Expected an error event on aborted stream');
      const msgs = errors.map(e => e.error || '').join(' | ');
      assert.match(msgs, /incomplete tool_use/, `Error chain: ${msgs}`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});

/**
 * Regression test for the REAL root cause of "Invalid JSON arguments" /
 * garbled Python in write_file. The SSE parser used to declare
 * `currentEvent` inside the chunk-read loop, so when a chunk boundary
 * fell between `event: content_block_delta\n` and its `data: {...}\n`
 * line, the `data:` line ran through `switch('')` and was silently
 * dropped — the entire content_block_delta event disappeared.
 *
 * Caught cold in
 * ~/.codebot/debug/sse-anthropic-2026-04-21T04-11-47-837Z.jsonl:
 *   chunk A (28B): "event: content_block_delta\nd"
 *   chunk B (543B): "ata: {...partial_json:\"head[1\"}\n\nevent:..."
 * Net result: Python source `new_head[1] < GRID_ROWS` arrived as
 * `new_] < GRID_ROWS` on disk.
 *
 * This test splits a realistic tool_use stream at the worst possible
 * chunk boundary and asserts that EVERY partial_json delta makes it
 * into the final tool_call_end arguments.
 */
describe('AnthropicProvider chunk-boundary event scoping', () => {
  it('event: line and its data: line split across chunks → delta is NOT dropped', async () => {
    const originalFetch = globalThis.fetch;
    const preamble = [
      'event: message_start\ndata: {"type":"message_start","message":{"id":"msg_1","usage":{"input_tokens":10,"output_tokens":0}}}\n\n',
      'event: content_block_start\ndata: {"type":"content_block_start","index":0,"content_block":{"type":"tool_use","id":"toolu_1","name":"write_file","input":{}}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"{\\"content\\":\\"new_"}}\n\n',
    ];
    // The split chunk: event line in chunk A, data line in chunk B.
    const splitA = 'event: content_block_delta\nd';
    const splitB = 'ata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"head[1"}}\n\n';
    const tail = [
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":"] <"}}\n\n',
      'event: content_block_delta\ndata: {"type":"content_block_delta","index":0,"delta":{"type":"input_json_delta","partial_json":" END\\"}"}}\n\n',
      'event: content_block_stop\ndata: {"type":"content_block_stop","index":0}\n\n',
      'event: message_delta\ndata: {"type":"message_delta","delta":{"stop_reason":"tool_use"},"usage":{"output_tokens":10}}\n\n',
      'event: message_stop\ndata: {"type":"message_stop"}\n\n',
    ];
    const sse = [...preamble, splitA, splitB, ...tail];
    globalThis.fetch = mockFetchWithSSE(sse);
    try {
      const provider = new AnthropicProvider({
        apiKey: 'test-key',
        baseUrl: 'https://api.anthropic.com',
        model: 'claude-3-5-sonnet-20241022',
      });
      const events = await collect(provider);
      const toolCallEnds = events.filter(e => e.type === 'tool_call_end');
      const errors = events.filter(e => e.type === 'error');
      assert.strictEqual(errors.length, 0, `Expected no errors; got ${JSON.stringify(errors)}`);
      assert.strictEqual(toolCallEnds.length, 1,
        `Expected exactly one tool_call_end; got ${toolCallEnds.length}. events: ${JSON.stringify(events.map(e => e.type))}`);
      const tc = toolCallEnds[0].toolCall as { function: { name: string; arguments: string } };
      const parsed = JSON.parse(tc.function.arguments);
      // Deltas concatenate to: "new_" + "head[1" + "] <" + " END"
      //                      = "new_head[1] < END"
      // With the bug: "head[1" vanishes → "new_] < END" (missing 6 chars).
      // With the fix: all deltas land → "new_head[1] < END".
      assert.strictEqual(parsed.content, 'new_head[1] < END',
        `Expected all 4 deltas concatenated; got "${parsed.content}". The "head[1" delta after the split-chunk boundary was dropped.`);
    } finally {
      globalThis.fetch = originalFetch;
    }
  });
});
