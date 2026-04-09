import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import {
  extractLessonFromFailure,
  extractLessonFromSuccess,
  shouldRecordSuccess,
  buildTags,
} from './lesson-extractor';

describe('extractLessonFromFailure', () => {
  it('extracts ENOENT lesson', () => {
    const lesson = extractLessonFromFailure(
      'write_file',
      { path: '/tmp/test.ts' },
      "ENOENT: no such file or directory, open '/tmp/test.ts'",
      'Fix the auth bug',
    );
    assert.strictEqual(lesson.outcome, 'failure');
    assert.ok(lesson.lesson.includes('/tmp/test.ts'), 'Should mention the file path');
    assert.ok(lesson.tags?.includes('enoent'), 'Should tag as enoent');
  });

  it('extracts EACCES lesson', () => {
    const lesson = extractLessonFromFailure(
      'write_file',
      { path: '/etc/hosts' },
      "EACCES: permission denied, open '/etc/hosts'",
      'Update hosts file',
    );
    assert.ok(lesson.lesson.includes('Permission denied'));
    assert.ok(lesson.tags?.includes('permission'));
  });

  it('extracts timeout lesson', () => {
    const lesson = extractLessonFromFailure(
      'execute',
      { command: 'npm run build' },
      'Command timed out after 30000ms',
      'Build the project',
    );
    assert.ok(lesson.lesson.includes('timed out'));
    assert.ok(lesson.tags?.includes('timeout'));
  });

  it('extracts npm missing script lesson', () => {
    const lesson = extractLessonFromFailure(
      'execute',
      { command: 'npm run deploy' },
      'npm ERR! missing script: "deploy"',
      'Deploy the app',
    );
    assert.ok(lesson.lesson.includes('deploy'));
    assert.ok(lesson.tags?.includes('npm'));
  });

  it('extracts test failure lesson', () => {
    const lesson = extractLessonFromFailure(
      'execute',
      { command: 'npm test' },
      'FAIL src/agent.test.ts\n  Test suite failed to run',
      'Run tests',
    );
    assert.ok(lesson.tags?.includes('test'));
  });

  it('extracts TypeScript error lesson', () => {
    const lesson = extractLessonFromFailure(
      'execute',
      { command: 'npx tsc' },
      'error TS2345: Argument of type string is not assignable',
      'Compile TypeScript',
    );
    assert.ok(lesson.tags?.includes('typescript'));
  });

  it('extracts module not found lesson', () => {
    const lesson = extractLessonFromFailure(
      'execute',
      { command: 'node dist/index.js' },
      "Cannot find module 'express'",
      'Start server',
    );
    assert.ok(lesson.lesson.includes('express'));
    assert.ok(lesson.tags?.includes('module'));
  });

  it('extracts command not found lesson', () => {
    const lesson = extractLessonFromFailure(
      'execute',
      { command: 'cargo build' },
      'cargo: command not found',
      'Build Rust project',
    );
    assert.ok(lesson.lesson.includes('cargo'));
    assert.ok(lesson.tags?.includes('command'));
  });

  it('handles unknown errors with generic lesson', () => {
    const lesson = extractLessonFromFailure(
      'browser',
      { action: 'navigate', url: 'http://localhost:3000' },
      'Some completely unknown error happened',
      'Navigate to app',
    );
    assert.strictEqual(lesson.outcome, 'failure');
    assert.ok(lesson.lesson.length > 0, 'Should produce a lesson');
    assert.strictEqual(lesson.confidence, 0.5);
  });

  it('truncates long error messages', () => {
    const longError = 'x'.repeat(1000);
    const lesson = extractLessonFromFailure('execute', {}, longError, 'test');
    assert.ok((lesson.errorMessage?.length || 0) <= 500);
  });

  it('truncates long task descriptions', () => {
    const longTask = 'y'.repeat(500);
    const lesson = extractLessonFromFailure('execute', {}, 'error', longTask);
    assert.ok((lesson.taskDescription?.length || 0) <= 200);
  });
});

describe('extractLessonFromSuccess', () => {
  it('records write_file success', () => {
    const lesson = extractLessonFromSuccess(
      'write_file',
      { path: 'src/index.ts' },
      'File written successfully',
      'Create entry point',
    );
    assert.ok(lesson, 'Should record write success');
    assert.strictEqual(lesson!.outcome, 'success');
    assert.strictEqual(lesson!.confidence, 0.4);
  });

  it('records execute test success', () => {
    const lesson = extractLessonFromSuccess(
      'execute',
      { command: 'npm test' },
      'All tests passed',
      'Run tests',
    );
    assert.ok(lesson, 'Should record test success');
  });

  it('skips trivial read_file success', () => {
    const lesson = extractLessonFromSuccess(
      'read_file',
      { path: 'README.md' },
      'file contents...',
      'Read readme',
    );
    assert.strictEqual(lesson, null, 'Should not record trivial read');
  });

  it('skips trivial grep success', () => {
    const lesson = extractLessonFromSuccess(
      'grep',
      { pattern: 'TODO' },
      'matches found',
      'Search for todos',
    );
    assert.strictEqual(lesson, null);
  });

  it('records git success', () => {
    const lesson = extractLessonFromSuccess(
      'git',
      { action: 'commit', message: 'fix: resolve auth bug' },
      'Committed successfully',
      'Commit the fix',
    );
    assert.ok(lesson);
    assert.strictEqual(lesson!.outcome, 'success');
  });
});

describe('shouldRecordSuccess', () => {
  it('returns false for read-only tools', () => {
    assert.strictEqual(shouldRecordSuccess('read_file', {}, ''), false);
    assert.strictEqual(shouldRecordSuccess('grep', {}, ''), false);
    assert.strictEqual(shouldRecordSuccess('glob', {}, ''), false);
    assert.strictEqual(shouldRecordSuccess('think', {}, ''), false);
  });

  it('returns true for write tools', () => {
    assert.strictEqual(shouldRecordSuccess('write_file', {}, ''), true);
    assert.strictEqual(shouldRecordSuccess('edit_file', {}, ''), true);
    assert.strictEqual(shouldRecordSuccess('batch_edit', {}, ''), true);
  });

  it('returns true for test/build executions', () => {
    assert.strictEqual(shouldRecordSuccess('execute', { command: 'npm test' }, ''), true);
    assert.strictEqual(shouldRecordSuccess('execute', { command: 'npm run build' }, ''), true);
  });

  it('returns false for generic execute', () => {
    assert.strictEqual(shouldRecordSuccess('execute', { command: 'ls -la' }, ''), false);
  });

  it('returns true for git and docker', () => {
    assert.strictEqual(shouldRecordSuccess('git', {}, ''), true);
    assert.strictEqual(shouldRecordSuccess('docker', {}, ''), true);
  });
});

describe('buildTags', () => {
  it('includes tool name', () => {
    const tags = buildTags('write_file', {}, '');
    assert.ok(tags.includes('write_file'));
  });

  it('extracts file extension', () => {
    const tags = buildTags('edit_file', { path: 'src/agent.ts' }, '');
    assert.ok(tags.includes('ts'));
  });

  it('extracts command name', () => {
    const tags = buildTags('execute', { command: 'npm run build' }, '');
    assert.ok(tags.includes('npm'));
  });

  it('extracts error keywords', () => {
    const tags = buildTags('execute', {}, 'ENOENT: no such file');
    assert.ok(tags.includes('enoent'));
  });

  it('extracts directory context', () => {
    const tags = buildTags('write_file', { path: 'src/tools/memory.ts' }, '');
    assert.ok(tags.includes('tools'));
  });
});
