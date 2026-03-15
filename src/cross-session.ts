/**
 * Cross-Session Learning — remembers what worked across sessions and projects.
 *
 * Records episodes (session summaries with tools used, outcomes, patterns),
 * indexes them for quick retrieval, and feeds top patterns into future
 * system prompts and skill confidence adjustments.
 *
 * Storage: ~/.codebot/episodes/<session-id>.json + index.json
 */

import * as fs from 'fs';
import * as path from 'path';
import { codebotPath } from './paths';

// ── Types ──

export interface Episode {
  sessionId: string;
  projectRoot: string;
  startedAt: string;
  endedAt: string;
  /** High-level goal or user request */
  goal: string;
  /** Tools used during this session */
  toolsUsed: string[];
  /** Number of iterations/tool calls */
  iterationCount: number;
  /** Whether the session ended successfully */
  success: boolean;
  /** Key outcomes or error messages */
  outcomes: string[];
  /** Patterns discovered (tool chains that worked/failed) */
  patterns: EpisodePattern[];
  /** Token usage */
  tokenUsage: { input: number; output: number };
}

export interface EpisodePattern {
  /** What the pattern does */
  description: string;
  /** Tool sequence that formed this pattern */
  toolChain: string[];
  /** Did this pattern lead to success? */
  effective: boolean;
  /** How many times seen across sessions */
  frequency: number;
}

export interface PatternIndex {
  /** Pattern key (tool chain hash) → aggregated pattern */
  patterns: Record<string, AggregatedPattern>;
  /** Last updated timestamp */
  updatedAt: string;
}

export interface AggregatedPattern {
  description: string;
  toolChain: string[];
  successCount: number;
  failureCount: number;
  totalOccurrences: number;
  /** Computed: successCount / totalOccurrences */
  successRate: number;
  lastSeen: string;
  /** Sessions where this pattern appeared */
  sessionIds: string[];
}

// ── Cross-Session Learning Engine ──

export class CrossSessionLearning {
  private episodesDir: string;
  private indexPath: string;
  private patternIndex: PatternIndex | null = null;

  constructor() {
    this.episodesDir = codebotPath('episodes');
    this.indexPath = codebotPath('episodes', 'index.json');
  }

  /**
   * Record a completed session as an episode.
   */
  recordEpisode(episode: Episode): void {
    fs.mkdirSync(this.episodesDir, { recursive: true });

    // Save episode
    const episodePath = path.join(this.episodesDir, `${episode.sessionId}.json`);
    fs.writeFileSync(episodePath, JSON.stringify(episode, null, 2));

    // Update pattern index
    this.updatePatternIndex(episode);
  }

  /**
   * Build an episode from session data.
   */
  buildEpisode(opts: {
    sessionId: string;
    projectRoot: string;
    startedAt: string;
    goal: string;
    toolCalls: Array<{ tool: string; success: boolean }>;
    success: boolean;
    outcomes: string[];
    tokenUsage: { input: number; output: number };
  }): Episode {
    const toolsUsed = [...new Set(opts.toolCalls.map(t => t.tool))];
    const patterns = this.extractPatterns(opts.toolCalls);

    return {
      sessionId: opts.sessionId,
      projectRoot: opts.projectRoot,
      startedAt: opts.startedAt,
      endedAt: new Date().toISOString(),
      goal: opts.goal,
      toolsUsed,
      iterationCount: opts.toolCalls.length,
      success: opts.success,
      outcomes: opts.outcomes,
      patterns,
      tokenUsage: opts.tokenUsage,
    };
  }

  /**
   * Extract tool chain patterns from a sequence of tool calls.
   * Looks for consecutive tool sequences of length 2-4.
   */
  extractPatterns(toolCalls: Array<{ tool: string; success: boolean }>): EpisodePattern[] {
    if (toolCalls.length < 2) return [];

    const patternMap = new Map<string, EpisodePattern>();

    // Sliding window of sizes 2, 3, 4
    for (let windowSize = 2; windowSize <= Math.min(4, toolCalls.length); windowSize++) {
      for (let i = 0; i <= toolCalls.length - windowSize; i++) {
        const window = toolCalls.slice(i, i + windowSize);
        const chain = window.map(t => t.tool);
        const key = chain.join(' → ');

        if (!patternMap.has(key)) {
          const effective = window.every(t => t.success);
          patternMap.set(key, {
            description: `${chain.join(' → ')}`,
            toolChain: chain,
            effective,
            frequency: 1,
          });
        } else {
          patternMap.get(key)!.frequency++;
        }
      }
    }

    // Only keep patterns seen more than once or that are effective
    return [...patternMap.values()].filter(p => p.frequency > 1 || p.effective);
  }

  /**
   * Get top N patterns by success rate for system prompt injection.
   */
  getTopPatterns(n = 3): AggregatedPattern[] {
    const index = this.loadPatternIndex();
    const patterns = Object.values(index.patterns);

    // Filter to patterns with enough data and sort by success rate
    return patterns
      .filter(p => p.totalOccurrences >= 2)
      .sort((a, b) => {
        // Primary: success rate, secondary: total occurrences
        if (b.successRate !== a.successRate) return b.successRate - a.successRate;
        return b.totalOccurrences - a.totalOccurrences;
      })
      .slice(0, n);
  }

