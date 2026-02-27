import * as readline from 'readline';
import { Message, ToolCall, AgentEvent, LLMProvider, ToolSchema } from './types';
import { ToolRegistry } from './tools';
import { parseToolCalls } from './parser';
import { ContextManager } from './context/manager';
import { buildRepoMap } from './context/repo-map';
import { MemoryManager } from './memory';
import { getModelInfo } from './providers/registry';

export class Agent {
  private provider: LLMProvider;
  private tools: ToolRegistry;
  private context: ContextManager;
  private messages: Message[] = [];
  private maxIterations: number;
  private autoApprove: boolean;
  private model: string;
  private askPermission: (tool: string, args: Record<string, unknown>) => Promise<boolean>;
  private onMessage?: (message: Message) => void;

  constructor(opts: {
    provider: LLMProvider;
    model: string;
    maxIterations?: number;
    autoApprove?: boolean;
    askPermission?: (tool: string, args: Record<string, unknown>) => Promise<boolean>;
    onMessage?: (message: Message) => void;
  }) {
    this.provider = opts.provider;
    this.model = opts.model;
    this.tools = new ToolRegistry(process.cwd());
    this.context = new ContextManager(opts.model, opts.provider);
    this.maxIterations = opts.maxIterations || 25;
    this.autoApprove = opts.autoApprove || false;
    this.askPermission = opts.askPermission || defaultAskPermission;
    this.onMessage = opts.onMessage;

    const supportsTools = getModelInfo(opts.model).supportsToolCalling;
    this.messages.push({
      role: 'system',
      content: this.buildSystemPrompt(supportsTools),
    });
  }

  /** Load messages from a previous session for resume */
  loadMessages(messages: Message[]) {
    this.messages = messages;
  }

  async *run(userMessage: string): AsyncGenerator<AgentEvent> {
    const userMsg: Message = { role: 'user', content: userMessage };
    this.messages.push(userMsg);
    this.onMessage?.(userMsg);

    if (!this.context.fitsInBudget(this.messages)) {
      const result = await this.context.compactWithSummary(this.messages);
      this.messages = result.messages;
      yield { type: 'compaction', text: result.summary || 'Context compacted to fit budget.' };
    }

    for (let i = 0; i < this.maxIterations; i++) {
      const supportsTools = getModelInfo(this.model).supportsToolCalling;
      const toolSchemas = supportsTools ? this.tools.getSchemas() : undefined;

      let fullText = '';
      let toolCalls: ToolCall[] = [];

      // Stream LLM response
      for await (const event of this.provider.chat(this.messages, toolSchemas)) {
        switch (event.type) {
          case 'text':
            fullText += event.text || '';
            yield { type: 'text', text: event.text };
            break;
          case 'thinking':
            yield { type: 'thinking', text: event.text };
            break;
          case 'tool_call_end':
            if (event.toolCall) {
              toolCalls.push(event.toolCall as ToolCall);
            }
            break;
          case 'usage':
            yield { type: 'usage', usage: event.usage };
            break;
          case 'error':
            yield { type: 'error', error: event.error };
            return;
        }
      }

      // If no native tool calls, try parsing from text
      if (toolCalls.length === 0 && fullText) {
        toolCalls = parseToolCalls(fullText);
      }

      // Save assistant message
      const assistantMsg: Message = { role: 'assistant', content: fullText };
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls;
      }
      this.messages.push(assistantMsg);
      this.onMessage?.(assistantMsg);

      // No tool calls = conversation turn done
      if (toolCalls.length === 0) {
        yield { type: 'done' };
        return;
      }

      // Execute each tool call
      for (const tc of toolCalls) {
        const toolName = tc.function.name;
        const tool = this.tools.get(toolName);

        if (!tool) {
          const errResult = `Error: Unknown tool "${toolName}"`;
          const toolMsg: Message = { role: 'tool', content: errResult, tool_call_id: tc.id };
          this.messages.push(toolMsg);
          this.onMessage?.(toolMsg);
          yield { type: 'tool_result', toolResult: { name: toolName, result: errResult, is_error: true } };
          continue;
        }

        let args: Record<string, unknown>;
        try {
          args = JSON.parse(tc.function.arguments);
        } catch {
          const errResult = `Error: Invalid JSON arguments for ${toolName}`;
          const toolMsg: Message = { role: 'tool', content: errResult, tool_call_id: tc.id };
          this.messages.push(toolMsg);
          this.onMessage?.(toolMsg);
          yield { type: 'tool_result', toolResult: { name: toolName, result: errResult, is_error: true } };
          continue;
        }

        yield { type: 'tool_call', toolCall: { name: toolName, args } };

        // Permission check
        const needsPermission =
          tool.permission === 'always-ask' ||
          (tool.permission === 'prompt' && !this.autoApprove);

        if (needsPermission) {
          const approved = await this.askPermission(toolName, args);
          if (!approved) {
            const toolMsg: Message = { role: 'tool', content: 'Permission denied by user.', tool_call_id: tc.id };
            this.messages.push(toolMsg);
            this.onMessage?.(toolMsg);
            yield { type: 'tool_result', toolResult: { name: toolName, result: 'Permission denied.' } };
            continue;
          }
        }

        // Execute
        try {
          const output = await tool.execute(args);
          const toolMsg: Message = { role: 'tool', content: output, tool_call_id: tc.id };
          this.messages.push(toolMsg);
          this.onMessage?.(toolMsg);
          yield { type: 'tool_result', toolResult: { name: toolName, result: output } };
        } catch (err: unknown) {
          const errMsg = err instanceof Error ? err.message : String(err);
          const toolMsg: Message = { role: 'tool', content: `Error: ${errMsg}`, tool_call_id: tc.id };
          this.messages.push(toolMsg);
          this.onMessage?.(toolMsg);
          yield { type: 'tool_result', toolResult: { name: toolName, result: errMsg, is_error: true } };
        }
      }

      // Compact after tool results if needed
      if (!this.context.fitsInBudget(this.messages)) {
        const result = await this.context.compactWithSummary(this.messages);
        this.messages = result.messages;
        yield { type: 'compaction', text: result.summary || 'Context compacted.' };
      }
    }

