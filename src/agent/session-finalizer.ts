import { log } from '../logger';
import type { CrossSessionLearning } from '../cross-session';
import type { ExperientialMemory } from '../experiential-memory';
import type { AgentStateEngine } from '../spark-soul';

/**
 * Inputs for `recordSessionEpisode`. Captured into a single struct so
 * the agent's `finishRun` can pass everything in one call without a
 * 12-arg signature.
 */
export interface SessionEpisodeContext {
  sessionId: string;
  startedAt: string;
  goal: string;
  projectRoot: string;
  toolCalls: Array<{ tool: string; success: boolean }>;
  tokenUsage: { input: number; output: number };
  success: boolean;
  outcomeSummary: string;
  outcomeHints: string[];
  crossSession: CrossSessionLearning;
  experientialMemory: ExperientialMemory;
}

/**
 * Record a cross-session episode at run end + reinforce/weaken the lessons
 * surfaced during the run + run periodic consolidation.
 *
 * Catches its own errors — cross-session recording must never crash the agent.
 */
export function recordSessionEpisode(ctx: SessionEpisodeContext): void {
  try {
    const outcomes = [ctx.outcomeSummary, ...ctx.outcomeHints]
      .map((outcome) => outcome.trim())
      .filter(Boolean)
      .filter((outcome, index, all) => all.indexOf(outcome) === index)
      .slice(0, 4);
    const episode = ctx.crossSession.buildEpisode({
      sessionId: ctx.sessionId,
      projectRoot: ctx.projectRoot,
      startedAt: ctx.startedAt,
      goal: ctx.goal,
      toolCalls: ctx.toolCalls,
      success: ctx.success,
      outcomes:
        outcomes.length > 0
          ? outcomes
          : [ctx.success ? 'Session completed successfully' : 'Session ended (max iterations or error)'],
      tokenUsage: ctx.tokenUsage,
    });
    ctx.crossSession.recordEpisode(episode);
    try {
      ctx.experientialMemory.recordTaskOutcome(ctx.success);
    } catch {}
    try {
      ctx.experientialMemory.decayAndConsolidate();
    } catch {}
  } catch {
    /* cross-session recording should never crash the agent */
  }
}

/** Best-effort terminal state-engine finalization. Logs on failure, never throws. */
export function finalizeStateEngine(stateEngine: AgentStateEngine | null): void {
  if (!stateEngine) return;
  try {
    stateEngine.finalizeSession();
  } catch (e) {
    log.warn(`[CodeBot] Failed to finalize state engine: ${(e as Error).message}`);
  }
}
