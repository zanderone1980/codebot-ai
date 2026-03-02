/**
 * Token & Cost Tracking for CodeBot v1.7.0
 *
 * Tracks per-request and per-session token usage and estimated costs.
 * Supports cost limits and historical usage queries.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// ── Pricing (per 1M tokens, in USD) ──

interface ModelPricing {
  input: number;   // per 1M input tokens
  output: number;  // per 1M output tokens
}

const PRICING: Record<string, ModelPricing> = {
  // Anthropic
  'claude-opus-4-6':       { input: 15.0,  output: 75.0 },
  'claude-sonnet-4-20250514':     { input: 3.0,   output: 15.0 },
  'claude-haiku-3-5':      { input: 0.80,  output: 4.0 },
  // OpenAI
  'gpt-4o':                { input: 2.50,  output: 10.0 },
  'gpt-4o-mini':           { input: 0.15,  output: 0.60 },
  'gpt-4.1':               { input: 2.0,   output: 8.0 },
  'gpt-4.1-mini':          { input: 0.40,  output: 1.60 },
  'gpt-4.1-nano':          { input: 0.10,  output: 0.40 },
  'o1':                    { input: 15.0,  output: 60.0 },
  'o3':                    { input: 10.0,  output: 40.0 },
  'o3-mini':               { input: 1.10,  output: 4.40 },
  'o4-mini':               { input: 1.10,  output: 4.40 },
  // Google
  'gemini-2.5-pro':        { input: 1.25,  output: 10.0 },
  'gemini-2.5-flash':      { input: 0.15,  output: 0.60 },
  'gemini-2.0-flash':      { input: 0.10,  output: 0.40 },
  // DeepSeek
  'deepseek-chat':         { input: 0.14,  output: 0.28 },
  'deepseek-reasoner':     { input: 0.55,  output: 2.19 },
  // Groq (free tier pricing)
  'llama-3.3-70b-versatile': { input: 0.59, output: 0.79 },
  // Mistral
  'mistral-large-latest':  { input: 2.0,   output: 6.0 },
  'codestral-latest':      { input: 0.30,  output: 0.90 },
  // xAI
  'grok-3':                { input: 3.0,   output: 15.0 },
  'grok-3-mini':           { input: 0.30,  output: 0.50 },
};

// Default pricing for unknown models (conservative estimate)
const DEFAULT_PRICING: ModelPricing = { input: 2.0, output: 8.0 };
// Free pricing for local models
const LOCAL_PRICING: ModelPricing = { input: 0, output: 0 };

// ── Token Tracker ──

export interface UsageRecord {
  timestamp: string;
  model: string;
  provider: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
}

export interface SessionSummary {
  sessionId: string;
  model: string;
  provider: string;
  startTime: string;
  endTime: string;
  totalInputTokens: number;
  totalOutputTokens: number;
  totalCostUsd: number;
  requestCount: number;
  toolCalls: number;
  filesModified: number;
}

export class TokenTracker {
  private model: string;
  private provider: string;
  private sessionId: string;
  private records: UsageRecord[] = [];
  private toolCallCount: number = 0;
  private filesModifiedSet: Set<string> = new Set();
  private startTime: string;
  private costLimitUsd: number = 0;

  constructor(model: string, provider: string, sessionId?: string) {
    this.model = model;
    this.provider = provider;
    this.sessionId = sessionId || `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    this.startTime = new Date().toISOString();
  }

  /** Set cost limit in USD. 0 = no limit. */
  setCostLimit(usd: number): void {
    this.costLimitUsd = usd;
  }

  /** Record token usage from an LLM request */
  recordUsage(inputTokens: number, outputTokens: number): UsageRecord {
    const pricing = this.getPricing();
    const costUsd = (inputTokens * pricing.input + outputTokens * pricing.output) / 1_000_000;

    const record: UsageRecord = {
      timestamp: new Date().toISOString(),
      model: this.model,
      provider: this.provider,
      inputTokens,
      outputTokens,
      costUsd,
    };

    this.records.push(record);
    return record;
  }

  /** Record a tool call (for summary) */
  recordToolCall(): void {
    this.toolCallCount++;
  }

  /** Record a file modification (for summary) */
  recordFileModified(filePath: string): void {
    this.filesModifiedSet.add(filePath);
  }

  /** Check if cost limit has been exceeded */
  isOverBudget(): boolean {
    if (this.costLimitUsd <= 0) return false;
    return this.getTotalCost() >= this.costLimitUsd;
  }

  /** Get remaining budget in USD (Infinity if no limit) */
  getRemainingBudget(): number {
    if (this.costLimitUsd <= 0) return Infinity;
    return Math.max(0, this.costLimitUsd - this.getTotalCost());
  }

  // ── Aggregates ──

  getTotalInputTokens(): number {
    return this.records.reduce((sum, r) => sum + r.inputTokens, 0);
  }

  getTotalOutputTokens(): number {
    return this.records.reduce((sum, r) => sum + r.outputTokens, 0);
  }

  getTotalCost(): number {
    return this.records.reduce((sum, r) => sum + r.costUsd, 0);
  }

  getRequestCount(): number {
    return this.records.length;
  }

  /** Generate a session summary */
  getSummary(): SessionSummary {
    return {
      sessionId: this.sessionId,
      model: this.model,
      provider: this.provider,
      startTime: this.startTime,
      endTime: new Date().toISOString(),
      totalInputTokens: this.getTotalInputTokens(),
      totalOutputTokens: this.getTotalOutputTokens(),
      totalCostUsd: this.getTotalCost(),
      requestCount: this.getRequestCount(),
      toolCalls: this.toolCallCount,
      filesModified: this.filesModifiedSet.size,
    };
  }

  /** Format cost for display */
  formatCost(): string {
    const cost = this.getTotalCost();
    if (cost === 0) return 'free (local model)';
    if (cost < 0.01) return `< $0.01`;
    return `$${cost.toFixed(4)}`;
  }

  /** Format a compact status line for CLI */
  formatStatusLine(): string {
    const inTk = this.getTotalInputTokens();
    const outTk = this.getTotalOutputTokens();
    const cost = this.formatCost();
    return `${inTk.toLocaleString()} in / ${outTk.toLocaleString()} out | ${cost}`;
  }

  /** Save session usage to ~/.codebot/usage/ for historical tracking */
  saveUsage(): void {
    try {
      const usageDir = path.join(os.homedir(), '.codebot', 'usage');
      fs.mkdirSync(usageDir, { recursive: true });

      const summary = this.getSummary();
      const fileName = `usage-${summary.startTime.split('T')[0]}.jsonl`;
      const filePath = path.join(usageDir, fileName);

      fs.appendFileSync(filePath, JSON.stringify(summary) + '\n', 'utf-8');
    } catch {
      // Usage tracking failures are non-fatal
    }
  }

  /**
   * Load historical usage from ~/.codebot/usage/
   */
  static loadHistory(days?: number): SessionSummary[] {
    const summaries: SessionSummary[] = [];
    try {
      const usageDir = path.join(os.homedir(), '.codebot', 'usage');
      if (!fs.existsSync(usageDir)) return [];

      const files = fs.readdirSync(usageDir)
        .filter(f => f.startsWith('usage-') && f.endsWith('.jsonl'))
        .sort();

      // Filter by date range if specified
      const cutoff = days
        ? new Date(Date.now() - days * 24 * 60 * 60 * 1000).toISOString()
        : undefined;

      for (const file of files) {
        const content = fs.readFileSync(path.join(usageDir, file), 'utf-8');
        for (const line of content.split('\n')) {
          if (!line.trim()) continue;
          try {
            const summary = JSON.parse(line) as SessionSummary;
            if (cutoff && summary.startTime < cutoff) continue;
            summaries.push(summary);
          } catch { /* skip malformed */ }
        }
      }
    } catch {
      // Can't read usage
    }
    return summaries;
  }

  /**
   * Format a historical usage report.
   */
  static formatUsageReport(days: number = 30): string {
    const history = TokenTracker.loadHistory(days);
    if (history.length === 0) return 'No usage data found.';

    let totalInput = 0;
    let totalOutput = 0;
    let totalCost = 0;
    let totalRequests = 0;
    let totalTools = 0;

    for (const s of history) {
      totalInput += s.totalInputTokens;
      totalOutput += s.totalOutputTokens;
      totalCost += s.totalCostUsd;
      totalRequests += s.requestCount;
      totalTools += s.toolCalls;
    }

    const lines = [
      `Usage Report (last ${days} days)`,
      '─'.repeat(40),
      `Sessions:     ${history.length}`,
      `LLM Requests: ${totalRequests.toLocaleString()}`,
      `Tool Calls:   ${totalTools.toLocaleString()}`,
      `Input Tokens: ${totalInput.toLocaleString()}`,
      `Output Tokens: ${totalOutput.toLocaleString()}`,
      `Total Cost:   $${totalCost.toFixed(4)}`,
    ];

    return lines.join('\n');
  }

  // ── Helpers ──

  private getPricing(): ModelPricing {
    // Local models are free
    if (this.isLocalModel()) return LOCAL_PRICING;

    // Exact match
    if (PRICING[this.model]) return PRICING[this.model];

    // Prefix match (for versioned models like claude-sonnet-4-20250514)
    for (const [key, pricing] of Object.entries(PRICING)) {
      if (this.model.startsWith(key)) return pricing;
    }

    return DEFAULT_PRICING;
  }

  private isLocalModel(): boolean {
    // Models running on Ollama, LM Studio, vLLM are free
    return !this.provider ||
      this.provider === 'ollama' ||
      this.provider === 'lmstudio' ||
      this.provider === 'vllm' ||
      this.provider === 'local';
  }
}


