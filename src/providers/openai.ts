import { LLMProvider, Message, ToolSchema, StreamEvent, ProviderConfig, ToolCall } from '../types';
import { getModelInfo } from './registry';

export class OpenAIProvider implements LLMProvider {
  name: string;
  private config: ProviderConfig;
  private supportsTools: boolean;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.name = config.model;
    this.supportsTools = getModelInfo(config.model).supportsToolCalling;
  }

  async *chat(messages: Message[], tools?: ToolSchema[]): AsyncGenerator<StreamEvent> {
    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: messages.map(m => this.formatMessage(m)),
      stream: true,
    };

    if (tools?.length && this.supportsTools) {
      body.tools = tools;
    }

    // Ollama/local provider optimizations: set context window and keep model loaded
    const isLocal = this.config.baseUrl.includes('localhost') || this.config.baseUrl.includes('127.0.0.1');
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

    let response: Response;
    try {
      response = await fetch(`${this.config.baseUrl}/v1/chat/completions`, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: 'error', error: `Connection failed: ${msg}. Is your LLM server running?` };
      return;
    }

    if (!response.ok) {
      const text = await response.text();
      yield { type: 'error', error: `LLM error ${response.status}: ${text}` };
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

  private formatMessage(msg: Message): Record<string, unknown> {
    const formatted: Record<string, unknown> = { role: msg.role, content: msg.content };
    if (msg.tool_calls) formatted.tool_calls = msg.tool_calls;
    if (msg.tool_call_id) formatted.tool_call_id = msg.tool_call_id;
    if (msg.name) formatted.name = msg.name;
    return formatted;
  }
}
