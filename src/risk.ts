/**
 * RiskScorer for CodeBot v1.9.0
 *
 * Per-tool-call risk assessment using 6-factor weighted scoring (0–100).
 * Factors: tool permission, file path sensitivity, command destructiveness,
 * network access, data volume, cumulative session risk.
 *
 * Levels: green (0–25), yellow (26–50), orange (51–75), red (76+).
 * NEVER throws — risk scoring failures must not crash the agent.
 */

import type { ConstitutionalResult } from './constitutional/types';

// ── Types ──

export interface RiskAssessment {
  score: number;
  level: 'green' | 'yellow' | 'orange' | 'red';
  factors: RiskFactor[];
}

export interface RiskFactor {
  name: string;
  weight: number;
  rawScore: number;   // 0–100 within this factor
  weighted: number;   // rawScore * (weight / 100)
  reason: string;
}

// ── Constants ──

const SENSITIVE_PATH_PATTERNS = [
  /\.env($|\.)/,
  /credentials/i,
  /secrets?\b/i,
  /\.pem$/,
  /\.key$/,
  /\.p12$/,
  /\.pfx$/,
  /id_rsa/,
  /id_ed25519/,
  /\.ssh\//,
  /\/etc\/(passwd|shadow|sudoers)/,
  /\/etc\/ssl/,
  /\/System\//,
  /\/Windows\/System32/,
  /node_modules\//,
  /package-lock\.json$/,
];

const MODERATE_PATH_PATTERNS = [
  /\.config\//,
  /\.gitconfig$/,
  /\.npmrc$/,
  /\.bashrc$/,
  /\.zshrc$/,
  /\.profile$/,
  /tsconfig\.json$/,
  /package\.json$/,
];

const DESTRUCTIVE_COMMANDS = [
  /\brm\s+(-rf|-fr|--recursive)/,
  /\brm\b.*\s+\//,
  /\bchmod\s+[0-7]{3,4}/,
  /\bchown\b/,
  /\bkill\s+-9/,
  /\bkillall\b/,
  /\bpkill\b/,
  /\bdrop\s+(table|database|schema)/i,
  /\btruncate\s+table/i,
  /\bdelete\s+from/i,
  /\bgit\s+push\s+.*--force/,
  /\bgit\s+reset\s+--hard/,
  /\bgit\s+clean\s+-fd/,
  /\bformat\s+[a-z]:/i,
  /\bmkfs\b/,
  /\bdd\s+if=/,
  />\s*\/dev\/sd[a-z]/,
];

const MODERATE_COMMANDS = [
  /\brm\b/,
  /\bmv\b/,
  /\bgit\s+push\b/,
  /\bgit\s+checkout\b/,
  /\bgit\s+merge\b/,
  /\bgit\s+rebase\b/,
  /\bnpm\s+(install|uninstall|update)\b/,
  /\bpip\s+install\b/,
  /\bcurl\b.*\|\s*(sh|bash)\b/,
  /\bwget\b.*\|\s*(sh|bash)\b/,
  /\bsudo\b/,
];

const SAFE_COMMANDS = [
  /\bls\b/,
  /\bcat\b/,
  /\becho\b/,
  /\bpwd\b/,
  /\bwhoami\b/,
  /\bdate\b/,
  /\bgit\s+(status|log|diff|branch)\b/,
  /\bnpm\s+(test|run|start)\b/,
  /\bnode\b/,
  /\btsc\b/,
  /\bpython\b.*\.py/,
];

const NETWORK_TOOLS = new Set(['web_fetch', 'http_client', 'browser', 'web_search']);

// ── Scorer ──

export class RiskScorer {
  private sessionHistory: RiskAssessment[] = [];

  /**
   * Assess risk for a tool call.
   *
   * @param toolName — name of the tool being invoked
   * @param args — tool arguments
   * @param permission — tool's effective permission level
   */
  assess(
    toolName: string,
    args: Record<string, unknown>,
    permission: 'auto' | 'prompt' | 'always-ask' = 'auto',
  ): RiskAssessment {
    try {
      const factors: RiskFactor[] = [
        this.scorePermissionLevel(permission),
        this.scoreFilePathSensitivity(toolName, args),
        this.scoreCommandDestructiveness(toolName, args),
        this.scoreNetworkAccess(toolName),
        this.scoreDataVolume(args),
        this.scoreCumulativeRisk(),
      ];

      const score = Math.min(100, Math.round(
        factors.reduce((sum, f) => sum + f.weighted, 0)
      ));

      const level = scoreToLevel(score);
      const assessment: RiskAssessment = { score, level, factors };
      this.sessionHistory.push(assessment);
      return assessment;
    } catch {
      // Fail-safe: return zero risk if scoring fails
      return { score: 0, level: 'green', factors: [] };
    }
  }

