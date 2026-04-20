import { LLMProvider, Message, ToolSchema, StreamEvent, ProviderConfig, ToolCall } from '../types';
import { getModelInfo } from './registry';
import { isRetryable, getRetryDelay, sleep } from '../retry';

/**
 * Sanitize an object tree so that no JS string contains lone UTF-16 surrogates.
 * Lone surrogates are valid in JS strings but NOT in JSON/UTF-8. Strict parsers
 * (like Anthropic's) reject them even when JSON.stringify escapes them as \uD8xx.
 */
function sanitizeForJSON(obj: unknown): unknown {
  if (typeof obj === 'string') {
    let out = '';
    for (let i = 0; i < obj.length; i++) {
      const c = obj.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF) {
        // High surrogate — keep only if followed by a low surrogate
        const next = i + 1 < obj.length ? obj.charCodeAt(i + 1) : 0;
        if (next >= 0xDC00 && next <= 0xDFFF) {
          out += obj[i] + obj[i + 1];
          i++;
        }
        // else: drop the lone high surrogate
      } else if (c >= 0xDC00 && c <= 0xDFFF) {
        // Lone low surrogate — drop
      } else {
        out += obj[i];
      }
    }
    return out;
  }
  if (Array.isArray(obj)) return obj.map(sanitizeForJSON);
  if (obj !== null && typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(obj)) {
      result[key] = sanitizeForJSON(val);
    }
    return result;
  }
  return obj;
}

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | Array<{ type: string; [key: string]: unknown }>;
}