  /**
   * Get anti-patterns (low success rate) to avoid.
   */
  getAntiPatterns(n = 3): AggregatedPattern[] {
    const index = this.loadPatternIndex();
    const patterns = Object.values(index.patterns);

    return patterns
      .filter(p => p.totalOccurrences >= 3 && p.successRate < 0.3)
      .sort((a, b) => a.successRate - b.successRate)
      .slice(0, n);
  }

  /**
   * Format top patterns as a system prompt block.
   */
  buildPromptBlock(): string {
    const top = this.getTopPatterns(3);
    const anti = this.getAntiPatterns(2);

    if (top.length === 0 && anti.length === 0) return '';

    const lines: string[] = ['## Cross-Session Patterns'];

    if (top.length > 0) {
      lines.push('Effective patterns from previous sessions:');
      for (const p of top) {
        lines.push(`  - ${p.toolChain.join(' → ')} (${Math.round(p.successRate * 100)}% success, ${p.totalOccurrences} uses)`);
      }
    }

    if (anti.length > 0) {
      lines.push('Patterns to avoid:');
      for (const p of anti) {
        lines.push(`  - ${p.toolChain.join(' → ')} (${Math.round(p.successRate * 100)}% success — consider alternatives)`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Get episode by session ID.
   */
  getEpisode(sessionId: string): Episode | null {
    const episodePath = path.join(this.episodesDir, `${sessionId}.json`);
    if (!fs.existsSync(episodePath)) return null;
    try {
      return JSON.parse(fs.readFileSync(episodePath, 'utf-8'));
    } catch { return null; }
  }

  /**
   * List all episode session IDs, most recent first.
   */
  listEpisodes(): string[] {
    if (!fs.existsSync(this.episodesDir)) return [];

    try {
      return fs.readdirSync(this.episodesDir)
        .filter(f => f.endsWith('.json') && f !== 'index.json')
        .map(f => f.replace('.json', ''))
        .reverse();
    } catch { return []; }
  }

  /**
   * Get summary statistics across all episodes.
   */
  summarize(): string {
    const episodes = this.listEpisodes();
    if (episodes.length === 0) return 'No cross-session data recorded.';

    const index = this.loadPatternIndex();
    const patternCount = Object.keys(index.patterns).length;
    const topPatterns = this.getTopPatterns(3);

    const lines = [
      `Cross-Session Learning: ${episodes.length} episodes, ${patternCount} patterns`,
    ];

    if (topPatterns.length > 0) {
      lines.push('Top patterns:');
      for (const p of topPatterns) {
        lines.push(`  ${p.toolChain.join(' → ')} — ${Math.round(p.successRate * 100)}% success (${p.totalOccurrences}x)`);
      }
    }

    return lines.join('\n');
  }

  /**
   * Prune old episodes, keeping only the most recent N.
   */
  prune(keepCount = 50): number {
    const episodes = this.listEpisodes();
    if (episodes.length <= keepCount) return 0;

    let pruned = 0;
    const toRemove = episodes.slice(keepCount);
    for (const sessionId of toRemove) {
      try {
        fs.unlinkSync(path.join(this.episodesDir, `${sessionId}.json`));
        pruned++;
      } catch { /* skip */ }
    }
    return pruned;
  }

  // ── Internal ──

  private loadPatternIndex(): PatternIndex {
    if (this.patternIndex) return this.patternIndex;

    if (fs.existsSync(this.indexPath)) {
      try {
        this.patternIndex = JSON.parse(fs.readFileSync(this.indexPath, 'utf-8'));
        return this.patternIndex!;
      } catch { /* fall through */ }
    }

    this.patternIndex = { patterns: {}, updatedAt: new Date().toISOString() };
    return this.patternIndex;
  }

  private updatePatternIndex(episode: Episode): void {
    const index = this.loadPatternIndex();

    for (const pattern of episode.patterns) {
      const key = pattern.toolChain.join(':');

      if (!index.patterns[key]) {
        index.patterns[key] = {
          description: pattern.description,
          toolChain: pattern.toolChain,
          successCount: 0,
          failureCount: 0,
          totalOccurrences: 0,
          successRate: 0,
          lastSeen: episode.endedAt,
          sessionIds: [],
        };
      }

      const agg = index.patterns[key];
      agg.totalOccurrences += pattern.frequency;
      if (pattern.effective) {
        agg.successCount += pattern.frequency;
      } else {
        agg.failureCount += pattern.frequency;
      }
      agg.successRate = agg.totalOccurrences > 0
        ? agg.successCount / agg.totalOccurrences
        : 0;
      agg.lastSeen = episode.endedAt;
      if (!agg.sessionIds.includes(episode.sessionId)) {
        agg.sessionIds.push(episode.sessionId);
        // Keep only last 20 session IDs
        if (agg.sessionIds.length > 20) {
          agg.sessionIds = agg.sessionIds.slice(-20);
        }
      }
    }

    index.updatedAt = new Date().toISOString();
    this.patternIndex = index;

    try {
      fs.writeFileSync(this.indexPath, JSON.stringify(index, null, 2));
    } catch { /* best effort */ }
  }
}