// ── Cost Estimation (v2.2.0) ──

export interface CostEstimate {
  estimatedInputTokens: number;
  estimatedOutputTokens: number;
  estimatedCost: number;
  estimatedToolCalls: number;
  estimatedIterations: number;
  confidence: 'low' | 'medium' | 'high';
}

/** Estimate the cost of running a task before execution. */
export function estimateRunCost(taskDescription: string, model: string, provider?: string): CostEstimate {
  // Heuristic: classify task complexity by word count
  const words = taskDescription.trim().split(/\s+/).length;

  let iterations: number;
  let toolCalls: number;
  let confidence: 'low' | 'medium' | 'high';

  if (words < 20) {
    // Simple task: "fix the typo in index.ts"
    iterations = 3;
    toolCalls = 5;
    confidence = 'high';
  } else if (words < 50) {
    // Medium task: "refactor the auth module to use JWT"
    iterations = 8;
    toolCalls = 15;
    confidence = 'medium';
  } else {
    // Complex task: long description with many requirements
    iterations = 15;
    toolCalls = 30;
    confidence = 'low';
  }

  // Estimate tokens per iteration (system prompt ~2k, response ~1k avg)
  const inputPerIteration = 3000;
  const outputPerIteration = 1200;
  const estimatedInputTokens = iterations * inputPerIteration;
  const estimatedOutputTokens = iterations * outputPerIteration;

  // Look up pricing
  const pricing = getModelPricing(model, provider);
  const estimatedCost = (estimatedInputTokens * pricing.input + estimatedOutputTokens * pricing.output) / 1_000_000;

  return {
    estimatedInputTokens,
    estimatedOutputTokens,
    estimatedCost,
    estimatedToolCalls: toolCalls,
    estimatedIterations: iterations,
    confidence,
  };
}

/** Get pricing for a model (reuses PRICING table from TokenTracker). */
function getModelPricing(model: string, provider?: string): { input: number; output: number } {
  // Local models are free
  if (!provider || provider === 'ollama' || provider === 'lmstudio' || provider === 'vllm' || provider === 'local') {
    return { input: 0, output: 0 };
  }
  // Exact match
  if (PRICING[model]) return PRICING[model];
  // Prefix match
  for (const [key, pricing] of Object.entries(PRICING)) {
    if (model.startsWith(key)) return pricing;
  }
  return DEFAULT_PRICING;
}