export class AnthropicProvider implements LLMProvider {
  name: string;
  temperature?: number;
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.name = config.model;
  }

  async *chat(messages: Message[], tools?: ToolSchema[]): AsyncGenerator<StreamEvent> {
    // Early check: Anthropic always requires an API key
    if (!this.config.apiKey) {
      yield { type: 'error', error: `No API key configured for ${this.config.model}. Set ANTHROPIC_API_KEY or run: codebot --setup` };
      return;
    }

    const { systemPrompt, apiMessages } = this.convertMessages(messages);

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: apiMessages,
      max_tokens: 8192,
      stream: true,
    };

    if (this.temperature !== undefined) {
      body.temperature = this.temperature;
    }

    // Prompt caching: use content block array with cache_control for Anthropic models
    const cachingEnabled = getModelInfo(this.config.model).supportsCaching;
    if (systemPrompt) {
      if (cachingEnabled) {
        body.system = [{
          type: 'text',
          text: systemPrompt,
          cache_control: { type: 'ephemeral' },
        }];
      } else {
        body.system = systemPrompt;
      }
    }

    if (tools?.length) {
      const toolDefs = tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
      // Mark the last tool for caching (caches all tool definitions up to this point)
      if (cachingEnabled && toolDefs.length > 0) {
        (toolDefs[toolDefs.length - 1] as Record<string, unknown>).cache_control = { type: 'ephemeral' };
      }
      body.tools = toolDefs;
    }

    const baseUrl = this.config.baseUrl.replace(/\/+$/, '');
    const MAX_RETRIES = 3;
    let response!: Response;
    let lastError = '';

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      // IMPORTANT: this abort signal was previously AbortSignal.timeout(60_000),
      // which is a hard 60-second deadline on the ENTIRE streaming response —
      // not just headers. For heavy tool-use outputs (big file writes, long
      // multi-tool plans) the model legitimately thinks >60s before the first
      // content block, and the signal was aborting mid-stream with
      // "The operation was aborted due to timeout", looking like an API stall
      // when the real cause was our own client. We detach the signal after
      // headers arrive so streaming can continue for as long as chunks do.
      const connectCtrl = new AbortController();
      const connectTimer = setTimeout(() => connectCtrl.abort(), 60_000);
      try {
        response = await fetch(`${baseUrl}/v1/messages`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'x-api-key': this.config.apiKey || '',
            'anthropic-version': '2023-06-01',
            ...(cachingEnabled ? { 'anthropic-beta': 'prompt-caching-2024-07-31' } : {}),
          },
          body: JSON.stringify(sanitizeForJSON(body)),
          signal: connectCtrl.signal,
        });
        // Headers are in; stop the connect-phase deadline so the body stream
        // is bounded only by CHUNK_TIMEOUT (per-chunk gap) below.
        clearTimeout(connectTimer);

        if (response.ok || !isRetryable(null, response.status)) {
          break;
        }

        lastError = `Anthropic error ${response.status}`;
        if (attempt < MAX_RETRIES) {
          const delay = getRetryDelay(attempt, response.headers.get('retry-after'));
          await sleep(delay);
          continue;
        }
      } catch (err: unknown) {
        clearTimeout(connectTimer);
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt < MAX_RETRIES && isRetryable(err)) {
          const delay = getRetryDelay(attempt);
          await sleep(delay);
          continue;
        }
        yield { type: 'error', error: `Connection failed after ${attempt + 1} attempts: ${lastError}` };
        return;
      }
    }

    if (!response || !response.ok) {
      const text = response ? await response.text().catch(() => '') : '';
      // Extract readable error message from JSON response
      let errorMessage = '';
      try {
        const json = JSON.parse(text);
        errorMessage = json?.error?.message || json?.message || '';
      } catch {
        errorMessage = text.substring(0, 200);
      }
      const status = response?.status;
      if (status === 401 || (errorMessage && errorMessage.toLowerCase().includes('api key'))) {
        yield { type: 'error', error: `Authentication failed (${status}): ${errorMessage || 'Invalid API key'}. Set ANTHROPIC_API_KEY or run: codebot --setup` };
      } else if (status === 403) {
        yield { type: 'error', error: `Access denied (403): ${errorMessage || 'Permission denied'}. Check your API key permissions.` };
      } else if (status === 404) {
        yield { type: 'error', error: `Model not found (404): ${errorMessage || `"${this.config.model}" may not be available`}.` };
      } else {
        yield { type: 'error', error: `Anthropic error (${status || 'unknown'}): ${errorMessage || lastError || 'Unknown error'}` };
      }
      return;
    }

    if (!response.body) {
      yield { type: 'error', error: 'No response body from Anthropic' };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    // Track current content blocks
    const toolBlocks: Map<number, { id: string; name: string; input: string }> = new Map();
    let currentBlockIndex = -1;
    let currentBlockType = '';

    // ─── SSE diagnostic tap ───────────────────────────────────────────────
    // Opt-in with CODEBOT_DEBUG_SSE=1. Writes every raw SSE chunk, every
    // decoded event, every input_json_delta, and the final concatenated
    // block.input to a per-stream file. This is the instrument for finding
    // mid-stream chunk drops that corrupt tool-call JSON.
    // Why opt-in: for long tool_use outputs this can be 10+ MB of data and
    // slows down the hot path, so we do NOT want it on by default.
    const debugSSE = process.env.CODEBOT_DEBUG_SSE === '1';
    let debugLog: ((kind: string, payload: unknown) => void) | null = null;
    if (debugSSE) {
      try {
        const fs = await import('fs');
        const os = await import('os');
        const path = await import('path');
        const dir = path.join(os.homedir(), '.codebot', 'debug');
        fs.mkdirSync(dir, { recursive: true });
        const stamp = new Date().toISOString().replace(/[:.]/g, '-');
        const file = path.join(dir, `sse-anthropic-${stamp}.jsonl`);
        const stream = fs.createWriteStream(file, { flags: 'a' });
        debugLog = (kind: string, payload: unknown) => {
          try {
            stream.write(JSON.stringify({ t: Date.now(), kind, payload }) + '\n');
          } catch {
            /* best-effort */
          }
        };
        debugLog('session_start', { model: this.config.model, file });
      } catch {
        debugLog = null;
      }
    }

    try {
      while (true) {
        // Chunk gap before we declare the stream dead. 120s was too aggressive:
        // heavy tool-use outputs (large file writes) can pause longer than that
        // between SSE chunks while the model thinks, and we were killing real
        // work mid-generation. 300s matches Anthropic's own keep-alive window
        // and lines up with what larger models actually need on a cache-cold
        // first call. The API sends `: heartbeat` every ~15s when it's alive,
        // so a true 5-minute silence is a real stall worth aborting.
        const CHUNK_TIMEOUT = 300_000;
        let readResult: { done: boolean; value?: Uint8Array };
        try {
          readResult = await Promise.race([
            reader.read(),
            new Promise<never>((_, reject) =>
              setTimeout(() => reject(new Error('Stream chunk timeout after 300s')), CHUNK_TIMEOUT)
            ),
          ]);
        } catch (err) {
          yield { type: 'error', error: `Anthropic stream stalled: ${err instanceof Error ? err.message : String(err)}` };
          break;
        }
        const { done, value } = readResult;
        if (done) break;

        const chunkText = decoder.decode(value, { stream: true });
        if (debugLog) {
          debugLog('raw_chunk', {
            byteLen: value?.byteLength ?? 0,
            textLen: chunkText.length,
            text: chunkText,
          });
        }
        buffer += chunkText;
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let currentEvent = '';

        for (const line of lines) {
          const trimmed = line.trim();

          if (trimmed.startsWith('event: ')) {
            currentEvent = trimmed.slice(7);
            continue;
          }

          if (!trimmed.startsWith('data: ')) continue;

          const dataStr = trimmed.slice(6);
          if (!dataStr || dataStr === '[DONE]') continue;

          let data: Record<string, unknown>;
          try {
            data = JSON.parse(dataStr);
          } catch (parseErr) {
            // This is the silent-drop site. If mid-stream chunks are being
            // lost, they will be dropped HERE. Log every dropped SSE line
            // when CODEBOT_DEBUG_SSE=1 is set.
            if (debugLog) {
              debugLog('sse_json_parse_fail', {
                dataStr,
                length: dataStr.length,
                currentEvent,
                error: parseErr instanceof Error ? parseErr.message : String(parseErr),
              });
            }
            continue;
          }

          switch (currentEvent) {
            case 'content_block_start': {
              const block = data.content_block as Record<string, unknown>;
              currentBlockIndex = data.index as number;
              currentBlockType = block?.type as string || '';
              if (debugLog) {
                debugLog('content_block_start', {
                  index: currentBlockIndex,
                  type: currentBlockType,
                  id: block?.id,
                  name: block?.name,
                });
              }

              if (currentBlockType === 'tool_use') {
                toolBlocks.set(currentBlockIndex, {
                  id: block.id as string,
                  name: block.name as string,
                  input: '',
                });
                yield {
                  type: 'tool_call_start',
                  toolCall: {
                    id: block.id as string,
                    type: 'function',
                    function: { name: block.name as string, arguments: '' },
                  },
                };
              } else if (currentBlockType === 'thinking') {
                yield { type: 'thinking', text: '' };
              }
              break;
            }

            case 'content_block_delta': {
              const delta = data.delta as Record<string, unknown>;
              const deltaType = delta?.type as string;

              if (deltaType === 'text_delta') {
                yield { type: 'text', text: delta.text as string };
              } else if (deltaType === 'input_json_delta') {
                const partial = delta.partial_json as string;
                const eventIndex = data.index as number;
                const block = toolBlocks.get(currentBlockIndex);
                if (debugLog) {
                  debugLog('input_json_delta', {
                    currentBlockIndex,
                    eventIndex,
                    mismatch: eventIndex !== currentBlockIndex,
                    partialLen: partial?.length ?? 0,
                    partial,
                    runningInputLen: block ? block.input.length + (partial?.length ?? 0) : -1,
                    blockExists: !!block,
                  });
                }
                if (block) {
                  block.input += partial;
                }
                yield { type: 'tool_call_delta', text: partial };
              } else if (deltaType === 'thinking_delta') {
                yield { type: 'thinking', text: delta.thinking as string };
              }
              break;
            }

            case 'content_block_stop': {
              if (debugLog) {
                const idx = data.index as number;
                const block = toolBlocks.get(idx);
                debugLog('content_block_stop', {
                  index: idx,
                  currentBlockIndex,
                  blockInputLen: block?.input.length ?? null,
                  // Check if concatenated JSON parses at this point
                  blockInputParses: block ? (() => {
                    try { JSON.parse(block.input); return true; } catch { return false; }
                  })() : null,
                });
              }
              if (currentBlockType === 'thinking') {
                yield { type: 'thinking', text: '\n' };
              }
              break;
            }

            case 'message_start': {
              const message = data.message as Record<string, unknown>;
              if (message?.usage) {
                const usage = message.usage as Record<string, number>;
                yield {
                  type: 'usage',
                  usage: {
                    inputTokens: usage.input_tokens,
                    outputTokens: usage.output_tokens,
                    cacheCreationTokens: usage.cache_creation_input_tokens || 0,
                    cacheReadTokens: usage.cache_read_input_tokens || 0,
                  },
                };
              }
              break;
            }

            case 'message_delta': {
              // Emit usage from message_delta
              const deltaUsage = (data.usage as Record<string, number>) || {};
              if (deltaUsage.output_tokens) {
                yield {
                  type: 'usage',
                  usage: { outputTokens: deltaUsage.output_tokens },
                };
              }

              // Message is ending — emit all accumulated tool calls.
              // Validate concatenated input_json_delta payload before emitting. A
              // truncated stream (e.g. CHUNK_TIMEOUT firing mid-input_json_delta, a
              // retryable 5xx mid-tool-use, or the model legitimately running out
              // of output tokens mid-JSON) would otherwise flush incomplete JSON,
              // and the agent loop would surface it as "Invalid JSON arguments for
              // <tool>" — misleading, because the real cause is a partial stream.
              for (const [, block] of toolBlocks) {
                const raw = block.input || '{}';
                if (debugLog) {
                  debugLog('tool_call_end_flush', {
                    name: block.name,
                    id: block.id,
                    inputLen: raw.length,
                    inputTail: raw.slice(-200),
                    parses: (() => { try { JSON.parse(raw); return true; } catch { return false; } })(),
                  });
                }
                try {
                  JSON.parse(raw);
                } catch (err) {
                  yield {
                    type: 'error',
                    error: `Anthropic: incomplete tool_use "${block.name}" — ${raw.length} chars of partial_json did not parse (${err instanceof Error ? err.message : String(err)}). Stream was truncated mid-tool-call; retry the turn.`,
                  };
                  continue;
                }
                yield {
                  type: 'tool_call_end',
                  toolCall: {
                    id: block.id,
                    type: 'function',
                    function: { name: block.name, arguments: raw },
                  } as ToolCall,
                };
              }
              break;
            }

            case 'message_stop': {
              yield { type: 'done' };
              return;
            }

            case 'error': {
              const error = data.error as Record<string, unknown>;
              yield { type: 'error', error: `Anthropic: ${error?.message || 'Unknown error'}` };
              return;
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // Emit remaining tool calls if stream ended without message_delta.
    // Same JSON-validity guard as the message_delta path: do not flush a
    // half-built tool_use. Anything the agent would reject as invalid JSON
    // surfaces here as a real "stream truncated" error instead.
    for (const [, block] of toolBlocks) {
      const raw = block.input || '{}';
      if (debugLog) {
        debugLog('tool_call_end_fallback_flush', {
          name: block.name,
          id: block.id,
          inputLen: raw.length,
          inputTail: raw.slice(-200),
          parses: (() => { try { JSON.parse(raw); return true; } catch { return false; } })(),
        });
      }
      try {
        JSON.parse(raw);
      } catch (err) {
        yield {
          type: 'error',
          error: `Anthropic: stream ended with incomplete tool_use "${block.name}" — ${raw.length} chars of partial_json did not parse (${err instanceof Error ? err.message : String(err)}).`,
        };
        continue;
      }
      yield {
        type: 'tool_call_end',
        toolCall: {
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: raw },
        } as ToolCall,
      };
    }
    if (debugLog) {
      debugLog('session_end', { bufferRemainingLen: buffer.length, buffer });
    }
    yield { type: 'done' };
  }

  private convertMessages(messages: Message[]): { systemPrompt: string; apiMessages: AnthropicMessage[] } {
    let systemPrompt = '';
    const apiMessages: AnthropicMessage[] = [];

    for (const msg of messages) {
      if (msg.role === 'system') {
        systemPrompt += (systemPrompt ? '\n\n' : '') + msg.content;
        continue;
      }

      if (msg.role === 'assistant') {
        const content: Array<{ type: string; [key: string]: unknown }> = [];

        if (msg.content) {
          content.push({ type: 'text', text: msg.content });
        }

        if (msg.tool_calls) {
          for (const tc of msg.tool_calls) {
            let input: unknown;
            try {
              input = JSON.parse(tc.function.arguments);
            } catch {
              input = {};
            }
            content.push({
              type: 'tool_use',
              id: tc.id,
              name: tc.function.name,
              input,
            });
          }
        }

        apiMessages.push({
          role: 'assistant',
          content: content.length === 1 && content[0].type === 'text'
            ? content[0].text as string
            : content,
        });
        continue;
      }

      if (msg.role === 'tool') {
        // Tool results in Anthropic go as user messages with tool_result content
        // If the tool result has images (e.g., browser screenshot), include them as content blocks
        let toolContent: string | Array<{ type: string; [key: string]: unknown }> = msg.content;
        if (msg.images?.length) {
          const blocks: Array<{ type: string; [key: string]: unknown }> = [];
          if (msg.content) blocks.push({ type: 'text', text: msg.content });
          for (const img of msg.images) {
            blocks.push({
              type: 'image',
              source: { type: 'base64', media_type: img.mediaType, data: img.data },
            });
          }
          toolContent = blocks;
        }

        const lastMsg = apiMessages[apiMessages.length - 1];
        if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content)) {
          (lastMsg.content as Array<{ type: string; [key: string]: unknown }>).push({
            type: 'tool_result',
            tool_use_id: msg.tool_call_id,
            content: toolContent,
          });
        } else {
          apiMessages.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: msg.tool_call_id,
              content: toolContent,
            }],
          });
        }
        continue;
      }

      // Regular user message — may include images
      if (msg.images?.length) {
        const content: Array<{ type: string; [key: string]: unknown }> = [];
        if (msg.content) content.push({ type: 'text', text: msg.content });
        for (const img of msg.images) {
          content.push({
            type: 'image',
            source: { type: 'base64', media_type: img.mediaType, data: img.data },
          });
        }
        apiMessages.push({ role: 'user', content });
      } else {
        apiMessages.push({ role: 'user', content: msg.content });
      }
    }

    // Anthropic requires alternating user/assistant. Merge consecutive same-role messages.
    const merged: AnthropicMessage[] = [];
    for (const msg of apiMessages) {
      const last = merged[merged.length - 1];
      if (last && last.role === msg.role) {
        // Merge content — only merge when both are strings; otherwise push separately
        if (typeof last.content === 'string' && typeof msg.content === 'string') {
          last.content = last.content + '\n' + msg.content;
        } else {
          // Content types don't match (array vs string); push as separate entry
          merged.push(msg);
        }
      } else {
        merged.push(msg);
      }
    }

    return { systemPrompt, apiMessages: merged };
  }
}
