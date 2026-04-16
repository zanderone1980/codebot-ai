/**
 * OpenAI Responses API provider.
 *
 * The Responses API (`POST /v1/responses`) is OpenAI's newer endpoint that
 * supports the gpt-5.x family (gpt-5.4, gpt-5.4-mini, gpt-5-codex variants).
 * The chat-completions endpoint (`/v1/chat/completions`) does NOT have these
 * models, which is why selecting `gpt-5.4` from CodeBot used to return 404.
 *
 * This provider implements LLMProvider against the Responses API. It is a
 * SEPARATE class from OpenAIProvider so the existing chat-completions stack
 * (gpt-4o, gpt-4.1, etc.) keeps working unchanged.
 *
 * Implementation notes:
 *   - Non-streaming for now. The Responses API supports SSE but the agent
 *     loop here doesn't depend on token-by-token streaming for correctness;
 *     we yield text + tool_call events from the final `output[]` array.
 *   - Tool schema is FLATTER than chat-completions: top-level `name` /
 *     `description` / `parameters` instead of nested `function: {...}`.
 *   - Response items have type `message` (final answer), `function_call`
 *     (tool invocation), or `reasoning` (model thoughts — we surface these
 *     as `thinking` events when present).
 *   - Tool result feedback uses `function_call_output` items with the same
 *     `call_id` echoed back from the original `function_call`.
 */

import {
  LLMProvider,
  Message,
  ToolSchema,
  StreamEvent,
  ProviderConfig,
} from '../types';
import { isRetryable, getRetryDelay, sleep } from '../retry';

