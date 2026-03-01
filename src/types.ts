export interface ImageAttachment {
  data: string;        // base64-encoded image data
  mediaType: 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp';
}

export interface Message {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
  images?: ImageAttachment[];
  tool_calls?: ToolCall[];
  tool_call_id?: string;
  name?: string;
}

export interface ToolCall {
  id: string;
  type: 'function';
  function: {
    name: string;
    arguments: string;
  };
}

export interface ToolResult {
  tool_call_id: string;
  content: string;
  is_error?: boolean;
}

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  permission: 'auto' | 'prompt' | 'always-ask';
  cacheable?: boolean;
  execute(args: Record<string, unknown>): Promise<string>;
}

export interface ProviderConfig {
  baseUrl: string;
  apiKey?: string;
  model: string;
}

export interface LLMProvider {
  name: string;
  temperature?: number;
  chat(messages: Message[], tools?: ToolSchema[]): AsyncGenerator<StreamEvent>;
  listModels?(): Promise<string[]>;
}

export interface ToolSchema {
  type: 'function';
  function: {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
  };
}

export interface StreamEvent {
  type: 'text' | 'thinking' | 'tool_call_start' | 'tool_call_delta' | 'tool_call_end' | 'usage' | 'done' | 'error';
  text?: string;
  toolCall?: Partial<ToolCall>;
  error?: string;
  usage?: UsageStats;
}

export interface UsageStats {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  cacheCreationTokens?: number;
  cacheReadTokens?: number;
}

export interface AgentEvent {
  type: 'thinking' | 'text' | 'tool_call' | 'tool_result' | 'done' | 'error' | 'compaction' | 'usage';
  text?: string;
  toolCall?: { name: string; args: Record<string, unknown> };
  toolResult?: { name: string; result: string; is_error?: boolean };
  error?: string;
  usage?: UsageStats;
  risk?: { score: number; level: string };
}

export interface Config {
  provider: string;
  model: string;
  baseUrl: string;
  apiKey?: string;
  maxIterations: number;
  autoApprove: boolean;
  contextBudget?: number;
  projectRoot?: string;
}