  /**
   * Assess risk with constitutional layer enrichment.
   * Adds a 7th factor based on CORD's constitutional score.
   */
  assessWithConstitutional(
    toolName: string,
    args: Record<string, unknown>,
    permission: 'auto' | 'prompt' | 'always-ask' = 'auto',
    constitutional: ConstitutionalResult,
  ): RiskAssessment {
    try {
      const factors: RiskFactor[] = [
        this.scorePermissionLevel(permission),
        this.scoreFilePathSensitivity(toolName, args),
        this.scoreCommandDestructiveness(toolName, args),
        this.scoreNetworkAccess(toolName),
        this.scoreDataVolume(args),
        this.scoreCumulativeRisk(),
        this.scoreConstitutional(constitutional),
      ];

      const score = Math.min(100, Math.round(
        factors.reduce((sum, f) => sum + f.weighted, 0)
      ));

      const level = scoreToLevel(score);
      const assessment: RiskAssessment = { score, level, factors };
      this.sessionHistory.push(assessment);
      return assessment;
    } catch {
      return { score: 0, level: 'green', factors: [] };
    }
  }

  /** Factor 7: Constitutional score (weight 15) — CORD evaluation result */
  private scoreConstitutional(result: ConstitutionalResult): RiskFactor {
    const weight = 15;
    const rawScore = Math.min(100, result.score);
    const reason = result.hardBlock
      ? `Constitutional hard block: ${result.hardBlockReason || 'violation'}`
      : result.decision === 'BLOCK'
        ? `Constitutional BLOCK (score ${result.score})`
        : result.decision === 'CHALLENGE'
          ? `Constitutional CHALLENGE (score ${result.score})`
          : result.decision === 'CONTAIN'
            ? `Constitutional CONTAIN (score ${result.score})`
            : 'Constitutional ALLOW';

    return {
      name: 'constitutional',
      weight,
      rawScore,
      weighted: rawScore * (weight / 100),
      reason,
    };
  }

  /** Get all assessments from this session */
  getHistory(): RiskAssessment[] {
    return [...this.sessionHistory];
  }

  /** Get the session's cumulative average risk */
  getSessionAverage(): number {
    if (this.sessionHistory.length === 0) return 0;
    const sum = this.sessionHistory.reduce((s, a) => s + a.score, 0);
    return Math.round(sum / this.sessionHistory.length);
  }

  /** Format a colored risk indicator for CLI display */
  static formatIndicator(assessment: RiskAssessment): string {
    const { score, level } = assessment;
    const colorMap: Record<string, string> = {
      green: '\x1b[32m',
      yellow: '\x1b[33m',
      orange: '\x1b[38;5;208m',
      red: '\x1b[31m',
    };
    const color = colorMap[level] || '';
    const reset = '\x1b[0m';
    return `${color}[Risk: ${score} ${level}]${reset}`;
  }

  // ── Factor Scorers ──

  /** Factor 1: Tool permission level (weight 30) */
  private scorePermissionLevel(permission: 'auto' | 'prompt' | 'always-ask'): RiskFactor {
    const weight = 30;
    let rawScore: number;
    let reason: string;

    switch (permission) {
      case 'auto':
        rawScore = 0;
        reason = 'Auto-approved tool';
        break;
      case 'prompt':
        rawScore = 50;
        reason = 'Requires prompt approval';
        break;
      case 'always-ask':
        rawScore = 100;
        reason = 'Always requires explicit approval';
        break;
      default:
        rawScore = 0;
        reason = 'Unknown permission level';
    }

    return {
      name: 'permission_level',
      weight,
      rawScore,
      weighted: rawScore * (weight / 100),
      reason,
    };
  }

  /** Factor 2: File path sensitivity (weight 20) */
  private scoreFilePathSensitivity(toolName: string, args: Record<string, unknown>): RiskFactor {
    const weight = 20;
    const filePath = (args.path as string) || (args.file as string) || '';

    if (!filePath) {
      return { name: 'file_path', weight, rawScore: 0, weighted: 0, reason: 'No file path' };
    }

    // Check sensitive patterns
    for (const pattern of SENSITIVE_PATH_PATTERNS) {
      if (pattern.test(filePath)) {
        return {
          name: 'file_path',
          weight,
          rawScore: 100,
          weighted: weight,
          reason: `Sensitive path: ${filePath}`,
        };
      }
    }

    // Check moderate patterns
    for (const pattern of MODERATE_PATH_PATTERNS) {
      if (pattern.test(filePath)) {
        return {
          name: 'file_path',
          weight,
          rawScore: 40,
          weighted: 40 * (weight / 100),
          reason: `Config file: ${filePath}`,
        };
      }
    }

    // Project source files — low risk
    return {
      name: 'file_path',
      weight,
      rawScore: 10,
      weighted: 10 * (weight / 100),
      reason: `Project file: ${filePath}`,
    };
  }

