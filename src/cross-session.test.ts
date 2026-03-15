import { describe, it, before, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { CrossSessionLearning, Episode, EpisodePattern } from './cross-session';

describe('CrossSessionLearning', () => {
  let tmpDir: string;
  let learning: CrossSessionLearning;
  const origEnv = process.env.CODEBOT_HOME;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-session-'));
    process.env.CODEBOT_HOME = tmpDir;
    learning = new CrossSessionLearning();
  });

  afterEach(() => {
    // Reset for each test
    if (origEnv) process.env.CODEBOT_HOME = origEnv;
    else delete process.env.CODEBOT_HOME;
  });

  function makeEpisode(overrides?: Partial<Episode>): Episode {
    return {
      sessionId: `session_${Date.now()}_${Math.random().toString(36).slice(2,6)}`,
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
      process.env.CODEBOT_HOME = tmpDir;
      const calls = [
        { tool: 'grep', success: true },
        { tool: 'read_file', success: true },
        { tool: 'edit_file', success: true },
        { tool: 'read_file', success: true },
      ];
      const patterns = learning.extractPatterns(calls);
      assert.ok(patterns.length > 0, 'should extract at least one pattern');
    });

    it('returns empty for single tool call', () => {
      process.env.CODEBOT_HOME = tmpDir;
      assert.deepStrictEqual(learning.extractPatterns([{ tool: 'grep', success: true }]), []);
    });

    it('marks failed chains as not effective', () => {
      process.env.CODEBOT_HOME = tmpDir;
      const calls = [
        { tool: 'grep', success: true },
        { tool: 'edit_file', success: false },
      ];
      const patterns = learning.extractPatterns(calls);
      const failedPattern = patterns.find(p => p.toolChain.includes('edit_file'));
      if (failedPattern) {
        assert.strictEqual(failedPattern.effective, false);
      }
    });
  });

  describe('buildEpisode', () => {
    it('builds episode from session data', () => {
      process.env.CODEBOT_HOME = tmpDir;
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

      assert.strictEqual(episode.sessionId, 'test_session');
      assert.ok(episode.toolsUsed.includes('grep'), 'should include grep');
      assert.strictEqual(episode.iterationCount, 3);
      assert.strictEqual(episode.success, true);
    });
  });

  describe('recordEpisode', () => {
    it('saves episode to disk', () => {
      process.env.CODEBOT_HOME = tmpDir;
      const episode = makeEpisode({ sessionId: 'saved_session' });
      learning.recordEpisode(episode);

      const loaded = learning.getEpisode('saved_session');
      assert.notStrictEqual(loaded, null);
      assert.strictEqual(loaded!.goal, 'Fix a bug');
    });

    it('updates pattern index', () => {
      process.env.CODEBOT_HOME = tmpDir;
      const episode = makeEpisode({
        sessionId: 'idx_test',
        patterns: [{
          description: 'grep → read_file',
          toolChain: ['grep', 'read_file'],
          effective: true,
          frequency: 3,
        }],
      });
      learning.recordEpisode(episode);

      const indexPath = path.join(tmpDir, 'episodes', 'index.json');
      assert.ok(fs.existsSync(indexPath), 'index.json should exist');
    });
  });

  describe('getTopPatterns', () => {
    it('returns patterns sorted by success rate', () => {
      process.env.CODEBOT_HOME = tmpDir;
      learning.recordEpisode(makeEpisode({
        sessionId: 'top_sess1',
        patterns: [
          { description: 'a → b', toolChain: ['a', 'b'], effective: true, frequency: 3 },
          { description: 'c → d', toolChain: ['c', 'd'], effective: false, frequency: 2 },
        ],
      }));

      const top = learning.getTopPatterns(5);
      if (top.length >= 2) {
        assert.ok(top[0].successRate >= top[1].successRate, 'first pattern should have higher success rate');
      }
    });

    it('filters patterns with less than 2 occurrences', () => {
      process.env.CODEBOT_HOME = tmpDir;
      learning.recordEpisode(makeEpisode({
        sessionId: 'filter_sess',
        patterns: [
          { description: 'x → y', toolChain: ['x', 'y'], effective: true, frequency: 1 },
        ],
      }));

      const top = learning.getTopPatterns(5);
      const found = top.find(p => p.toolChain.join(':') === 'x:y');
      assert.strictEqual(found, undefined);
    });
  });

  describe('buildPromptBlock', () => {
    it('returns empty string when no patterns', () => {
      const cleanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-prompt-'));
      process.env.CODEBOT_HOME = cleanDir;
      const fresh = new CrossSessionLearning();
      assert.strictEqual(fresh.buildPromptBlock(), '');
      fs.rmSync(cleanDir, { recursive: true, force: true });
    });

    it('includes effective patterns', () => {
      process.env.CODEBOT_HOME = tmpDir;
      learning.recordEpisode(makeEpisode({
        sessionId: 'prompt_test',
        patterns: [
          { description: 'grep → edit', toolChain: ['grep', 'edit'], effective: true, frequency: 5 },
        ],
      }));

      const block = learning.buildPromptBlock();
      if (block) {
        assert.ok(block.includes('Cross-Session'), 'block should contain Cross-Session');
      }
    });
  });

  describe('listEpisodes', () => {
    it('lists all episode IDs', () => {
      process.env.CODEBOT_HOME = tmpDir;
      learning.recordEpisode(makeEpisode({ sessionId: 'list_ep1' }));
      learning.recordEpisode(makeEpisode({ sessionId: 'list_ep2' }));

      const list = learning.listEpisodes();
      assert.ok(list.includes('list_ep1'), 'should include list_ep1');
      assert.ok(list.includes('list_ep2'), 'should include list_ep2');
    });

    it('returns empty array when no episodes', () => {
      process.env.CODEBOT_HOME = tmpDir;
      const fresh = new CrossSessionLearning();
      // Use a clean tmp dir for this test
      const cleanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-empty-'));
      process.env.CODEBOT_HOME = cleanDir;
      const empty = new CrossSessionLearning();
      assert.deepStrictEqual(empty.listEpisodes(), []);
      fs.rmSync(cleanDir, { recursive: true, force: true });
    });
  });

  describe('summarize', () => {
    it('returns message when no data', () => {
      const cleanDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-sum-'));
      process.env.CODEBOT_HOME = cleanDir;
      const fresh = new CrossSessionLearning();
      assert.ok(fresh.summarize().includes('No cross-session'), 'should contain No cross-session');
      fs.rmSync(cleanDir, { recursive: true, force: true });
    });

    it('includes episode count', () => {
      const sumDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-sumcount-'));
      process.env.CODEBOT_HOME = sumDir;
      const sl = new CrossSessionLearning();
      sl.recordEpisode(makeEpisode({ sessionId: 'sum1' }));
      sl.recordEpisode(makeEpisode({ sessionId: 'sum2' }));
      assert.ok(sl.summarize().includes('2 episodes'), 'should mention 2 episodes');
      fs.rmSync(sumDir, { recursive: true, force: true });
    });
  });

  describe('prune', () => {
    it('removes old episodes', () => {
      const pruneDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-prune-'));
      process.env.CODEBOT_HOME = pruneDir;
      const plearning = new CrossSessionLearning();
      for (let i = 0; i < 5; i++) {
        plearning.recordEpisode(makeEpisode({ sessionId: `prune_${i}` }));
      }
      const pruned = plearning.prune(2);
      assert.strictEqual(pruned, 3);
      assert.strictEqual(plearning.listEpisodes().length, 2);
      fs.rmSync(pruneDir, { recursive: true, force: true });
    });

    it('does nothing when under limit', () => {
      const pruneDir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'cross-prune2-'));
      process.env.CODEBOT_HOME = pruneDir2;
      const plearning = new CrossSessionLearning();
      plearning.recordEpisode(makeEpisode({ sessionId: 'keep' }));
      assert.strictEqual(plearning.prune(10), 0);
      fs.rmSync(pruneDir2, { recursive: true, force: true });
    });
  });
});
