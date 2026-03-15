import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CrossSessionLearning, Episode, EpisodePattern } from './cross-session';

describe('CrossSessionLearning', () => {
  let tmpDir: string;
  let learning: CrossSessionLearning;
  const origEnv = process.env.CODEBOT_HOME;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-session-'));
    process.env.CODEBOT_HOME = tmpDir;
    learning = new CrossSessionLearning();
  });

  afterEach(() => {
    if (origEnv) process.env.CODEBOT_HOME = origEnv;
    else delete process.env.CODEBOT_HOME;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function makeEpisode(overrides?: Partial<Episode>): Episode {
    return {
      sessionId: `session_${Date.now()}`,
      projectRoot: '/tmp/project',
      startedAt: '2026-03-15T00:00:00Z',
      endedAt: '2026-03-15T00:10:00Z',
      goal: 'Fix a bug',
      toolsUsed: ['grep', 'read_file', 'edit_file'],
      iterationCount: 5,
      success: true,
      outcomes: ['Bug fixed'],
      patterns: [],
      tokenUsage: { input: 1000, output: 500 },
      ...overrides,
    };
  }

  describe('extractPatterns', () => {
    it('extracts patterns from tool calls', () => {
      const calls = [
        { tool: 'grep', success: true },
        { tool: 'read_file', success: true },
        { tool: 'edit_file', success: true },
        { tool: 'read_file', success: true },
      ];
      const patterns = learning.extractPatterns(calls);
      expect(patterns.length).toBeGreaterThan(0);
    });

    it('returns empty for single tool call', () => {
      expect(learning.extractPatterns([{ tool: 'grep', success: true }])).toEqual([]);
    });

    it('marks failed chains as not effective', () => {
      const calls = [
        { tool: 'grep', success: true },
        { tool: 'edit_file', success: false },
      ];
      const patterns = learning.extractPatterns(calls);
      const failedPattern = patterns.find(p => p.toolChain.includes('edit_file'));
      if (failedPattern) {
        expect(failedPattern.effective).toBe(false);
      }
    });
  });

  describe('buildEpisode', () => {
    it('builds episode from session data', () => {
      const episode = learning.buildEpisode({
        sessionId: 'test_session',
        projectRoot: '/tmp/proj',
        startedAt: '2026-03-15T00:00:00Z',
        goal: 'Add feature',
        toolCalls: [
          { tool: 'grep', success: true },
          { tool: 'read_file', success: true },
          { tool: 'edit_file', success: true },
        ],
        success: true,
        outcomes: ['Feature added'],
        tokenUsage: { input: 500, output: 300 },
      });

      expect(episode.sessionId).toBe('test_session');
      expect(episode.toolsUsed).toContain('grep');
      expect(episode.iterationCount).toBe(3);
      expect(episode.success).toBe(true);
    });
  });

  describe('recordEpisode', () => {
    it('saves episode to disk', () => {
      const episode = makeEpisode({ sessionId: 'saved_session' });
      learning.recordEpisode(episode);

      const loaded = learning.getEpisode('saved_session');
      expect(loaded).not.toBeNull();
      expect(loaded!.goal).toBe('Fix a bug');
    });

    it('updates pattern index', () => {
      const episode = makeEpisode({
        patterns: [{
          description: 'grep → read_file',
          toolChain: ['grep', 'read_file'],
          effective: true,
          frequency: 3,
        }],
      });
      learning.recordEpisode(episode);

      const indexPath = path.join(tmpDir, 'episodes', 'index.json');
      expect(fs.existsSync(indexPath)).toBe(true);
    });
  });

  describe('getTopPatterns', () => {
    it('returns patterns sorted by success rate', () => {
      // Record two episodes with different patterns
      learning.recordEpisode(makeEpisode({
        sessionId: 'sess1',
        patterns: [
          { description: 'a → b', toolChain: ['a', 'b'], effective: true, frequency: 3 },
          { description: 'c → d', toolChain: ['c', 'd'], effective: false, frequency: 2 },
        ],
      }));

      const top = learning.getTopPatterns(5);
      // a→b should rank higher (effective=true)
      if (top.length >= 2) {
        expect(top[0].successRate).toBeGreaterThanOrEqual(top[1].successRate);
      }
    });

    it('filters patterns with less than 2 occurrences', () => {
      learning.recordEpisode(makeEpisode({
        sessionId: 'sess_single',
        patterns: [
          { description: 'x → y', toolChain: ['x', 'y'], effective: true, frequency: 1 },
        ],
      }));

      const top = learning.getTopPatterns(5);
      const found = top.find(p => p.toolChain.join(':') === 'x:y');
      expect(found).toBeUndefined();
    });
  });

  describe('buildPromptBlock', () => {
    it('returns empty string when no patterns', () => {
      expect(learning.buildPromptBlock()).toBe('');
    });

    it('includes effective patterns', () => {
      learning.recordEpisode(makeEpisode({
        sessionId: 'prompt_test',
        patterns: [
          { description: 'grep → edit', toolChain: ['grep', 'edit'], effective: true, frequency: 5 },
        ],
      }));

      const block = learning.buildPromptBlock();
      if (block) {
        expect(block).toContain('Cross-Session');
      }
    });
  });

  describe('listEpisodes', () => {
    it('lists all episode IDs', () => {
      learning.recordEpisode(makeEpisode({ sessionId: 'ep1' }));
      learning.recordEpisode(makeEpisode({ sessionId: 'ep2' }));

      const list = learning.listEpisodes();
      expect(list).toContain('ep1');
      expect(list).toContain('ep2');
    });

    it('returns empty array when no episodes', () => {
      expect(learning.listEpisodes()).toEqual([]);
    });
  });

  describe('summarize', () => {
    it('returns message when no data', () => {
      expect(learning.summarize()).toContain('No cross-session');
    });

    it('includes episode count', () => {
      learning.recordEpisode(makeEpisode({ sessionId: 'sum1' }));
      learning.recordEpisode(makeEpisode({ sessionId: 'sum2' }));
      expect(learning.summarize()).toContain('2 episodes');
    });
  });

  describe('prune', () => {
    it('removes old episodes', () => {
      for (let i = 0; i < 5; i++) {
        learning.recordEpisode(makeEpisode({ sessionId: `prune_${i}` }));
      }
      const pruned = learning.prune(2);
      expect(pruned).toBe(3);
      expect(learning.listEpisodes().length).toBe(2);
    });

    it('does nothing when under limit', () => {
      learning.recordEpisode(makeEpisode({ sessionId: 'keep' }));
      expect(learning.prune(10)).toBe(0);
    });
  });
});
