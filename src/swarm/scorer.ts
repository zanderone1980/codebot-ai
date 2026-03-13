import * as fs from 'fs';
import * as path from 'path';
import { codebotPath } from '../paths';

import { AgentRole } from './roles';

// ── Types ──────────────────────────────────────────────────────────────────────

export interface ScoreFactor {
  name: string;
  score: number;       // 0-10
  weight: number;      // 0-1
  description: string;
}

export interface AgentScore {
  agentId: string;
  model: string;
  role: AgentRole;
  qualityScore: number; // 1-10
  tokensPerSecond: number;
  costEfficiency: number;
  factors: ScoreFactor[];
  scoredAt: number;     // timestamp
}

export interface ModelPerformance {
  model: string;
  role: AgentRole;
  avgScore: number;
  totalRuns: number;
  avgDurationMs: number;
  avgCostUsd: number;
  successRate: number;  // 0-1
  lastUsed: number;     // timestamp
}

export interface AgentContribution {
  content: string;
  toolCalls: string[];
  filesModified: string[];
  durationMs: number;
  tokenUsage: { input: number; output: number };
  errors: number;
}

// ── SwarmScorer ────────────────────────────────────────────────────────────────

export class SwarmScorer {
  private static readonly SCORE_FILE = codebotPath('swarm-scores.json');

  private history: ModelPerformance[];

  constructor() {
    this.history = this.loadHistory();
  }

  // ── Public API ─────────────────────────────────────────────────────────────

  /**
   * Score an agent's contribution across multiple quality factors.
   */
  scoreAgent(
    agentId: string,
    model: string,
    role: AgentRole,
    contribution: AgentContribution
  ): AgentScore {
    const factors: ScoreFactor[] = [];
    const isCodingRole = role === 'coder' || role === 'tester';

    // 1. Completeness
    const completenessScore = Math.min(contribution.content.length / 200, 10);
    const completenessWeight = isCodingRole ? 0.25 : 0.4;
    factors.push({
      name: 'completeness',
      score: completenessScore,
      weight: completenessWeight,
      description: `Output length: ${contribution.content.length} chars`,
    });

    // 2. Tool usage
    const toolScore = Math.min(contribution.toolCalls.length * 2, 10);
    factors.push({
      name: 'tool_usage',
      score: toolScore,
      weight: 0.2,
      description: `Used ${contribution.toolCalls.length} tools`,
    });

    // 3. Speed
    const durationSec = contribution.durationMs / 1000;
    const tokensPerSecond = durationSec > 0
      ? contribution.tokenUsage.output / durationSec
      : 0;
    const speedScore = Math.min(tokensPerSecond / 5, 10);
    factors.push({
      name: 'speed',
      score: speedScore,
      weight: 0.15,
      description: `${tokensPerSecond.toFixed(1)} tokens/sec`,
    });

    // 4. Reliability
    let reliabilityScore: number;
    if (contribution.errors === 0) {
      reliabilityScore = 10;
    } else if (contribution.errors === 1) {
      reliabilityScore = 6;
    } else if (contribution.errors <= 3) {
      reliabilityScore = 3;
    } else {
      reliabilityScore = 0;
    }
    factors.push({
      name: 'reliability',
      score: reliabilityScore,
      weight: 0.2,
      description: `${contribution.errors} errors`,
    });

    // 5. File impact (coding roles only)
    if (isCodingRole) {
      const fileImpactScore = Math.min(contribution.filesModified.length * 3, 10);
      factors.push({
        name: 'file_impact',
        score: fileImpactScore,
        weight: 0.2,
        description: `${contribution.filesModified.length} files modified`,
      });
    }

    // Normalize weights so they sum to 1
    const totalWeight = factors.reduce((sum, f) => sum + f.weight, 0);
    if (totalWeight > 0) {
      for (const f of factors) {
        f.weight = f.weight / totalWeight;
      }
    }

    // Compute weighted average
    const qualityScore = factors.reduce(
      (sum, f) => sum + f.score * f.weight,
      0
    );

    // Estimate cost efficiency (score per dollar-equivalent, using token counts)
    const totalTokens = contribution.tokenUsage.input + contribution.tokenUsage.output;
    const costEfficiency = totalTokens > 0 ? (qualityScore / totalTokens) * 1000 : 0;

    // Record to history
    this.recordPerformance(model, role, qualityScore, contribution.durationMs);

    return {
      agentId,
      model,
      role,
      qualityScore,
      tokensPerSecond,
      costEfficiency,
      factors,
      scoredAt: Date.now(),
    };
  }

  /**
   * Get historical performance data for a specific model + role combination.
   */
  getModelPerformance(model: string, role: AgentRole): ModelPerformance | null {
    const entry = this.history.find(
      (h) => h.model === model && h.role === role
    );
    return entry ?? null;
  }

  /**
   * Return a copy of all historical performance records.
   */
  getAllPerformance(): ModelPerformance[] {
    return [...this.history];
  }

  /**
   * Find the best-performing model for a given role (minimum 3 runs).
   */
  getBestModelForRole(role: AgentRole): string | null {
    const candidates = this.history
      .filter((h) => h.role === role && h.totalRuns >= 3)
      .sort((a, b) => b.avgScore - a.avgScore);

    return candidates.length > 0 ? candidates[0].model : null;
  }

  // ── Private ────────────────────────────────────────────────────────────────

  /**
   * Record or update a performance entry for a model + role combination.
   */
  private recordPerformance(
    model: string,
    role: AgentRole,
    score: number,
    durationMs: number
  ): void {
    const existing = this.history.find(
      (h) => h.model === model && h.role === role
    );

    if (existing) {
      // Update running averages
      const n = existing.totalRuns;
      existing.avgScore = (existing.avgScore * n + score) / (n + 1);
      existing.avgDurationMs = (existing.avgDurationMs * n + durationMs) / (n + 1);
      existing.totalRuns = n + 1;
      existing.successRate = (existing.successRate * n + (score >= 5 ? 1 : 0)) / (n + 1);
      existing.lastUsed = Date.now();
    } else {
      this.history.push({
        model,
        role,
        avgScore: score,
        totalRuns: 1,
        avgDurationMs: durationMs,
        avgCostUsd: 0,
        successRate: score >= 5 ? 1 : 0,
        lastUsed: Date.now(),
      });
    }

    this.saveHistory();
  }

  /**
   * Load scoring history from disk.
   */
  private loadHistory(): ModelPerformance[] {
    try {
      const raw = fs.readFileSync(SwarmScorer.SCORE_FILE, 'utf-8');
      return JSON.parse(raw) as ModelPerformance[];
    } catch {
      return [];
    }
  }

  /**
   * Persist scoring history to disk.
   */
  private saveHistory(): void {
    try {
      fs.mkdirSync(path.dirname(SwarmScorer.SCORE_FILE), { recursive: true });
      fs.writeFileSync(
        SwarmScorer.SCORE_FILE,
        JSON.stringify(this.history, null, 2),
        'utf-8'
      );
    } catch {
      // Silently ignore write errors
    }
  }
}