/** Strip lone UTF-16 surrogates so JSON.stringify doesn't produce strict-rejected output. */
function sanitizeForJSON(obj: unknown): unknown {
  if (typeof obj === 'string') {
    let out = '';
    for (let i = 0; i < obj.length; i++) {
      const c = obj.charCodeAt(i);
      if (c >= 0xD800 && c <= 0xDBFF) {
        const next = i + 1 < obj.length ? obj.charCodeAt(i + 1) : 0;
        if (next >= 0xDC00 && next <= 0xDFFF) {
          out += obj[i] + obj[i + 1];
          i++;
        }
      } else if (c >= 0xDC00 && c <= 0xDFFF) {
        // lone low surrogate — drop
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

interface ResponsesApiInputItem {
  role?: 'system' | 'user' | 'assistant';
  content?: string;
  type?: 'function_call' | 'function_call_output';
  call_id?: string;
  name?: string;
  arguments?: string;
  output?: string;
}

interface ResponsesApiOutputItem {
  id?: string;
  type: 'message' | 'function_call' | 'reasoning' | string;
  // message
  content?: Array<{ type: string; text?: string }>;
  // function_call
  call_id?: string;
  name?: string;
  arguments?: string;
  // reasoning
  summary?: Array<{ type: string; text?: string }> | string | null;
}

interface ResponsesApiBody {
  id: string;
  status: string;
  model: string;
  output?: ResponsesApiOutputItem[];
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
    total_tokens?: number;
    output_tokens_details?: { reasoning_tokens?: number };
    input_tokens_details?: { cached_tokens?: number };
  };
  error?: { message?: string; type?: string } | null;
}

export class OpenAIResponsesProvider implements LLMProvider {
  name: string;
  temperature?: number;
  private config: ProviderConfig;

  constructor(config: ProviderConfig) {
    this.config = config;
    this.name = config.model;
  }

  async *chat(messages: Message[], tools?: ToolSchema[]): AsyncGenerator<StreamEvent> {
    if (!this.config.apiKey) {
      yield {
        type: 'error',
        error: `No API key configured for ${this.config.model}. Set OPENAI_API_KEY or run: codebot --setup`,
      };
      return;
    }

    const baseUrl = this.config.baseUrl || 'https://api.openai.com';
    const endpoint = `${baseUrl.replace(/\/$/, '')}/v1/responses`;

    const input = this.buildInput(messages);

    const body: Record<string, unknown> = {
      model: this.config.model,
      input,
    };

    if (this.temperature !== undefined) {
      body.temperature = this.temperature;
    }

    if (tools?.length) {
      body.tools = tools.map(t => ({
        type: 'function',
        name: t.function.name,
        description: t.function.description,
        parameters: t.function.parameters,
      }));
      body.tool_choice = 'auto';
      body.parallel_tool_calls = true;
    }

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${this.config.apiKey}`,
    };

    const MAX_RETRIES = 3;
    let response!: Response;
    let lastErr: Error | undefined;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        const ctrl = new AbortController();
        const timeout = setTimeout(() => ctrl.abort(), 90_000);
        response = await fetch(endpoint, {
          method: 'POST',
          headers,
          body: JSON.stringify(sanitizeForJSON(body)),
          signal: ctrl.signal,
        });
        clearTimeout(timeout);

        if (response.ok) break;

        const errBody = await response.text();
        const status = response.status;

        if (!isRetryable(status) || attempt === MAX_RETRIES) {
          let msg = `LLM error (${status})`;
          try {
            const parsed = JSON.parse(errBody);
            if (parsed?.error?.message) msg += `: ${parsed.error.message}`;
          } catch {
            if (errBody) msg += `: ${errBody.slice(0, 300)}`;
          }
          yield { type: 'error', error: msg };
          return;
        }

        // Retryable — wait and try again. getRetryDelay's second arg is
        // the Retry-After header (string), not the status code.
        const retryAfter = response.headers.get('Retry-After');
        const delay = getRetryDelay(attempt + 1, retryAfter);
        await sleep(delay);
      } catch (err) {
        lastErr = err as Error;
        if (attempt === MAX_RETRIES) {
          yield { type: 'error', error: `Network error after ${MAX_RETRIES + 1} attempts: ${lastErr.message}` };
          return;
        }
        await sleep(getRetryDelay(attempt + 1));
      }
    }

    let parsed: ResponsesApiBody;
    try {
      parsed = (await response.json()) as ResponsesApiBody;
    } catch (err) {
      yield { type: 'error', error: `Failed to parse Responses API body: ${(err as Error).message}` };
      return;
    }

    if (parsed.error) {
      yield { type: 'error', error: parsed.error.message || 'Unknown Responses API error' };
      return;
    }

    if (parsed.status !== 'completed' && parsed.status !== 'requires_action') {
      yield { type: 'error', error: `Responses API returned status=${parsed.status}` };
      return;
    }

    // Walk the output[] array. Order matters — preserve it.
    for (const item of parsed.output || []) {
      if (item.type === 'reasoning') {
        const summary = Array.isArray(item.summary)
          ? item.summary.map(s => s.text || '').filter(Boolean).join('\n')
          : (typeof item.summary === 'string' ? item.summary : '');
        if (summary) yield { type: 'thinking', text: summary };
      } else if (item.type === 'message') {
        for (const c of item.content || []) {
          if (c.type === 'output_text' && c.text) {
            yield { type: 'text', text: c.text };
          }
        }
      } else if (item.type === 'function_call') {
        // Map to the chat-completions ToolCall shape the agent expects.
        const toolCall = {
          id: item.call_id || item.id || '',
          type: 'function' as const,
          function: {
            name: item.name || '',
            arguments: item.arguments || '{}',
          },
        };
        yield { type: 'tool_call_start', toolCall };
        yield { type: 'tool_call_end', toolCall };
      }
    }

    if (parsed.usage) {
      yield {
        type: 'usage',
        usage: {
          inputTokens: parsed.usage.input_tokens,
          outputTokens: parsed.usage.output_tokens,
          totalTokens: parsed.usage.total_tokens,
          cacheReadTokens: parsed.usage.input_tokens_details?.cached_tokens,
        },
      };
    }

    yield { type: 'done' };
  }

  /**
   * Convert the agent's Message[] history into the Responses API `input` array.
   *
   * Mapping:
   *   {role: 'system' | 'user' | 'assistant', content}      → {role, content}
   *   assistant message with tool_calls                      → flatten into one
   *                                                            function_call item per tool call
   *   {role: 'tool', tool_call_id, content}                  → function_call_output item
   */
  private buildInput(messages: Message[]): ResponsesApiInputItem[] {
    const out: ResponsesApiInputItem[] = [];
    for (const m of messages) {
      if (m.role === 'tool') {
        out.push({
          type: 'function_call_output',
          call_id: m.tool_call_id || '',
          output: typeof m.content === 'string' ? m.content : JSON.stringify(m.content),
        });
        continue;
      }

      if (m.role === 'assistant' && m.tool_calls && m.tool_calls.length > 0) {
        // Some assistant turns include both text content AND tool calls.
        // Emit content first (if any), then each function_call.
        if (m.content && m.content.trim().length > 0) {
          out.push({ role: 'assistant', content: m.content });
        }
        for (const tc of m.tool_calls) {
          out.push({
            type: 'function_call',
            call_id: tc.id,
            name: tc.function.name,
            arguments: tc.function.arguments,
          });
        }
        continue;
      }

      if (m.role === 'system' || m.role === 'user' || m.role === 'assistant') {
        out.push({ role: m.role, content: m.content });
      }
    }
    return out;
  }
}

/**
 * Heuristic: which models should route through the Responses API rather than
 * chat-completions?
 *
 * Verified by direct probe to OpenAI on 2026-04-15: the entire gpt-5.x
 * family answers the Responses API. The chat-completions endpoint also
 * accepts gpt-5.1 / gpt-5-mini / gpt-5-nano but in practice they reason
 * extensively before producing tool calls and frequently exhaust their
 * output budget on reasoning, so 0 tool calls come back. Responses API
 * handles their reasoning + tool-call format natively.
 *
 * Net: we route the entire gpt-5.x family here. The older OpenAIProvider
 * still handles gpt-4o*, gpt-4.1*, o1/o3/o4 (which work fine on chat).
 *
 * Simple prefix check — easier to extend than a registry diff.
 */
export function modelRequiresResponsesApi(model: string): boolean {
  if (!model) return false;
  const m = model.toLowerCase();
  // gpt-5.x — entire family routes here.
  if (m.startsWith('gpt-5')) return true;
  return false;
}
