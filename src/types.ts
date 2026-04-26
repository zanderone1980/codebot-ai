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

/**
 * Optional callbacks for streaming-capable tools. Tools that implement
 * `stream()` emit stdout/stderr chunks through these callbacks instead
 * of buffering. Transport-agnostic by design — an HTTP/SSE bridge lives
 * in the caller, not the tool.
 */
export interface ToolStreamEvents {
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
}

export interface ToolStreamResult {
  exitCode: number;
  stdoutTail: string;
  stderrTail: string;
  timedOut: boolean;
}

/**
 * Capability labels (§7 of `docs/personal-agent-infrastructure.md`).
 *
 * PR 2 — metadata only. The slot exists on `Tool` but no tool declares
 * a value yet, and no code reads it. PR 3 populates labels on each
 * existing tool. PR 4 wires the agent loop to gate on them per §7.
 *
 * Adding labels here is a doc-rot triggering change: any new label or
 * removal of an existing label must be reflected in §7 of the
 * architecture doc in the same PR (§13 doc-rot rule).
 */
export type CapabilityLabel =
  | 'read-only'
  | 'write-fs'
  | 'run-cmd'
  | 'browser-read'
  | 'browser-write'
  | 'net-fetch'
  | 'account-access'
  | 'send-on-behalf'   // always-ask (§7)
  | 'delete-data'      // always-ask (§7)
  | 'spend-money'      // always-ask + preview required (§7)
  | 'move-money';      // PROHIBITED — tools/connectors with this label must not be usable (§7)

export interface Tool {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  permission: 'auto' | 'prompt' | 'always-ask';
  cacheable?: boolean;
  /**
   * Declared capability labels (PR 2: metadata only).
   *
   * Optional during the rollout so existing tools compile without
   * change. PR 3 declares labels on each tool. PR 4 has the agent
   * loop read this and apply per-label gating per §7. Visibility to
   * the model (via `ToolSchema`) is a separate later decision — PR 2
   * does NOT expose this to the LLM.
   */
  capabilities?: CapabilityLabel[];
  execute(args: Record<string, unknown>): Promise<string>;
  /**
   * Optional streaming entry point. Implementers MUST re-run the same
   * preflight/validation as `execute()` inside `stream()` — the caller's
   * gate chain runs first, but the tool must defend itself independently
   * against the "gated, then walked around the fence" pattern.
   */
  stream?(
    args: Record<string, unknown>,
    events: ToolStreamEvents,
    opts?: { timeoutMs?: number },
  ): Promise<ToolStreamResult>;
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
  type: 'thinking' | 'text' | 'tool_call' | 'tool_result' | 'done' | 'error' | 'compaction' | 'usage' | 'stream_progress' | 'spark_state';
  text?: string;
  toolCall?: { name: string; args: Record<string, unknown> };
  toolResult?: { name: string; result: string; is_error?: boolean };
  error?: string;
  usage?: UsageStats;
  risk?: { score: number; level: string };
  streamProgress?: { tokensGenerated: number; tokensPerSecond: number; elapsedMs: number };
  sparkState?: { emotion: any; personality: any };
}

/**
 * Inline shape of `RouterConfig` from `./router`. Repeated here as a
 * structural type so `types.ts` doesn't import from `./router` (which
 * imports nothing — keep the dep arrow one-way). When the router source
 * changes its config shape, this stays in sync via PR-time review and
 * the §13 doc-rot rule.
 */
export interface ConfigRouterShape {
  enabled: boolean;
  fastModel?: string;
  strongModel?: string;
  reasoningModel?: string;
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
  /** Optional router config (PR 5). Absent or `enabled:false` → routing off. */
  router?: ConfigRouterShape;
}
