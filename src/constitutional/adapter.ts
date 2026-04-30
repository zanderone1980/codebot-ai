/**
 * Constitutional AI Adapter — Bridge between cord-engine (JS) and CodeBot (TS)
 *
 * Wraps CORD evaluate() and VIGIL scan/scanInput/scanOutput with TypeScript types.
 * Maps CORD decisions to CodeBot risk levels.
 */

import {
  ConstitutionalResult,
  ConstitutionalConfig,
  ConstitutionalMetrics,
  ConstitutionalDecisionLog,
  VigilAlert,
  ToolAction,
  CordDecision,
} from './types';
import { isProjectSourceFile, redactSafeSourcePaths } from './path-safelist';

// Import cord-engine (JavaScript) via require
 
const cord = require('cord-engine');

/** Maximum recent decisions to keep for dashboard display */
const MAX_RECENT_DECISIONS = 100;

/** Map CORD tool names to CodeBot tool names */
const TOOL_TYPE_MAP: Record<string, string> = {
  execute: 'exec',
  write_file: 'write',
  edit_file: 'edit',
  batch_edit: 'edit',
  read_file: 'read',
  browser: 'browser',
  web_fetch: 'network',
  http_client: 'network',
  web_search: 'network',
  git: 'exec',
  docker: 'exec',
  ssh_remote: 'exec',
  notification: 'message',
  database: 'exec',
};

/**
 * Adapt a CORD evaluation result to the CodeBot ConstitutionalResult format.
 */
function adaptCordResult(cordResult: Record<string, unknown>): ConstitutionalResult {
  const decision = (cordResult.decision as string || 'ALLOW').toUpperCase() as CordDecision;
  const score = typeof cordResult.score === 'number' ? cordResult.score : 0;

  // Extract dimension scores from risks array
  const dimensions: Record<string, number> = {};
  const risks = cordResult.risks as Array<Record<string, unknown>> | undefined;
  if (Array.isArray(risks)) {
    for (const risk of risks) {
      const name = risk.dimension as string || risk.name as string || 'unknown';
      const riskScore = typeof risk.score === 'number' ? risk.score : 0;
      dimensions[name] = riskScore;
    }
  }

  // Extract explanation
  const explanation = cordResult.explanation as Record<string, unknown> | undefined;
  const summary = explanation?.summary as string || cordResult.summary as string || '';

  // Detect hard blocks
  const hardBlock = cordResult.hardBlock === true;
  const hardBlockReason = hardBlock
    ? (cordResult.hardBlockReason as string || (cordResult.reasons as string[])?.join('; ') || 'Constitutional violation')
    : undefined;

  return {
    decision,
    score,
    hardBlock,
    hardBlockReason,
    dimensions,
    explanation: summary,
    vigilAlerts: [],
  };
}

/**
 * Adapt a VIGIL scan result to VigilAlert array.
 */
function adaptVigilAlerts(vigilResult: Record<string, unknown>): VigilAlert[] {
  const alerts: VigilAlert[] = [];
  const threats = vigilResult.threats as Array<Record<string, unknown>> | undefined;

  if (Array.isArray(threats)) {
    for (const threat of threats) {
      alerts.push({
        type: (threat.category === 'canary' ? 'canary' : 'pattern') as VigilAlert['type'],
        severity: typeof threat.severity === 'number' ? threat.severity : 5,
        message: threat.description as string || threat.pattern as string || 'Threat detected',
        category: threat.category as string || 'unknown',
      });
    }
  }

  // Memory escalation alert
  if (vigilResult.escalatedBy === 'memory') {
    alerts.push({
      type: 'memory',
      severity: 7,
      message: vigilResult.summary as string || 'Behavioral escalation detected',
      category: 'behavioral',
    });
  }

  return alerts;
}

/**
 * CordAdapter — low-level adapter wrapping cord-engine's JavaScript API.
 */
export class CordAdapter {
  private vigil: Record<string, unknown> | null = null;
  private config: ConstitutionalConfig;
  private metrics: ConstitutionalMetrics;
  private recentDecisions: ConstitutionalDecisionLog[] = [];

  constructor(config: ConstitutionalConfig) {
    this.config = config;
    this.metrics = {
      totalEvaluations: 0,
      decisions: { ALLOW: 0, CONTAIN: 0, CHALLENGE: 0, BLOCK: 0 },
      hardBlocks: 0,
      vigilScans: 0,
      vigilBlocks: 0,
      canariesPlanted: 0,
      canariesTriggered: 0,
      escalations: 0,
      recentDecisions: [],
    };
  }

