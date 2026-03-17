/**
 * AgentStateEngine — Adaptive state engine for CodeBot.
 *
 * Wraps SparkOrchestrator into a clean facade that agent.ts consumes.
 * All methods are try/catch-wrapped: SPARK failure never crashes CodeBot.
 *
 * Split architecture:
 *   spark-types.ts   — Types, constants, mappings
 *   spark-helpers.ts — Pure functions, classifiers, orchestrator helpers
 *   spark-soul.ts      — AgentStateEngine class (this file)
 */

import * as path from 'path';
import * as fs from 'fs';

import {
  SafetyDecision,
  EmotionalSnapshot,
  PersonalitySnapshot,
  CATEGORY_BASE_SCORES,
  WIDE_BOUNDS,
  ALL_CATEGORIES,
} from './spark-types';

import {
  scoreToDecision,
  classifyFailure,
  failureToOutcome,
  resolveToolCategory,
  resolveToolOperation,
  tryCall,
  buildOutcomeSignal,
  makeSafetyDecision,
  updateEmotionalState,
  evolvePersonality,
  persistEngines,
  initializeWeightBounds,
  seedCategoryWeights,
} from './spark-helpers';

// Re-export for consumers that import from spark-soul
export {
  scoreToDecision,
  classifyFailure,
  failureToOutcome,
  resolveToolCategory,
  resolveToolOperation,
} from './spark-helpers';

// ── AgentStateEngine Class ──────────────────────────────────────────────

export class AgentStateEngine {
  private orchestrator: any;
  private store: any;
  private db: any;
  private sessionId: string;
  private predictions = new Map<string, any>();
  private initialized = false;
  private toolHistory: string[] = [];
  private successCount = 0;
  private failureCount = 0;
  private totalPredictions = 0;

