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

        buffer += decoder.decode(value, { stream: true });
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
          } catch {
            continue;
          }

          switch (currentEvent) {
            case 'content_block_start': {
              const block = data.content_block as Record<string, unknown>;
              currentBlockIndex = data.index as number;
              currentBlockType = block?.type as string || '';

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
                const block = toolBlocks.get(currentBlockIndex);
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

              // Message is ending — emit all accumulated tool calls
              for (const [, block] of toolBlocks) {
                yield {
                  type: 'tool_call_end',
                  toolCall: {
                    id: block.id,
                    type: 'function',
                    function: { name: block.name, arguments: block.input },
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

    // Emit remaining tool calls if stream ended without message_delta
    for (const [, block] of toolBlocks) {
      yield {
        type: 'tool_call_end',
        toolCall: {
          id: block.id,
          type: 'function',
          function: { name: block.name, arguments: block.input },
        } as ToolCall,
      };
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
