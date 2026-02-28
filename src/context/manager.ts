import { Message, LLMProvider } from '../types';
import { getModelInfo } from '../providers/registry';

export class ContextManager {
  private contextWindow: number;
  private reservedForOutput = 2048;
  private reservedForSystem = 1500;
  private reservedForTools = 2000;
  private provider?: LLMProvider;

  constructor(model: string, provider?: LLMProvider) {
    this.contextWindow = getModelInfo(model).contextWindow;
    this.provider = provider;
  }

  /** Set the provider (for LLM-powered compaction) */
  setProvider(provider: LLMProvider) {
    this.provider = provider;
  }

  /** Conservative token estimate: ~3.5 chars per token */
  estimateTokens(text: string): number {
    return Math.ceil(text.length / 3.5);
  }

  /** Tokens available for conversation messages */
  availableTokens(): number {
    return this.contextWindow - this.reservedForOutput - this.reservedForSystem - this.reservedForTools;
  }

  /** Check if messages fit within budget */
  fitsInBudget(messages: Message[]): boolean {
    const total = messages.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);
    return total <= this.availableTokens();
  }

  /**
   * Group messages into atomic blocks that must never be split.
   * An assistant message with tool_calls + its following tool responses = one block.
   * All other messages are individual blocks.
   * This prevents compaction from creating orphaned tool messages.
   */
  private groupMessages(messages: Message[]): Message[][] {
    const groups: Message[][] = [];
    let i = 0;

    while (i < messages.length) {
      const msg = messages[i];

      if (msg.role === 'assistant' && msg.tool_calls?.length) {
        // Start of a tool_call group — keep assistant + all following tool messages together
        const group: Message[] = [msg];
        i++;
        while (i < messages.length && messages[i].role === 'tool') {
          group.push(messages[i]);
          i++;
        }
        groups.push(group);
      } else {
        groups.push([msg]);
        i++;
      }
    }

    return groups;
  }

  /** Compact conversation by dropping old messages. Never splits tool_call groups. */
  compact(messages: Message[], force = false): Message[] {
    if (!force && this.fitsInBudget(messages)) return messages;

    const system = messages[0]?.role === 'system' ? messages[0] : null;
    const rest = system ? messages.slice(1) : [...messages];

    // Group messages into atomic blocks (assistant + tool responses stay together)
    const groups = this.groupMessages(rest);

    // Keep recent groups that fit within 80% of budget
    const keptGroups: Message[][] = [];
    let tokenCount = 0;
    const budget = this.availableTokens();

    for (let i = groups.length - 1; i >= 0; i--) {
      const group = groups[i];
      const groupTokens = group.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);
      if (tokenCount + groupTokens > budget * 0.8) break;
      keptGroups.unshift(group);
      tokenCount += groupTokens;
    }

    const kept = keptGroups.flat();
    const dropped = rest.length - kept.length;
    if (dropped > 0) {
      kept.unshift({
        role: 'system',
        content: `[${dropped} earlier messages compacted. The conversation has been ongoing — continue from the recent messages below.]`,
      });
    }

    if (system) kept.unshift(system);
    return kept;
  }

  /** Smart compaction: use LLM to summarize dropped messages. Never splits tool_call groups. */
  async compactWithSummary(messages: Message[]): Promise<{ messages: Message[]; summary: string }> {
    const system = messages[0]?.role === 'system' ? messages[0] : null;
    const rest = system ? messages.slice(1) : [...messages];

    // Group messages into atomic blocks
    const groups = this.groupMessages(rest);

    // Keep recent groups that fit within 80% of budget
    const keptGroups: Message[][] = [];
    let tokenCount = 0;
    const budget = this.availableTokens();

    for (let i = groups.length - 1; i >= 0; i--) {
      const group = groups[i];
      const groupTokens = group.reduce((sum, m) => sum + this.estimateTokens(m.content), 0);
      if (tokenCount + groupTokens > budget * 0.8) break;
      keptGroups.unshift(group);
      tokenCount += groupTokens;
    }

    const kept = keptGroups.flat();
    const droppedCount = rest.length - kept.length;
    if (droppedCount === 0) {
      return { messages, summary: '' };
    }

    const dropped = rest.slice(0, droppedCount);
    let summary = `[${droppedCount} earlier messages compacted.]`;

    // Try LLM summarization
    if (this.provider) {
      try {
        summary = await this.summarizeMessages(dropped);
      } catch {
        // Fall back to simple compaction
      }
    }

    kept.unshift({ role: 'system', content: summary });
    if (system) kept.unshift(system);

    return { messages: kept, summary };
  }

  private async summarizeMessages(messages: Message[]): Promise<string> {
    if (!this.provider) {
      throw new Error('No provider for summarization');
    }

    // Build a condensed version of the conversation for summarization
    const convoText = messages
      .filter(m => m.role !== 'system')
      .map(m => {
        if (m.role === 'tool') {
          const result = m.content.length > 200 ? m.content.substring(0, 200) + '...' : m.content;
          return `[Tool result]: ${result}`;
        }
        if (m.role === 'assistant' && m.tool_calls?.length) {
          const tools = m.tool_calls.map(tc => tc.function.name).join(', ');
          const text = m.content ? m.content.substring(0, 200) : '';
          return `Assistant: ${text}\n[Used tools: ${tools}]`;
        }
        return `${m.role === 'user' ? 'User' : 'Assistant'}: ${m.content.substring(0, 500)}`;
      })
      .join('\n');

    // Keep summary request short to minimize cost
    const summaryPrompt: Message[] = [
      {
        role: 'system',
        content: 'Summarize this conversation excerpt in 2-4 sentences. Focus on: what was discussed, what actions were taken, what was decided, and any important context for continuing the conversation. Be specific about file names, functions, and technical details.',
      },
      { role: 'user', content: convoText },
    ];

    let summaryText = '';
    for await (const event of this.provider.chat(summaryPrompt)) {
      if (event.type === 'text' && event.text) {
        summaryText += event.text;
      }
    }

    if (!summaryText.trim()) {
      return `[${messages.length} earlier messages compacted.]`;
    }

    return `[Conversation summary: ${summaryText.trim()}]`;
  }

  getContextWindow(): number {
    return this.contextWindow;
  }
}
