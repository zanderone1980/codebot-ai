import { LLMProvider, Message, ToolSchema, StreamEvent, ProviderConfig, ToolCall } from '../types';
import { getModelInfo } from './registry';
import { buildToolCallSchema } from '../parser';
import { isRetryable, getRetryDelay, sleep } from '../retry';

export class OpenAIProvider implements LLMProvider {
  name: string;
  temperature?: number;
  private config: ProviderConfig;
  private supportsTools: boolean;
  private supportsJsonMode: boolean;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.name = config.model;
    const modelInfo = getModelInfo(config.model);
    this.supportsTools = modelInfo.supportsToolCalling;
    this.supportsJsonMode = modelInfo.supportsJsonMode || false;
  }

  async *chat(messages: Message[], tools?: ToolSchema[]): AsyncGenerator<StreamEvent> {
    const isLocal = this.config.baseUrl.includes('localhost') || this.config.baseUrl.includes('127.0.0.1');

    // Early check: cloud providers require an API key
    if (!isLocal && !this.config.apiKey) {
      const hint = this.getApiKeyHint();
      yield { type: 'error', error: `No API key configured for ${this.config.model}. ${hint}` };
      return;
    }

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: messages.map(m => this.formatMessage(m)),
      stream: true,
      stream_options: { include_usage: true },
    };

    if (this.temperature !== undefined) {
      body.temperature = this.temperature;
    }

    if (tools?.length && this.supportsTools) {
      body.tools = tools;
    } else if (tools?.length && !this.supportsTools && this.supportsJsonMode) {
      // JSON mode fallback: use structured output for models without native tool calling (v2.1.6)
      const toolNames = tools.map(t => t.function.name);
      body.response_format = buildToolCallSchema(toolNames);
    }

    // Ollama/local provider optimizations: set context window and keep model loaded
    if (isLocal) {
      const modelInfo = getModelInfo(this.config.model);
      body.options = { num_ctx: modelInfo.contextWindow };
      body.keep_alive = '30m';
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
    };
    if (this.config.apiKey) {
      headers['Authorization'] = `Bearer ${this.config.apiKey}`;
    }

    const MAX_RETRIES = 3;
    let response!: Response;
    let lastError = '';

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        response = await fetch(`${this.config.baseUrl}/v1/chat/completions`, {
          method: 'POST',
          headers,
          body: JSON.stringify(body),
          signal: AbortSignal.timeout(isLocal ? 300_000 : 60_000),
        });

        if (response.ok || !isRetryable(null, response.status)) {
          break;
        }

        // Retryable HTTP status (429, 5xx)
        lastError = `LLM error ${response.status}`;
        if (attempt < MAX_RETRIES) {
          const delay = getRetryDelay(attempt, response.headers.get('retry-after'));
          await sleep(delay);
          continue;
        }
      } catch (err: unknown) {
        lastError = err instanceof Error ? err.message : String(err);
        if (attempt < MAX_RETRIES && isRetryable(err)) {
          const delay = getRetryDelay(attempt);
          await sleep(delay);
          continue;
        }
        yield { type: 'error', error: `Connection failed after ${attempt + 1} attempts: ${lastError}. Is your LLM server running?` };
        return;
      }
    }

    if (!response || !response.ok) {
      const text = response ? await response.text().catch(() => '') : '';
      const friendlyError = this.formatApiError(response?.status, text, lastError);
      yield { type: 'error', error: friendlyError };
      return;
    }

    if (!response.body) {
      yield { type: 'error', error: 'No response body from LLM' };
      return;
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const toolCalls: Map<number, { id: string; name: string; arguments: string }> = new Map();

    // Track <think>...</think> blocks (used by qwen3, deepseek, etc.)
    let insideThink = false;
    let contentBuffer = '';

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed || !trimmed.startsWith('data: ')) continue;

          if (trimmed === 'data: [DONE]') {
            // Flush any remaining content buffer
            if (contentBuffer && !insideThink) {
              yield { type: 'text', text: contentBuffer };
              contentBuffer = '';
            }
            for (const [, tc] of toolCalls) {
              yield {
                type: 'tool_call_end',
                toolCall: {
                  id: tc.id,
                  type: 'function',
                  function: { name: tc.name, arguments: tc.arguments },
                } as ToolCall,
              };
            }
            yield { type: 'done' };
            return;
          }

          try {
            const data = JSON.parse(trimmed.slice(6));

            // Parse usage from stream (requires stream_options.include_usage)
            if (data.usage) {
              const usage = data.usage;
              const cachedTokens = usage.prompt_tokens_details?.cached_tokens || 0;
              yield {
                type: 'usage',
                usage: {
                  inputTokens: usage.prompt_tokens || 0,
                  outputTokens: usage.completion_tokens || 0,
                  totalTokens: usage.total_tokens || 0,
                  cacheReadTokens: cachedTokens,
                },
              };
            }

            const delta = data.choices?.[0]?.delta;
            if (!delta) continue;

            if (delta.content) {
              contentBuffer += delta.content;

              // Process buffer for <think>...</think> tags
              let changed = true;
              while (changed) {
                changed = false;
                if (insideThink) {
                  const end = contentBuffer.indexOf('</think>');
                  if (end !== -1) {
                    // End of think block — discard thinking content, continue
                    contentBuffer = contentBuffer.slice(end + 8);
                    insideThink = false;
                    changed = true;
                  }
                  // else: still inside think, wait for more data
                } else {
                  const start = contentBuffer.indexOf('<think>');
                  if (start !== -1) {
                    // Found <think> — output everything before it, enter think mode
                    const before = contentBuffer.slice(0, start);
                    if (before) yield { type: 'text', text: before };
                    contentBuffer = contentBuffer.slice(start + 7);
                    insideThink = true;
                    changed = true;
                  } else {
                    // No think tag — check if buffer ends with a partial "<think" prefix
                    let holdBack = 0;
                    for (let len = Math.min(6, contentBuffer.length); len >= 1; len--) {
                      if ('<think>'.startsWith(contentBuffer.slice(-len))) {
                        holdBack = len;
                        break;
                      }
                    }
                    const safe = contentBuffer.slice(0, contentBuffer.length - holdBack);
                    contentBuffer = contentBuffer.slice(contentBuffer.length - holdBack);
                    if (safe) yield { type: 'text', text: safe };
                  }
                }
              }
            }

            if (delta.tool_calls) {
              for (const tc of delta.tool_calls) {
                const idx: number = tc.index ?? 0;
                if (!toolCalls.has(idx)) {
                  toolCalls.set(idx, {
                    id: tc.id || `call_${idx}`,
                    name: tc.function?.name || '',
                    arguments: '',
                  });
                  if (tc.function?.name) {
                    yield {
                      type: 'tool_call_start',
                      toolCall: {
                        id: tc.id,
                        type: 'function',
                        function: { name: tc.function.name, arguments: '' },
                      },
                    };
                  }
                }
                const entry = toolCalls.get(idx)!;
                if (tc.function?.name && !entry.name) {
                  entry.name = tc.function.name;
                }
                if (tc.function?.arguments) {
                  entry.arguments += tc.function.arguments;
                  yield { type: 'tool_call_delta', text: tc.function.arguments };
                }
              }
            }
          } catch {
            // Skip malformed SSE lines
          }
        }
      }
    } finally {
      reader.releaseLock();
    }

    // If we reach here without [DONE], flush remaining content buffer
    if (contentBuffer && !insideThink) {
      yield { type: 'text', text: contentBuffer };
      contentBuffer = '';
    }

    // Emit remaining tool calls
    for (const [, tc] of toolCalls) {
      yield {
        type: 'tool_call_end',
        toolCall: {
          id: tc.id,
          type: 'function',
          function: { name: tc.name, arguments: tc.arguments },
        } as ToolCall,
      };
    }
    yield { type: 'done' };
  }

  async listModels(): Promise<string[]> {
    try {
      const headers: Record<string, string> = {};
      if (this.config.apiKey) {
        headers['Authorization'] = `Bearer ${this.config.apiKey}`;
      }
      const res = await fetch(`${this.config.baseUrl}/v1/models`, {
        headers,
        signal: AbortSignal.timeout(5000),
      });
      if (!res.ok) return [];
      const data = await res.json() as { data?: Array<{ id: string }> };
      return (data.data || []).map(m => m.id);
    } catch {
      return [];
    }
  }

  /** Get a helpful hint about which env var to set for the current provider */
  private getApiKeyHint(): string {
    const url = this.config.baseUrl.toLowerCase();
    if (url.includes('openai.com')) return 'Set OPENAI_API_KEY or run: codebot --setup';
    if (url.includes('deepseek')) return 'Set DEEPSEEK_API_KEY or run: codebot --setup';
    if (url.includes('groq')) return 'Set GROQ_API_KEY or run: codebot --setup';
    if (url.includes('mistral')) return 'Set MISTRAL_API_KEY or run: codebot --setup';
    if (url.includes('generativelanguage.googleapis') || url.includes('gemini')) return 'Set GEMINI_API_KEY or run: codebot --setup';
    if (url.includes('x.ai') || url.includes('grok')) return 'Set XAI_API_KEY or run: codebot --setup';
    return 'Set your API key or run: codebot --setup';
  }

  /** Format API error responses into readable messages (not raw JSON) */
  private formatApiError(status: number | undefined, responseText: string, lastError: string): string {
    // Try to extract a useful message from JSON error response
    let errorMessage = '';
    try {
      const json = JSON.parse(responseText);
      errorMessage = json?.error?.message || json?.message || json?.error || '';
    } catch {
      errorMessage = responseText.substring(0, 200);
    }

    const hint = this.getApiKeyHint();

    if (status === 401 || (errorMessage && errorMessage.toLowerCase().includes('api key'))) {
      return `Authentication failed (${status || 'no status'}): ${errorMessage || 'Invalid or missing API key'}. ${hint}`;
    }
    if (status === 403) {
      return `Access denied (403): ${errorMessage || 'Permission denied'}. Check your API key permissions.`;
    }
    if (status === 404) {
      return `Model not found (404): ${errorMessage || `"${this.config.model}" may not be available`}. Check the model name.`;
    }
    if (status === 429) {
      return `Rate limited (429): ${errorMessage || 'Too many requests'}. Wait a moment and try again.`;
    }

    // Generic fallback — still clean, not raw JSON
    const statusStr = status ? `(${status})` : '';
    return `LLM error ${statusStr}: ${errorMessage || lastError || 'Unknown error'}`;
  }

  private formatMessage(msg: Message): Record<string, unknown> {
    const formatted: Record<string, unknown> = { role: msg.role, content: msg.content };

    // Vision: convert messages with images to content block array (v2.1.6)
    if (msg.images?.length) {
      const content: Array<Record<string, unknown>> = [];
      if (msg.content) content.push({ type: 'text', text: msg.content });
      for (const img of msg.images) {
        content.push({
          type: 'image_url',
          image_url: { url: `data:${img.mediaType};base64,${img.data}`, detail: 'auto' },
        });
      }
      formatted.content = content;
    }

    if (msg.tool_calls) {
      formatted.tool_calls = msg.tool_calls;
      // OpenAI (especially GPT-4.1) requires content: null when tool_calls are present
      // and there's no actual text content. Empty string "" causes 400 errors.
      if (!msg.content && !msg.images?.length) formatted.content = null;
    }
    if (msg.tool_call_id) formatted.tool_call_id = msg.tool_call_id;
    if (msg.name) formatted.name = msg.name;
    return formatted;
  }
}