    yield { type: 'error', error: `Max iterations (${this.maxIterations}) reached.` };
  }

  clearHistory() {
    const system = this.messages[0];
    this.messages = system?.role === 'system' ? [system] : [];
  }

  forceCompact(): { before: number; after: number } {
    const before = this.messages.length;
    this.messages = this.context.compact(this.messages, true);
    return { before, after: this.messages.length };
  }

  getMessages(): Message[] {
    return [...this.messages];
  }

  private buildSystemPrompt(supportsTools: boolean): string {
    let repoMap = '';
    try {
      repoMap = buildRepoMap(process.cwd());
    } catch {
      repoMap = 'Project structure: (unable to scan)';
    }

    // Load persistent memory
    let memoryBlock = '';
    try {
      const memory = new MemoryManager(process.cwd());
      memoryBlock = memory.getContextBlock();
    } catch {
      // memory unavailable
    }

    let prompt = `You are CodeBot, an AI coding assistant. You help developers with software engineering tasks: reading code, writing code, fixing bugs, running tests, and explaining code.

Rules:
- Always read files before editing them.
- Prefer editing over rewriting entire files.
- Be concise and direct.
- Explain what you're doing and why.
- Use the memory tool to save important context, user preferences, and patterns you learn. Memory persists across sessions.

${repoMap}${memoryBlock}`;

    if (!supportsTools) {
      prompt += `

To use tools, wrap calls in XML tags:
<tool_call>{"name": "tool_name", "arguments": {"arg1": "value1"}}</tool_call>

Available tools:
${this.tools.all().map(t => `- ${t.name}: ${t.description}`).join('\n')}`;
    }

    return prompt;
  }
}

async function defaultAskPermission(tool: string, args: Record<string, unknown>): Promise<boolean> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const summary = Object.entries(args)
    .map(([k, v]) => {
      const val = typeof v === 'string' ? (v.length > 80 ? v.substring(0, 80) + '...' : v) : JSON.stringify(v);
      return `  ${k}: ${val}`;
    })
    .join('\n');

  return new Promise(resolve => {
    rl.question(`\n⚡ ${tool}\n${summary}\nAllow? [y/N] `, answer => {
      rl.close();
      resolve(answer.toLowerCase().startsWith('y'));
    });
  });
}
