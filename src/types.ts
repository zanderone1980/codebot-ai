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
  /**
   * Optional per-call capability resolver (PR 11).
   *
   * For tools that dispatch to multiple sub-actions with different real
   * capability profiles (e.g. the `app` tool: a `github.list_prs` is
   * pure read-only, but `github.create_issue` is `send-on-behalf`), the
   * static `capabilities` field must list the union — which over-gates
   * everything. This method lets such tools resolve the real, narrower
   * label set from `args` so the agent gate can score the actual call
   * instead of the worst case.
   *
   * Contract:
   *   - Returns `undefined` → caller falls back to `capabilities`.
   *   - Returns a `CapabilityLabel[]` → caller uses that exact list.
   *   - MUST be pure: no I/O, no auth checks, no side effects.
   *   - Must NEVER weaken below the action's real label set; if the
   *     resolution is ambiguous, return `undefined` to fall back to the
   *     conservative union.
   */
  effectiveCapabilities?(args: Record<string, unknown>): CapabilityLabel[] | undefined;
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

/**
 * PR 6 — Inline shape of `BudgetConfig` from `./setup`. Same dep-arrow
 * reasoning as `ConfigRouterShape` above.
 */
export interface ConfigBudgetShape {
  perSessionCapUsd: number;
  warnThresholds?: number[];
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
  /** Optional budget config (PR 6). Absent or `perSessionCapUsd:0` → no user cap. */
  budget?: ConfigBudgetShape;
  /**
   * PR 11 — capability labels the user has explicitly allowlisted for
   * this session via `--allow-capability`. Empty / undefined ⇒ no
   * capability is bypassable, the §7 invariant remains: every
   * capability-driven gate prompts. Validated at agent boot via
   * `parseAllowCapabilityFlag` so unknown / never-allowable labels
   * fail fast.
   */
  allowedCapabilities?: ReadonlySet<CapabilityLabel>;
  /**
   * When true, the constitutional safety layer (CORD + VIGIL) is not
   * initialized. Set by the `--no-constitutional` CLI flag. The flag
   * was previously parsed but never read — fixed 2026-04-29 so the
   * documented escape hatch actually disables the layer.
   */
  disableConstitutional?: boolean;
}
