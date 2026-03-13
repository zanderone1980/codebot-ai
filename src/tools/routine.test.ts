import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { RoutineTool, matchesCron } from './routine';

describe('RoutineTool', () => {
  let tool: RoutineTool;
  let origRoutinesFile: string;
  let tmpDir: string;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'routine-test-'));
    // Redirect all codebotPath() calls to a temp directory for test isolation
    process.env.CODEBOT_HOME = tmpDir;
    tool = new RoutineTool();
    origRoutinesFile = path.join(tmpDir, 'routines.json');
  });

  after(() => {
    delete process.env.CODEBOT_HOME;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('should have correct tool metadata', () => {
    assert.strictEqual(tool.name, 'routine');
    assert.strictEqual(tool.permission, 'auto');
  });

  it('should return unknown action error', async () => {
    const result = await tool.execute({ action: 'foobar' });
    assert.match(result, /Unknown action: foobar/);
    assert.match(result, /list, add, remove, enable, disable/);
  });

  it('should list routines (empty or existing)', async () => {
    const result = await tool.execute({ action: 'list' });
    // Either "No routines configured" or a list of routines
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
  });

  it('should return error when adding without name', async () => {
    const result = await tool.execute({
      action: 'add',
      prompt: 'do something',
      schedule: '0 9 * * *',
    });
    assert.strictEqual(result, 'Error: name is required');
  });

  it('should return error when adding without prompt', async () => {
    const result = await tool.execute({
      action: 'add',
      name: 'test-routine',
      schedule: '0 9 * * *',
    });
    assert.strictEqual(result, 'Error: prompt is required (the task to execute)');
  });

  it('should return error when adding without schedule', async () => {
    const result = await tool.execute({
      action: 'add',
      name: 'test-routine',
      prompt: 'do something',
    });
    assert.strictEqual(result, 'Error: schedule is required (cron expression)');
  });

  it('should reject invalid cron expression (wrong number of fields)', async () => {
    const result = await tool.execute({
      action: 'add',
      name: 'bad-cron',
      prompt: 'task',
      schedule: '0 9 *',
    });
    assert.match(result, /5-field cron expression/);
  });

  it('should return error when removing without identifier', async () => {
    const result = await tool.execute({ action: 'remove' });
    assert.strictEqual(result, 'Error: id or name is required');
  });

  it('should return not found when removing nonexistent routine', async () => {
    const result = await tool.execute({ action: 'remove', id: 'nonexistent-id' });
    assert.match(result, /not found/);
  });

  it('should return error when enabling without identifier', async () => {
    const result = await tool.execute({ action: 'enable' });
    assert.strictEqual(result, 'Error: id or name is required');
  });

  it('should return error when disabling without identifier', async () => {
    const result = await tool.execute({ action: 'disable' });
    assert.strictEqual(result, 'Error: id or name is required');
  });
});

describe('matchesCron', () => {
  it('should match wildcard cron (every minute)', () => {
    const date = new Date(2025, 0, 15, 10, 30, 0); // Jan 15, 2025, 10:30 (Wed)
    assert.strictEqual(matchesCron('* * * * *', date), true);
  });

  it('should match exact minute and hour', () => {
    const date = new Date(2025, 0, 15, 9, 0, 0); // 09:00
    assert.strictEqual(matchesCron('0 9 * * *', date), true);
    assert.strictEqual(matchesCron('30 9 * * *', date), false);
  });

  it('should handle step values (*/5)', () => {
    const date0 = new Date(2025, 0, 1, 0, 0, 0);  // minute=0
    const date5 = new Date(2025, 0, 1, 0, 5, 0);  // minute=5
    const date3 = new Date(2025, 0, 1, 0, 3, 0);  // minute=3

    assert.strictEqual(matchesCron('*/5 * * * *', date0), true);
    assert.strictEqual(matchesCron('*/5 * * * *', date5), true);
    assert.strictEqual(matchesCron('*/5 * * * *', date3), false);
  });

  it('should handle range values (1-5 for weekdays)', () => {
    const monday = new Date(2025, 0, 13, 9, 0, 0);    // Monday = 1
    const saturday = new Date(2025, 0, 18, 9, 0, 0);  // Saturday = 6

    assert.strictEqual(matchesCron('0 9 * * 1-5', monday), true);
    assert.strictEqual(matchesCron('0 9 * * 1-5', saturday), false);
  });

  it('should handle list values (1,3,5)', () => {
    const mon = new Date(2025, 0, 13, 9, 0, 0);  // Monday = 1
    const tue = new Date(2025, 0, 14, 9, 0, 0);  // Tuesday = 2
    const wed = new Date(2025, 0, 15, 9, 0, 0);  // Wednesday = 3

    assert.strictEqual(matchesCron('0 9 * * 1,3,5', mon), true);
    assert.strictEqual(matchesCron('0 9 * * 1,3,5', tue), false);
    assert.strictEqual(matchesCron('0 9 * * 1,3,5', wed), true);
  });

  it('should match specific day-of-month and month', () => {
    const jan15 = new Date(2025, 0, 15, 0, 0, 0);
    const feb15 = new Date(2025, 1, 15, 0, 0, 0);

    assert.strictEqual(matchesCron('0 0 15 1 *', jan15), true);
    assert.strictEqual(matchesCron('0 0 15 1 *', feb15), false);
  });
});
