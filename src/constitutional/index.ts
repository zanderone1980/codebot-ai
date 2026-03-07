/**
 * Constitutional AI Safety Layer — Public API
 *
 * Integrates CORD (Counter-Operations & Risk Detection) and VIGIL (Always-On Threat Patrol)
 * into CodeBot's agent pipeline. Provides three scanning points:
 *
 * 1. Input scanning — VIGIL pre-screens user messages for threats
 * 2. Tool gating — CORD evaluates every tool call against 14 constitutional checks
 * 3. Output scanning — VIGIL scans LLM responses for canary leaks and PII
 */

export { CordAdapter } from './adapter';
export {
  ConstitutionalResult,
  ConstitutionalConfig,
  ConstitutionalMetrics,
  ConstitutionalDecisionLog,
  VigilAlert,
  ToolAction,
  CordDecision,
  VigilAlertType,
} from './types';

import { CordAdapter } from './adapter';
import {
  ConstitutionalResult,
  ConstitutionalConfig,
  ConstitutionalMetrics,
  ToolAction,
} from './types';

/** Default config — both CORD and VIGIL enabled */
const DEFAULT_CONFIG: ConstitutionalConfig = {
  enabled: true,
  vigilEnabled: true,
  hardBlockEnabled: true,
};

/**
 * ConstitutionalLayer — high-level API for CodeBot agent integration.
 *
 * Usage:
 *   const layer = new ConstitutionalLayer();
 *   layer.start();
 *
 *   // Before sending user message to LLM:
 *   const inputCheck = layer.scanInput(userMessage);
 *   if (inputCheck.decision === 'BLOCK') { reject... }
 *
 *   // Before executing a tool:
 *   const toolCheck = layer.evaluateAction({ tool: 'execute', args: { command: 'rm -rf /' } });
 *   if (toolCheck.decision === 'BLOCK') { deny... }
 *
 *   // After receiving LLM output:
 *   const outputCheck = layer.scanOutput(llmResponse);
 */
export class ConstitutionalLayer {
  private adapter: CordAdapter;
  private config: ConstitutionalConfig;
  private started = false;

  constructor(config?: Partial<ConstitutionalConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.adapter = new CordAdapter(this.config);
  }

  /** Start the constitutional layer (initializes VIGIL daemon) */
  start(): void {
    if (this.started) return;
    this.adapter.startVigil();
    this.started = true;
  }

  /** Stop the constitutional layer */
  stop(): void {
    if (!this.started) return;
    this.adapter.stopVigil();
    this.started = false;
  }

  /** Whether the layer is currently active */
  isActive(): boolean {
    return this.started;
  }

  /**
   * Scan user input for threats before sending to LLM.
   * Uses VIGIL's input pre-screening (indirect injection, fingerprints, behavioral memory).
   */
  scanInput(text: string, sessionId?: string): ConstitutionalResult {
    if (!this.config.enabled) return this.allowResult();
    return this.adapter.scanInput(text, sessionId || 'default');
  }

  /**
   * Evaluate a tool action through CORD's 14-check constitutional pipeline.
   * Call this after policy check but before execution.
   */
  evaluateAction(action: ToolAction): ConstitutionalResult {
    if (!this.config.enabled) return this.allowResult();
    return this.adapter.evaluateAction(action);
  }

  /**
   * Scan LLM output for canary leaks, PII, and threat patterns.
   * Call this on LLM responses before showing to user.
   */
  scanOutput(text: string): ConstitutionalResult {
    if (!this.config.enabled) return this.allowResult();
    return this.adapter.scanOutput(text);
  }

  /** Get current metrics for dashboard display */
  getMetrics(): ConstitutionalMetrics {
    return this.adapter.getMetrics();
  }

  /** Get the config */
  getConfig(): ConstitutionalConfig {
    return { ...this.config };
  }

  private allowResult(): ConstitutionalResult {
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
