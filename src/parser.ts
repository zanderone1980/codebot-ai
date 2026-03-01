import { ToolCall } from './types';

const KNOWN_TOOLS = ['read_file', 'write_file', 'edit_file', 'execute', 'glob', 'grep', 'git', 'think'];

/**
 * Build a JSON schema for structured tool calling output.
 * Used with OpenAI/Gemini response_format when the model supports JSON mode
 * but native tool calling is unreliable or unavailable.
 */
export function buildToolCallSchema(toolNames: string[]): Record<string, unknown> {
  return {
    type: 'json_schema',
    json_schema: {
      name: 'tool_calls',
      strict: true,
      schema: {
        type: 'object',
        properties: {
          thinking: {
            type: 'string',
            description: 'Brief reasoning about what to do next',
          },
          text: {
            type: 'string',
            description: 'Text response to show the user (can be empty)',
          },
          tool_calls: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                name: {
                  type: 'string',
                  enum: toolNames,
                  description: 'Tool to call',
                },
                arguments: {
                  type: 'object',
                  description: 'Tool arguments as key-value pairs',
                },
              },
              required: ['name', 'arguments'],
            },
            description: 'Tools to call (empty array if no tools needed)',
          },
        },
        required: ['text', 'tool_calls'],
        additionalProperties: false,
      },
    },
  };
}

/**
 * Parse tool calls from a JSON-mode structured response.
 * Expects the format: { text: "...", tool_calls: [{ name: "...", arguments: {...} }] }
 */
export function parseJsonModeResponse(text: string): { text: string; toolCalls: ToolCall[] } {
  try {
    // Try to extract JSON from the response (might have text before/after)
    const jsonMatch = text.match(/\{[\s\S]*"tool_calls"[\s\S]*\}/);
    if (!jsonMatch) return { text, toolCalls: [] };

    const parsed = JSON.parse(jsonMatch[0]);
    const responseText = parsed.text || '';
    const toolCalls: ToolCall[] = [];

    if (Array.isArray(parsed.tool_calls)) {
      for (let i = 0; i < parsed.tool_calls.length; i++) {
        const tc = parsed.tool_calls[i];
        if (tc.name) {
          toolCalls.push({
            id: `call_${i}`,
            type: 'function',
            function: {
              name: tc.name,
              arguments: JSON.stringify(tc.arguments || {}),
            },
          });
        }
      }
    }

    return { text: responseText, toolCalls };
  } catch {
    return { text, toolCalls: [] };
  }
}

/**
 * Parse tool calls from LLM text output.
 * Used as fallback when models don't support native tool calling.
 * Tries multiple formats: JSON mode, XML tags, code blocks, function notation.
 */
export function parseToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  let id = 0;

  // Pattern 0: JSON-mode structured output (v2.1.6)
  // { "text": "...", "tool_calls": [{ "name": "...", "arguments": {...} }] }
  const jsonResult = parseJsonModeResponse(text);
  if (jsonResult.toolCalls.length > 0) return jsonResult.toolCalls;

  // Pattern 1: <tool_call>{"name": "...", "arguments": {...}}</tool_call>
  const xmlPattern = /<tool_call>\s*([\s\S]*?)\s*<\/tool_call>/g;
  let match;

  while ((match = xmlPattern.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.name) {
        calls.push({
          id: `call_${id++}`,
          type: 'function',
          function: {
            name: parsed.name,
            arguments: JSON.stringify(parsed.arguments || parsed.params || {}),
          },
        });
      }
    } catch {
      // skip malformed
    }
  }

  if (calls.length > 0) return calls;

  // Pattern 2: ```tool_call\n{...}\n``` or ```json\n{...}\n```
  const codeBlockPattern = /```(?:tool_call|json)?\s*\n\s*(\{[\s\S]*?\})\s*\n\s*```/g;
  while ((match = codeBlockPattern.exec(text)) !== null) {
    try {
      const parsed = JSON.parse(match[1]);
      if (parsed.name && (parsed.arguments || parsed.params)) {
        calls.push({
          id: `call_${id++}`,
          type: 'function',
          function: {
            name: parsed.name,
            arguments: JSON.stringify(parsed.arguments || parsed.params || {}),
          },
        });
      }
    } catch {
      // skip malformed
    }
  }

  if (calls.length > 0) return calls;

  // Pattern 3: tool_name({"arg": "value"})
  const toolNames = KNOWN_TOOLS.join('|');
  const funcPattern = new RegExp(`\\b(${toolNames})\\s*\\(\\s*(\\{[\\s\\S]*?\\})\\s*\\)`, 'g');
  while ((match = funcPattern.exec(text)) !== null) {
    try {
      const args = JSON.parse(match[2]);
      calls.push({
        id: `call_${id++}`,
        type: 'function',
        function: {
          name: match[1],
          arguments: JSON.stringify(args),
        },
      });
    } catch {
      // skip malformed
    }
  }

  return calls;
}
