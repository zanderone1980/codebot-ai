import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { RiskScorer } from './risk';

describe('RiskScorer', () => {
  // ── Permission Level Factor ──

  it('scores auto-approved tools as low risk', () => {
    const scorer = new RiskScorer();
    const result = scorer.assess('read_file', { path: 'src/index.ts' }, 'auto');
    assert.ok(result.score <= 25, `Expected green, got ${result.score}`);
    assert.strictEqual(result.level, 'green');
  });

  it('scores always-ask tools higher', () => {
    const scorer = new RiskScorer();
    const result = scorer.assess('execute', { command: 'ls' }, 'always-ask');
    assert.ok(result.score > 25, `Expected > 25, got ${result.score}`);
  });

  it('scores prompt tools in the middle', () => {
    const scorer = new RiskScorer();
    const result = scorer.assess('write_file', { path: 'src/test.ts', content: 'hello' }, 'prompt');
    const permFactor = result.factors.find(f => f.name === 'permission_level');
    assert.ok(permFactor);
    assert.strictEqual(permFactor.rawScore, 50);
  });

  // ── File Path Sensitivity ──

  it('flags .env files as high risk', () => {
    const scorer = new RiskScorer();
    const result = scorer.assess('write_file', { path: '.env' }, 'auto');
    const pathFactor = result.factors.find(f => f.name === 'file_path');
    assert.ok(pathFactor);
    assert.strictEqual(pathFactor.rawScore, 100);
  });

  it('flags credentials files as high risk', () => {
    const scorer = new RiskScorer();
    const result = scorer.assess('read_file', { path: '/home/user/.ssh/id_rsa' }, 'auto');
    const pathFactor = result.factors.find(f => f.name === 'file_path');
    assert.ok(pathFactor);
    assert.strictEqual(pathFactor.rawScore, 100);
  });

  it('flags .env.local as sensitive', () => {
    const scorer = new RiskScorer();
    const result = scorer.assess('write_file', { path: '.env.local' }, 'auto');
    const pathFactor = result.factors.find(f => f.name === 'file_path');
    assert.ok(pathFactor);
    assert.strictEqual(pathFactor.rawScore, 100);
  });

  it('scores config files as moderate risk', () => {
    const scorer = new RiskScorer();
    const result = scorer.assess('edit_file', { path: 'tsconfig.json' }, 'auto');
    const pathFactor = result.factors.find(f => f.name === 'file_path');
    assert.ok(pathFactor);
    assert.strictEqual(pathFactor.rawScore, 40);
  });

  it('scores project source files as low risk', () => {
    const scorer = new RiskScorer();
    const result = scorer.assess('write_file', { path: 'src/utils.ts', content: 'code' }, 'auto');
    const pathFactor = result.factors.find(f => f.name === 'file_path');
    assert.ok(pathFactor);
    assert.strictEqual(pathFactor.rawScore, 10);
  });

  it('scores zero path when no file involved', () => {
    const scorer = new RiskScorer();
    const result = scorer.assess('execute', { command: 'ls' }, 'auto');
    const pathFactor = result.factors.find(f => f.name === 'file_path');
    assert.ok(pathFactor);
    assert.strictEqual(pathFactor.rawScore, 0);
  });

  // ── Command Destructiveness ──

  it('scores rm -rf as destructive', () => {
    const scorer = new RiskScorer();
    const result = scorer.assess('execute', { command: 'rm -rf /tmp/build' }, 'auto');
    const cmdFactor = result.factors.find(f => f.name === 'command');
    assert.ok(cmdFactor);
    assert.strictEqual(cmdFactor.rawScore, 100);
  });

  it('scores git push --force as destructive', () => {
    const scorer = new RiskScorer();
    const result = scorer.assess('execute', { command: 'git push origin main --force' }, 'auto');
    const cmdFactor = result.factors.find(f => f.name === 'command');
    assert.ok(cmdFactor);
    assert.strictEqual(cmdFactor.rawScore, 100);
  });

  it('scores npm install as moderate', () => {
    const scorer = new RiskScorer();
    const result = scorer.assess('execute', { command: 'npm install express' }, 'auto');
    const cmdFactor = result.factors.find(f => f.name === 'command');
    assert.ok(cmdFactor);
    assert.strictEqual(cmdFactor.rawScore, 50);
  });

  it('scores npm test as safe', () => {
    const scorer = new RiskScorer();
    const result = scorer.assess('execute', { command: 'npm test' }, 'auto');
    const cmdFactor = result.factors.find(f => f.name === 'command');
    assert.ok(cmdFactor);
    assert.strictEqual(cmdFactor.rawScore, 5);
  });

  it('scores git status as safe', () => {
    const scorer = new RiskScorer();
    const result = scorer.assess('execute', { command: 'git status' }, 'auto');
    const cmdFactor = result.factors.find(f => f.name === 'command');
    assert.ok(cmdFactor);
    assert.strictEqual(cmdFactor.rawScore, 5);
  });

  it('scores non-execute tools as zero command risk', () => {
    const scorer = new RiskScorer();
    const result = scorer.assess('read_file', { path: 'src/test.ts' }, 'auto');
    const cmdFactor = result.factors.find(f => f.name === 'command');
    assert.ok(cmdFactor);
    assert.strictEqual(cmdFactor.rawScore, 0);
  });

  // ── Network Access ──

  it('flags web_fetch as network risk', () => {
    const scorer = new RiskScorer();
    const result = scorer.assess('web_fetch', { url: 'https://example.com' }, 'auto');
    const netFactor = result.factors.find(f => f.name === 'network');
    assert.ok(netFactor);
    assert.strictEqual(netFactor.rawScore, 70);
  });

  it('flags browser as network risk', () => {
    const scorer = new RiskScorer();
    const result = scorer.assess('browser', { action: 'navigate', url: 'https://google.com' }, 'auto');
    const netFactor = result.factors.find(f => f.name === 'network');
    assert.ok(netFactor);
    assert.strictEqual(netFactor.rawScore, 70);
  });

  it('scores non-network tools as zero', () => {
    const scorer = new RiskScorer();
    const result = scorer.assess('read_file', { path: 'test.txt' }, 'auto');
    const netFactor = result.factors.find(f => f.name === 'network');
    assert.ok(netFactor);
    assert.strictEqual(netFactor.rawScore, 0);
  });

  // ── Data Volume ──

  it('flags large payloads', () => {
    const scorer = new RiskScorer();
    const bigContent = 'x'.repeat(15000);
    const result = scorer.assess('write_file', { path: 'big.txt', content: bigContent }, 'auto');
    const volFactor = result.factors.find(f => f.name === 'data_volume');
    assert.ok(volFactor);
    assert.strictEqual(volFactor.rawScore, 90);
  });

  it('flags pipes in commands', () => {
    const scorer = new RiskScorer();
    const result = scorer.assess('execute', { command: 'cat file | grep pattern' }, 'auto');
    const volFactor = result.factors.find(f => f.name === 'data_volume');
    assert.ok(volFactor);
    assert.strictEqual(volFactor.rawScore, 50);
  });

  // ── Cumulative Session Risk ──

  it('first call has zero cumulative risk', () => {
    const scorer = new RiskScorer();
    const result = scorer.assess('read_file', { path: 'test.ts' }, 'auto');
    const cumFactor = result.factors.find(f => f.name === 'cumulative');
    assert.ok(cumFactor);
    assert.strictEqual(cumFactor.rawScore, 0);
  });

  it('cumulative risk increases after many high-risk calls', () => {
    const scorer = new RiskScorer();
    // Generate high-risk history
    for (let i = 0; i < 10; i++) {
      scorer.assess('execute', { command: 'rm -rf /tmp/test' }, 'always-ask');
    }
    const result = scorer.assess('read_file', { path: 'safe.ts' }, 'auto');
    const cumFactor = result.factors.find(f => f.name === 'cumulative');
    assert.ok(cumFactor);
    assert.ok(cumFactor.rawScore > 0, 'Cumulative risk should be positive after high-risk calls');
  });

  // ── Overall Score and Level ──

  it('caps score at 100', () => {
    const scorer = new RiskScorer();
    const result = scorer.assess('execute', { command: 'rm -rf /', content: 'x'.repeat(20000) }, 'always-ask');
    assert.ok(result.score <= 100);
  });

  it('returns green for low-risk operations', () => {
    const scorer = new RiskScorer();
    const result = scorer.assess('read_file', { path: 'src/index.ts' }, 'auto');
    assert.strictEqual(result.level, 'green');
  });

  // ── History ──

  it('tracks assessment history', () => {
    const scorer = new RiskScorer();
    scorer.assess('read_file', { path: 'test.ts' }, 'auto');
    scorer.assess('write_file', { path: 'out.ts', content: 'hello' }, 'prompt');
    assert.strictEqual(scorer.getHistory().length, 2);
  });

  it('calculates session average', () => {
    const scorer = new RiskScorer();
    scorer.assess('read_file', { path: 'test.ts' }, 'auto');
    scorer.assess('read_file', { path: 'test2.ts' }, 'auto');
    const avg = scorer.getSessionAverage();
    assert.ok(typeof avg === 'number');
    assert.ok(avg >= 0 && avg <= 100);
  });

  it('returns zero average for empty history', () => {
    const scorer = new RiskScorer();
    assert.strictEqual(scorer.getSessionAverage(), 0);
  });

  // ── Format Indicator ──

  it('formatIndicator returns colored string', () => {
    const scorer = new RiskScorer();
    const result = scorer.assess('read_file', { path: 'test.ts' }, 'auto');
    const indicator = RiskScorer.formatIndicator(result);
    assert.ok(indicator.includes('[Risk:'));
    assert.ok(indicator.includes(String(result.score)));
    assert.ok(indicator.includes(result.level));
  });

  // ── Fail-safe ──

  it('returns valid assessment on all factor types', () => {
    const scorer = new RiskScorer();
    const result = scorer.assess('read_file', {}, 'auto');
    assert.ok(result.factors.length === 6);
    for (const f of result.factors) {
      assert.ok(typeof f.name === 'string');
      assert.ok(typeof f.weight === 'number');
      assert.ok(typeof f.rawScore === 'number');
      assert.ok(typeof f.weighted === 'number');
      assert.ok(typeof f.reason === 'string');
    }
  });
});