  /** Start VIGIL daemon if enabled */
  startVigil(): void {
    if (!this.config.vigilEnabled) return;
    try {
      if (cord.vigil) {
        this.vigil = cord.vigil as Record<string, unknown>;
        const start = this.vigil.start as () => void;
        start.call(this.vigil);
      }
    } catch {
      // VIGIL not available — continue without it
      this.vigil = null;
    }
  }

  /** Stop VIGIL daemon */
  stopVigil(): void {
    if (this.vigil) {
      try {
        const stop = this.vigil.stop as () => void;
        stop.call(this.vigil);
      } catch { /* ignore */ }
      this.vigil = null;
    }
  }

  /**
   * Evaluate a tool action through CORD's constitutional pipeline.
   */
  evaluateAction(action: ToolAction): ConstitutionalResult {
    const toolType = TOOL_TYPE_MAP[action.tool] || action.type || 'unknown';

    // Memory writes contain project documentation that triggers false positives
    // on injection/drift regexes (e.g. "os.homedir()" matches os.system pattern,
    // "override" in architecture docs matches promptInjection pattern).
    // Memory is permission:'auto' (lowest risk) — only evaluate tool name + scope.
    const isMemoryWrite = action.tool === 'memory' && action.args.action === 'write';
    const text = isMemoryWrite
      ? this.buildMemoryProposalText(action)
      : this.buildProposalText(action);

    // PR 15 follow-up — also strip the path from cordInput.path when
    // the file is a safelisted project source file. We initially only
    // redacted the proposal `text`, missing that cord-engine evaluates
    // the structured `path` field independently. The Electron live
    // test on 2026-04-29 surfaced this: even with text redacted,
    // CORD still blocked reads of src/secrets.ts because its path-
    // scanner saw the basename "secrets.ts". Conditional omission
    // mirrors the proposal-text logic so the decision is consistent
    // across both fields.
    const rawPath = (action.args.path as string) || (action.args.file as string) || undefined;
    // Use the agent's projectRoot (threaded through ConstitutionalConfig
    // by Agent's constructor) when present; fall back to process.cwd()
    // via the function default. The Electron dashboard subprocess's
    // cwd differs from the agent's actual working tree, so the explicit
    // projectRoot is what makes the safelist correct in that path.
    const pathForCord = rawPath && isProjectSourceFile(rawPath, this.config.projectRoot) ? undefined : rawPath;
    const cordInput = {
      text,
      toolName: toolType,
      actionType: action.type || toolType,
      path: pathForCord,
      networkTarget: this.extractNetworkTarget(action),
    };

    const rawResult = cord.evaluate(cordInput) as Record<string, unknown>;
    const result = adaptCordResult(rawResult);

    // If hard blocks are disabled, downgrade BLOCK to CHALLENGE
    if (!this.config.hardBlockEnabled && result.hardBlock) {
      result.decision = 'CHALLENGE';
    }

    this.recordDecision(result, action.tool);
    return result;
  }

  /**
   * Scan user input through VIGIL for threats.
   */
  scanInput(text: string, source: string = 'user'): ConstitutionalResult {
    if (!this.vigil) {
      return this.makeAllowResult();
    }

    try {
      const scanInput = this.vigil.scanInput as (text: string, source: string) => Record<string, unknown>;
      const rawResult = scanInput.call(this.vigil, text, source);
      this.metrics.vigilScans++;

      const result = adaptCordResult(rawResult);
      result.vigilAlerts = adaptVigilAlerts(rawResult);

      if (result.decision === 'BLOCK') {
        this.metrics.vigilBlocks++;
      }

      this.recordDecision(result, 'vigil_input');
      return result;
    } catch {
      return this.makeAllowResult();
    }
  }