  constructor(projectRoot: string) {
    this.sessionId = `session-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    try {
      const { Database, SparkStore } = require('@ai-operations/ops-storage');
      const { SparkOrchestrator } = require('@ai-operations/spark-engine');
      const sparkDir = path.join(projectRoot, '.spark');
      if (!fs.existsSync(sparkDir)) fs.mkdirSync(sparkDir, { recursive: true });
      this.db = new Database(path.join(sparkDir, 'data.db'));
      this.store = new SparkStore(this.db.db);
      this.orchestrator = new SparkOrchestrator(this.store);
      tryCall(() => initializeWeightBounds(this.store, WIDE_BOUNDS));
      tryCall(() => seedCategoryWeights(this.store, CATEGORY_BASE_SCORES, WIDE_BOUNDS));
      this.initialized = true;
    } catch {
      this.initialized = false;
    }
  }

  get isActive(): boolean { return this.initialized; }

  getPromptBlock(currentQuery?: string): string {
    if (!this.initialized) return '';
    try {
      const parts = ['\n--- Agent State ---'];
      const emo = tryCall(() => this.orchestrator.emotionalState.getSummary());
      if (emo) parts.push(`Emotional state: ${emo}`);
      const pers = tryCall(() => this.orchestrator.personality.getSummary());
      if (pers) parts.push(`Personality: ${pers}`);
      if (currentQuery) {
        const ctx = tryCall(() => this.orchestrator.reconstructor.reconstruct(currentQuery, { maxTokens: 500 }));
        if (ctx?.narrative) parts.push(`Relevant memory: ${ctx.narrative}`);
      }
      const report = tryCall(() => this.orchestrator.awareness.report());
      if (report?.systemState?.totalEpisodes > 0) {
        const { overallConfidence, totalEpisodes } = report.systemState;
        parts.push(`Learning: ${totalEpisodes} experiences, ${Math.round(overallConfidence * 100)}% confidence`);
      }
      if (report?.alerts) {
        for (const alert of report.alerts.slice(0, 3)) {
          parts.push(`Alert: ${alert.message || alert.type}`);
        }
      }
      parts.push('--- End Agent State ---\n');
      return parts.length > 2 ? parts.join('\n') : '';
    } catch {
      return '';
    }
  }

  evaluateTool(tool: string, args: Record<string, unknown>): SafetyDecision {
    if (!this.initialized) return { decision: 'ALLOW' };
    try {
      const category = resolveToolCategory(tool, args);
      this.totalPredictions++;
      const operation = resolveToolOperation(tool, args);
      const prediction = tryCall(() => {
        const p = this.orchestrator.predictor.predict(`${tool}-${Date.now()}`, this.sessionId, tool, operation);
        this.predictions.set(`${tool}:${JSON.stringify(args)}`, p);
        return p;
      });
      return makeSafetyDecision(prediction, this.orchestrator, category);
    } catch {
      return { decision: 'ALLOW' };
    }
  }

  recordOutcome(tool: string, args: Record<string, unknown>, success: boolean, output: string, durationMs: number): void {
    if (!this.initialized) return;
    try {
      const category = resolveToolCategory(tool, args);
      const predKey = `${tool}:${JSON.stringify(args)}`;
      let prediction = this.predictions.get(predKey);
      if (prediction) this.predictions.delete(predKey);
      if (!prediction) {
        const operation = resolveToolOperation(tool, args);
        prediction = tryCall(() => this.orchestrator.predictor.predict(`${tool}-${Date.now()}`, this.sessionId, tool, operation));
      }
      const failureInfo = (!success && output) ? failureToOutcome(classifyFailure(output)) : undefined;
      if (prediction) {
        const outcome = buildOutcomeSignal(prediction, this.sessionId, success, output, durationMs, failureInfo);
        this.orchestrator.learn(prediction, outcome);
      }
      if (!this.toolHistory.includes(tool)) this.toolHistory.push(tool);
      if (success) this.successCount++;
      else this.failureCount++;
      const hasSentinel = category === 'destructive' || category === 'financial';
      tryCall(() => updateEmotionalState(this.orchestrator, this.store, success, failureInfo, tool, category));
      tryCall(() => evolvePersonality(this.orchestrator, this.store, this.toolHistory, hasSentinel, success ? 'execute' : 'diagnose'));
    } catch { /* learning failed — non-fatal */ }
  }

  finalizeSession(): { reflection?: any } {
    if (!this.initialized) return {};
    try {
      const reflection = tryCall(() => this.orchestrator.reflection.reflect());
      if (reflection && this.store.saveReflection) {
        tryCall(() => this.store.saveReflection({ sessionId: this.sessionId, reflection, timestamp: new Date().toISOString() }));
      }
      tryCall(() => evolvePersonality(this.orchestrator, this.store, this.toolHistory, false, 'reflect'));
      tryCall(() => persistEngines(this.orchestrator, this.store));
      return { reflection };
    } catch {
      return {};
    }
  }

  getEmotionalState(): EmotionalSnapshot | null {
    if (!this.initialized) return null;
    return tryCall(() => {
      const summary = this.orchestrator.emotionalState.getSummary();
      const state = this.orchestrator.emotionalState.getState();
      return { summary, valence: state?.valence ?? 0, momentum: state?.momentum ?? 0 };
    }) || null;
  }

  getPersonality(): PersonalitySnapshot | null {
    if (!this.initialized) return null;
    return tryCall(() => {
      const summary = this.orchestrator.personality.getSummary();
      const profile = this.orchestrator.personality.getProfile();
      return { summary, traits: profile ? { ...profile } : {} };
    }) || null;
  }

  getWeights(): Record<string, any> | null {
    if (!this.initialized) return null;
    return tryCall(() => {
      const weights: Record<string, any> = {};
      for (const cat of ALL_CATEGORIES) {
        const w = tryCall(() => this.store.getWeight(cat));
        if (w) {
          weights[cat] = { current: w.currentWeight, base: w.baseWeight, lower: w.lowerBound, upper: w.upperBound, episodes: w.episodeCount };
        }
      }
      return weights;
    }) || null;
  }

  getLearningStats(): { totalEpisodes: number; predictions: number; successCount: number; failureCount: number; successRate: number } {
    const total = this.successCount + this.failureCount;
    return {
      totalEpisodes: total,
      predictions: this.totalPredictions || 0,
      successCount: this.successCount,
      failureCount: this.failureCount,
      successRate: total > 0 ? this.successCount / total : 0,
    };
  }

  getAwarenessReport(): any {
    if (!this.initialized) return null;
    return tryCall(() => this.orchestrator.awareness.report()) || null;
  }
}

/** @deprecated Alias for backward compatibility — use AgentStateEngine */
export const SparkSoul = AgentStateEngine;
export type SparkSoul = AgentStateEngine;