  /** Factor 3: Command destructiveness (weight 20) */
  private scoreCommandDestructiveness(toolName: string, args: Record<string, unknown>): RiskFactor {
    const weight = 20;
    const command = (args.command as string) || '';

    if (toolName !== 'execute' || !command) {
      return { name: 'command', weight, rawScore: 0, weighted: 0, reason: 'Not a shell command' };
    }

    // Check destructive
    for (const pattern of DESTRUCTIVE_COMMANDS) {
      if (pattern.test(command)) {
        return {
          name: 'command',
          weight,
          rawScore: 100,
          weighted: weight,
          reason: `Destructive command: ${command.substring(0, 60)}`,
        };
      }
    }

    // Check moderate
    for (const pattern of MODERATE_COMMANDS) {
      if (pattern.test(command)) {
        return {
          name: 'command',
          weight,
          rawScore: 50,
          weighted: 50 * (weight / 100),
          reason: `Moderate risk command: ${command.substring(0, 60)}`,
        };
      }
    }

    // Check safe
    for (const pattern of SAFE_COMMANDS) {
      if (pattern.test(command)) {
        return {
          name: 'command',
          weight,
          rawScore: 5,
          weighted: 5 * (weight / 100),
          reason: `Safe command: ${command.substring(0, 60)}`,
        };
      }
    }

    // Unknown command — moderate risk
    return {
      name: 'command',
      weight,
      rawScore: 30,
      weighted: 30 * (weight / 100),
      reason: `Unknown command: ${command.substring(0, 60)}`,
    };
  }

  /** Factor 4: Network access (weight 15) */
  private scoreNetworkAccess(toolName: string): RiskFactor {
    const weight = 15;
    if (NETWORK_TOOLS.has(toolName)) {
      return {
        name: 'network',
        weight,
        rawScore: 70,
        weighted: 70 * (weight / 100),
        reason: `Network-accessing tool: ${toolName}`,
      };
    }
    return { name: 'network', weight, rawScore: 0, weighted: 0, reason: 'No network access' };
  }

  /** Factor 5: Data volume (weight 10) */
  private scoreDataVolume(args: Record<string, unknown>): RiskFactor {
    const weight = 10;
    const content = (args.content as string) || (args.body as string) || '';
    const command = (args.command as string) || '';

    const totalSize = content.length + command.length + JSON.stringify(args).length;

    // Check for pipes/redirects in commands
    const hasPipe = /\|/.test(command);
    const hasRedirect = />/.test(command);

    if (totalSize > 10240) {
      return {
        name: 'data_volume',
        weight,
        rawScore: 90,
        weighted: 90 * (weight / 100),
        reason: `Large payload: ${(totalSize / 1024).toFixed(1)}KB`,
      };
    }

    if (hasPipe || hasRedirect) {
      return {
        name: 'data_volume',
        weight,
        rawScore: 50,
        weighted: 50 * (weight / 100),
        reason: 'Command uses pipes/redirects',
      };
    }

    if (totalSize > 2048) {
      return {
        name: 'data_volume',
        weight,
        rawScore: 30,
        weighted: 30 * (weight / 100),
        reason: `Moderate payload: ${(totalSize / 1024).toFixed(1)}KB`,
      };
    }

    return { name: 'data_volume', weight, rawScore: 0, weighted: 0, reason: 'Small payload' };
  }

  /** Factor 6: Cumulative session risk (weight 5) */
  private scoreCumulativeRisk(): RiskFactor {
    const weight = 5;
    const count = this.sessionHistory.length;

    if (count === 0) {
      return { name: 'cumulative', weight, rawScore: 0, weighted: 0, reason: 'First tool call' };
    }

    // Count high-risk calls in session
    const highRisk = this.sessionHistory.filter(a => a.score > 50).length;
    const ratio = highRisk / count;

    if (ratio > 0.5) {
      return {
        name: 'cumulative',
        weight,
        rawScore: 80,
        weighted: 80 * (weight / 100),
        reason: `High-risk session: ${highRisk}/${count} calls above 50`,
      };
    }

    if (count > 20) {
      return {
        name: 'cumulative',
        weight,
        rawScore: 40,
        weighted: 40 * (weight / 100),
        reason: `Long session: ${count} tool calls`,
      };
    }

    return {
      name: 'cumulative',
      weight,
      rawScore: 10,
      weighted: 10 * (weight / 100),
      reason: `Session: ${count} tool calls`,
    };
  }
}

// ── Helpers ──

function scoreToLevel(score: number): 'green' | 'yellow' | 'orange' | 'red' {
  if (score <= 25) return 'green';
  if (score <= 50) return 'yellow';
  if (score <= 75) return 'orange';
  return 'red';
}