  /**
   * Scan LLM output through VIGIL for canary leaks and threats.
   */
  scanOutput(text: string): ConstitutionalResult {
    if (!this.vigil) {
      return this.makeAllowResult();
    }

    try {
      const scanOutput = this.vigil.scanOutput as (text: string, context?: string) => Record<string, unknown>;
      const rawResult = scanOutput.call(this.vigil, text, 'agent_output');
      this.metrics.vigilScans++;

      const result = adaptCordResult(rawResult);
      result.vigilAlerts = adaptVigilAlerts(rawResult);

      if (rawResult.canaryTriggered) {
        this.metrics.canariesTriggered++;
        result.vigilAlerts.push({
          type: 'canary',
          severity: 10,
          message: 'Canary token detected in output — possible system prompt extraction',
          category: 'canary',
        });
      }

      if (result.decision === 'BLOCK') {
        this.metrics.vigilBlocks++;
      }

      this.recordDecision(result, 'vigil_output');
      return result;
    } catch {
      return this.makeAllowResult();
    }
  }

  /**
   * Scan text through VIGIL's general threat scanner.
   */
  scan(text: string): ConstitutionalResult {
    if (!this.vigil) {
      return this.makeAllowResult();
    }

    try {
      const scanFn = this.vigil.scan as (text: string) => Record<string, unknown>;
      const rawResult = scanFn.call(this.vigil, text);
      this.metrics.vigilScans++;

      const result = adaptCordResult(rawResult);
      result.vigilAlerts = adaptVigilAlerts(rawResult);

      if (result.decision === 'BLOCK') {
        this.metrics.vigilBlocks++;
      }

      return result;
    } catch {
      return this.makeAllowResult();
    }
  }

  /** Get metrics snapshot */
  getMetrics(): ConstitutionalMetrics {
    return {
      ...this.metrics,
      recentDecisions: [...this.recentDecisions],
    };
  }

  // ── Private helpers ──

  private buildProposalText(action: ToolAction): string {
    const parts = [action.tool];
    if (action.args.command) {
      // Redact safelisted project-source-file tokens from command
      // strings (e.g. `node --test dist/secrets.test.js`) so the
      // exfil/secrets regex doesn't fire on legitimate filenames.
      // Real exfil patterns (curl/upload/etc.) and unrelated tokens
      // pass through untouched.
      parts.push(redactSafeSourcePaths(String(action.args.command)));
    }

    // Project-source-file safelist: reading or editing source files
    // under the project root must not trigger CORD's `regex.secrets`
    // false positive on filenames like `src/secrets.ts` or content
    // that legitimately discusses secret-detection patterns. See
    // path-safelist.ts for the full predicate. Sensitive runtime
    // paths (.env, *.pem, .ssh/*, etc.) are NOT safelisted.
    const filePath = (action.args.path as string) || (action.args.file as string) || '';
    const safeSourceFile = isProjectSourceFile(filePath, this.config.projectRoot);

    if (filePath && !safeSourceFile) {
      parts.push(filePath);
    }
    if (action.args.content && !safeSourceFile) {
      parts.push(String(action.args.content).substring(0, 500));
    }
    if (action.args.url) parts.push(String(action.args.url));
    if (action.args.query) parts.push(String(action.args.query));
    return parts.join(' ');
  }

  /**
   * Build proposal text for memory writes — excludes content body to prevent
   * false positives from project documentation triggering injection/drift patterns.
   * Only includes tool name, action, scope, and file name for CORD evaluation.
   */
  private buildMemoryProposalText(action: ToolAction): string {
    const parts = ['memory'];
    if (action.args.action) parts.push(String(action.args.action));
    if (action.args.scope) parts.push(String(action.args.scope));
    if (action.args.file) parts.push(String(action.args.file));
    return parts.join(' ');
  }

  private extractNetworkTarget(action: ToolAction): string | undefined {
    const url = action.args.url as string;
    if (url) {
      try { return new URL(url).hostname; } catch { /* ignore */ }
    }
    return undefined;
  }

  private recordDecision(result: ConstitutionalResult, tool?: string): void {
    this.metrics.totalEvaluations++;
    this.metrics.decisions[result.decision]++;
    if (result.hardBlock) this.metrics.hardBlocks++;

    const log: ConstitutionalDecisionLog = {
      timestamp: Date.now(),
      decision: result.decision,
      score: result.score,
      hardBlock: result.hardBlock,
      tool,
      explanation: result.explanation,
    };

    this.recentDecisions.push(log);
    if (this.recentDecisions.length > MAX_RECENT_DECISIONS) {
      this.recentDecisions.shift();
    }
  }

  private makeAllowResult(): ConstitutionalResult {
    return {
      decision: 'ALLOW',
      score: 0,
      hardBlock: false,
      dimensions: {},
      explanation: '',
      vigilAlerts: [],
    };
  }
}
