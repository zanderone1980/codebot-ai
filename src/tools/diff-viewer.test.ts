import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DiffViewerTool } from './diff-viewer';

describe('DiffViewerTool', () => {
  let tool: DiffViewerTool;
  let tmpDir: string;

  before(() => {
    tool = new DiffViewerTool();
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'diff-viewer-test-'));
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should have correct tool metadata', () => {
    assert.strictEqual(tool.name, 'diff_viewer');
    assert.strictEqual(tool.permission, 'auto');
  });

  it('should return error when action is missing', async () => {
    const result = await tool.execute({ action: '' });
    assert.strictEqual(result, 'Error: action is required');
  });

  it('should return error for unknown action', async () => {
    const result = await tool.execute({ action: 'foobar' });
    assert.match(result, /Error: unknown action "foobar"/);
    assert.match(result, /files, git_diff, staged, commit/);
  });

  it('should return error when file_a or file_b missing for files action', async () => {
    const result = await tool.execute({ action: 'files' });
    assert.strictEqual(result, 'Error: file_a and file_b are required');

    const result2 = await tool.execute({ action: 'files', file_a: '/tmp/a' });
    assert.strictEqual(result2, 'Error: file_a and file_b are required');
  });

  it('should return error when file_a cannot be read', async () => {
    const result = await tool.execute({
      action: 'files',
      file_a: '/nonexistent/file_a.txt',
      file_b: '/nonexistent/file_b.txt',
    });
    assert.match(result, /Error: cannot read/);
  });

  it('should return error when file_b cannot be read', async () => {
    const fileA = path.join(tmpDir, 'exist_a.txt');
    fs.writeFileSync(fileA, 'hello');

    const result = await tool.execute({
      action: 'files',
      file_a: fileA,
      file_b: '/nonexistent/file_b.txt',
    });
    assert.match(result, /Error: cannot read/);
  });

  it('should report identical files', async () => {
    const fileA = path.join(tmpDir, 'same_a.txt');
    const fileB = path.join(tmpDir, 'same_b.txt');
    fs.writeFileSync(fileA, 'line1\nline2\nline3');
    fs.writeFileSync(fileB, 'line1\nline2\nline3');

    const result = await tool.execute({ action: 'files', file_a: fileA, file_b: fileB });
    assert.strictEqual(result, 'Files are identical.');
  });

  it('should show line-by-line diff for different files', async () => {
    const fileA = path.join(tmpDir, 'diff_a.txt');
    const fileB = path.join(tmpDir, 'diff_b.txt');
    fs.writeFileSync(fileA, 'line1\nline2\nline3');
    fs.writeFileSync(fileB, 'line1\nchanged\nline3');

    const result = await tool.execute({ action: 'files', file_a: fileA, file_b: fileB });
    assert.match(result, /1 line\(s\) differ/);
    assert.match(result, /-2: line2/);
    assert.match(result, /\+2: changed/);
  });

  it('should handle files with different number of lines', async () => {
    const fileA = path.join(tmpDir, 'short.txt');
    const fileB = path.join(tmpDir, 'long.txt');
    fs.writeFileSync(fileA, 'only');
    fs.writeFileSync(fileB, 'only\nextra');

    const result = await tool.execute({ action: 'files', file_a: fileA, file_b: fileB });
    assert.match(result, /1 line\(s\) differ/);
    assert.match(result, /\+2: extra/);
  });

  it('should require ref for commit action', async () => {
    const result = await tool.execute({ action: 'commit' });
    assert.strictEqual(result, 'Error: ref (commit hash) is required');
  });

  it('should reject invalid ref format', async () => {
    const result = await tool.execute({ action: 'commit', ref: 'abc;rm -rf /' });
    assert.strictEqual(result, 'Error: invalid ref format');
  });

  it('should accept valid ref format characters', async () => {
    // This will fail because we're not in a git repo, but it should NOT fail on format validation
    const result = await tool.execute({ action: 'commit', ref: 'HEAD~1' });
    // Should get a git error, not a format error
    assert.ok(!result.startsWith('Error: invalid ref format'));
  });
});
