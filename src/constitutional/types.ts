/**
 * Constitutional AI Safety Layer — Type Definitions
 *
 * TypeScript interfaces wrapping CORD (Counter-Operations & Risk Detection)
 * and VIGIL (Always-On Threat Patrol) from the cord-engine package.
 */

/** CORD evaluation decision levels */
export type CordDecision = 'ALLOW' | 'CONTAIN' | 'CHALLENGE' | 'BLOCK';

/** VIGIL alert types */
export type VigilAlertType = 'pattern' | 'canary' | 'behavioral' | 'proactive' | 'memory';

/** Result from CORD constitutional evaluation */
export interface ConstitutionalResult {
  decision: CordDecision;
  score: number;
  hardBlock: boolean;
  hardBlockReason?: string;
  dimensions: Record<string, number>;
  explanation: string;
  vigilAlerts: VigilAlert[];
}

/** Individual VIGIL alert */
export interface VigilAlert {
  type: VigilAlertType;
  severity: number;
  message: string;
  category: string;
}

/** Configuration for the constitutional layer */
export interface ConstitutionalConfig {
  enabled: boolean;
  vigilEnabled: boolean;
  hardBlockEnabled: boolean;
  thresholds?: {
    allow: number;
    contain: number;
    challenge: number;
    block: number;
  };
}

/** Metrics from the constitutional layer */
export interface ConstitutionalMetrics {
  totalEvaluations: number;
  decisions: Record<CordDecision, number>;
  hardBlocks: number;
  vigilScans: number;
  vigilBlocks: number;
  canariesPlanted: number;
  canariesTriggered: number;
  escalations: number;
  recentDecisions: ConstitutionalDecisionLog[];
}

/** A logged constitutional decision for dashboard display */
export interface ConstitutionalDecisionLog {
  timestamp: number;
  decision: CordDecision;
  score: number;
  hardBlock: boolean;
  tool?: string;
  explanation: string;
}

/** Tool action descriptor for CORD evaluation */
export interface ToolAction {
  tool: string;
  args: Record<string, unknown>;
  type?: string;
}
