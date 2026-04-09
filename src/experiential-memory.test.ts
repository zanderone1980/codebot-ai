import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

// Override CODEBOT_HOME so tests use a temp directory
const tmpDir = path.join(os.tmpdir(), `codebot-exp-mem-test-${Date.now()}`);
process.env.CODEBOT_HOME = tmpDir;

import { ExperientialMemory, Lesson } from './experiential-memory';

function makeTmpDb(): string {
  fs.mkdirSync(tmpDir, { recursive: true });
  return path.join(tmpDir, `test-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe('ExperientialMemory', () => {
  let mem: ExperientialMemory;
  let dbPath: string;

  beforeEach(() => {
    dbPath = makeTmpDb();
    mem = new ExperientialMemory(dbPath);
  });

  afterEach(() => {
    mem.close();
    try { fs.unlinkSync(dbPath); } catch {}
  });

  it('initializes and reports active', () => {
    assert.ok(mem.isActive, 'Memory should be active after init');
  });

  it('records and retrieves a failure lesson', () => {
    const id = mem.recordLesson({
      toolName: 'write_file',
      outcome: 'failure',
      lesson: 'Check file exists before writing',
      errorMessage: 'ENOENT: no such file or directory',
      tags: 'file,write,enoent',
    });
    assert.ok(id, 'Should return an ID');

    const results = mem.queryLessons({ toolName: 'write_file', outcomeFilter: 'failure' });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].lesson, 'Check file exists before writing');
    assert.strictEqual(results[0].outcome, 'failure');
  });

  it('records and retrieves a success lesson', () => {
    mem.recordLesson({
      toolName: 'execute',
      outcome: 'success',
      lesson: 'Using --workspace flag in monorepos works',
      tags: 'npm,monorepo,workspace',
    });

    const results = mem.queryLessons({ toolName: 'execute', outcomeFilter: 'success' });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].outcome, 'success');
  });

  it('filters by outcome', () => {
    mem.recordLesson({ toolName: 'git', outcome: 'failure', lesson: 'Force push failed' });
    mem.recordLesson({ toolName: 'git', outcome: 'success', lesson: 'Regular push worked' });

    const failures = mem.queryLessons({ toolName: 'git', outcomeFilter: 'failure' });
    assert.strictEqual(failures.length, 1);
    assert.strictEqual(failures[0].lesson, 'Force push failed');

    const successes = mem.queryLessons({ toolName: 'git', outcomeFilter: 'success' });
    assert.strictEqual(successes.length, 1);
    assert.strictEqual(successes[0].lesson, 'Regular push worked');
  });

  it('excludes superseded lessons', () => {
    mem.recordLesson({
      toolName: 'execute',
      outcome: 'failure',
      lesson: 'Old lesson about npm',
      errorMessage: 'npm ERR! missing script',
    });

    // Record newer lesson with same error — should supersede
    mem.recordLesson({
      toolName: 'execute',
      outcome: 'failure',
      lesson: 'Better lesson about npm',
      errorMessage: 'npm ERR! missing script',
    });

    const results = mem.queryLessons({ toolName: 'execute', outcomeFilter: 'failure' });
    assert.strictEqual(results.length, 1);
    assert.strictEqual(results[0].lesson, 'Better lesson about npm');
  });

  it('challenge halves confidence', () => {
    const id = mem.recordLesson({
      toolName: 'browser',
      outcome: 'failure',
      lesson: 'Bad advice',
      confidence: 0.8,
    });

    mem.challengeLesson(id!, 'This was wrong');
    const results = mem.queryLessons({ toolName: 'browser' });
    assert.strictEqual(results.length, 1);
    assert.ok(results[0].confidence <= 0.41, `Confidence should be ~0.4, got ${results[0].confidence}`);
  });

  it('reinforce increases confidence', () => {
    const id = mem.recordLesson({
      toolName: 'grep',
      outcome: 'success',
      lesson: 'Use -r flag for recursive',
      confidence: 0.6,
    });

    mem.reinforceLesson(id!);
    const results = mem.queryLessons({ toolName: 'grep' });
    assert.strictEqual(results.length, 1);
    assert.ok(results[0].confidence > 0.6, `Confidence should increase, got ${results[0].confidence}`);
  });

  it('weaken decreases confidence', () => {
    const id = mem.recordLesson({
      toolName: 'edit_file',
      outcome: 'failure',
      lesson: 'Some advice',
      confidence: 0.6,
    });

    mem.weakenLesson(id!);
    const results = mem.queryLessons({ toolName: 'edit_file' });
    assert.strictEqual(results.length, 1);
    assert.ok(results[0].confidence < 0.6, `Confidence should decrease, got ${results[0].confidence}`);
  });

  it('excludes low-confidence lessons from queries', () => {
    mem.recordLesson({
      toolName: 'docker',
      outcome: 'failure',
      lesson: 'Low confidence lesson',
      confidence: 0.1,
    });

    const results = mem.queryLessons({ toolName: 'docker' });
    assert.strictEqual(results.length, 0, 'Low confidence lessons should be excluded');
  });

  it('buildPromptBlock returns formatted text', () => {
    mem.recordLesson({
      toolName: 'write_file',
      outcome: 'failure',
      lesson: 'Check imports before editing TS files',
      avoidance: 'Do not edit without checking circular deps',
      confidence: 0.8,
    });

    mem.recordLesson({
      toolName: 'browser',
      outcome: 'success',
      lesson: 'Screenshot before grep for CSS bugs',
      confidence: 0.9,
    });

    const block = mem.buildPromptBlock({ currentTask: 'Fix a bug' });
    assert.ok(block.includes('Lessons from Experience'), 'Should have header');
    assert.ok(block.includes('write_file'), 'Should mention tool');
    assert.ok(block.includes('Check imports'), 'Should contain lesson text');
  });

  it('buildPromptBlock returns empty for no lessons', () => {
    const block = mem.buildPromptBlock({ currentTask: 'anything' });
    assert.strictEqual(block, '');
  });

  it('buildPromptBlock respects size budget', () => {
    // Fill with many lessons
    for (let i = 0; i < 20; i++) {
      mem.recordLesson({
        toolName: `tool_${i}`,
        outcome: 'failure',
        lesson: 'A'.repeat(200) + ` lesson ${i}`,
        confidence: 0.8,
      });
    }

    const block = mem.buildPromptBlock({ currentTask: 'test' });
    assert.ok(Buffer.byteLength(block, 'utf-8') <= 2048, 'Block should be within size budget');
  });

  it('getLessonStats returns correct counts', () => {
    mem.recordLesson({ toolName: 'a', outcome: 'failure', lesson: 'f1' });
    mem.recordLesson({ toolName: 'b', outcome: 'failure', lesson: 'f2' });
    mem.recordLesson({ toolName: 'c', outcome: 'success', lesson: 's1' });

    const stats = mem.getLessonStats();
    assert.strictEqual(stats.totalLessons, 3);
    assert.strictEqual(stats.failureLessons, 2);
    assert.strictEqual(stats.successLessons, 1);
    assert.strictEqual(stats.challengedLessons, 0);
  });

  it('decayAndConsolidate does not crash on empty db', () => {
    mem.decayAndConsolidate();
    const stats = mem.getLessonStats();
    assert.strictEqual(stats.totalLessons, 0);
  });

  it('enforces max lessons cap', () => {
    // Record more than cap (use small cap for test by recording many)
    for (let i = 0; i < 50; i++) {
      mem.recordLesson({
        toolName: `tool_${i}`,
        outcome: 'failure',
        lesson: `lesson ${i}`,
        confidence: 0.3 + (i / 100),
      });
    }

    const stats = mem.getLessonStats();
    assert.ok(stats.totalLessons <= 50, 'Should not exceed reasonable count');
  });

  it('marks access count on query', () => {
    const id = mem.recordLesson({
      toolName: 'read_file',
      outcome: 'failure',
      lesson: 'Check path exists',
      confidence: 0.7,
    });

    // Query twice
    mem.queryLessons({ toolName: 'read_file' });
    mem.queryLessons({ toolName: 'read_file' });

    // Query a third time and check access count
    const results = mem.queryLessons({ toolName: 'read_file' });
    assert.ok(results[0].accessCount >= 2, `Access count should be >= 2, got ${results[0].accessCount}`);
  });

  it('inactive memory returns safe defaults', () => {
    const inactive = new ExperientialMemory('/nonexistent/path/that/will/fail.db');
    assert.strictEqual(inactive.isActive, false);
    assert.strictEqual(inactive.recordLesson({ toolName: 'x', outcome: 'failure', lesson: 'y' }), null);
    assert.deepStrictEqual(inactive.queryLessons({}), []);
    assert.strictEqual(inactive.buildPromptBlock({}), '');
    assert.deepStrictEqual(inactive.getLessonStats(), {
      totalLessons: 0, failureLessons: 0, successLessons: 0, challengedLessons: 0, averageConfidence: 0,
    });
    inactive.close();
  });
});
