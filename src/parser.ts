import { ToolCall } from './types';

const KNOWN_TOOLS = ['read_file', 'write_file', 'edit_file', 'execute', 'glob', 'grep', 'git', 'think'];

/**
 * Parse tool calls from LLM text output.
 * Used as fallback when models don't support native tool calling.
 * Tries multiple formats: XML tags, code blocks, function notation.
 */
export function parseToolCalls(text: string): ToolCall[] {
  const calls: ToolCall[] = [];
  let id = 0;

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
