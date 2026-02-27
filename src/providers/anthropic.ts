import { LLMProvider, Message, ToolSchema, StreamEvent, ProviderConfig, ToolCall } from '../types';

interface AnthropicMessage {
  role: 'user' | 'assistant';
  content: string | Array<{ type: string; [key: string]: unknown }>;
}

export class AnthropicProvider implements LLMProvider {
  name: string;
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.name = config.model;
  }

  async *chat(messages: Message[], tools?: ToolSchema[]): AsyncGenerator<StreamEvent> {
    const { systemPrompt, apiMessages } = this.convertMessages(messages);

    const body: Record<string, unknown> = {
      model: this.config.model,
      messages: apiMessages,
      max_tokens: 8192,
      stream: true,
    };

    if (systemPrompt) {
      body.system = systemPrompt;
    }

    if (tools?.length) {
      body.tools = tools.map(t => ({
        name: t.function.name,
        description: t.function.description,
        input_schema: t.function.parameters,
      }));
    }

    const baseUrl = this.config.baseUrl.replace(/\/+$/, '');
    let response: Response;
    try {
      response = await fetch(`${baseUrl}/v1/messages`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'x-api-key': this.config.apiKey || '',
          'anthropic-version': '2023-06-01',
        },
        body: JSON.stringify(body),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      yield { type: 'error', error: `Connection failed: ${msg}` };
      return;
    }

    if (!response.ok) {
      const text = await response.text();
      yield { type: 'error', error: `Anthropic error ${response.status}: ${text}` };
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
        const { done, value } = await reader.read();
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
        const lastMsg = apiMessages[apiMessages.length - 1];
        if (lastMsg?.role === 'user' && Array.isArray(lastMsg.content)) {
          (lastMsg.content as Array<{ type: string; [key: string]: unknown }>).push({
            type: 'tool_result',
            tool_use_id: msg.tool_call_id,
            content: msg.content,
          });
        } else {
          apiMessages.push({
            role: 'user',
            content: [{
              type: 'tool_result',
              tool_use_id: msg.tool_call_id,
              content: msg.content,
            }],
          });
        }
        continue;
      }

      // Regular user message
      apiMessages.push({ role: 'user', content: msg.content });
    }

    // Anthropic requires alternating user/assistant. Merge consecutive same-role messages.
    const merged: AnthropicMessage[] = [];
    for (const msg of apiMessages) {
      const last = merged[merged.length - 1];
      if (last && last.role === msg.role) {
        // Merge content
        const lastContent = typeof last.content === 'string' ? last.content : '';
        const msgContent = typeof msg.content === 'string' ? msg.content : '';
        if (typeof last.content === 'string' && typeof msg.content === 'string') {
          last.content = lastContent + '\n' + msgContent;
        }
      } else {
        merged.push(msg);
      }
    }

    return { systemPrompt, apiMessages: merged };
  }
}
