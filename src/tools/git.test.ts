import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { GitTool } from './git';

/**
 * GitTool tests — validates safety checks (force push blocking, clean -f),
 * action routing, metadata, and error messages.
 * Tests do NOT require an actual git repository for validation-level tests.
 */

describe('GitTool — metadata', () => {
  const tool = new GitTool();

  it('has correct tool name', () => {
    assert.strictEqual(tool.name, 'git');
  });

  it('has prompt permission level', () => {
    assert.strictEqual(tool.permission, 'prompt');
  });

  it('requires action parameter', () => {
    const required = tool.parameters.required as string[];
    assert.ok(required.includes('action'));
  });

  it('has description mentioning git operations', () => {
    assert.ok(tool.description.toLowerCase().includes('git'));
  });
});

describe('GitTool — input validation', () => {
  const tool = new GitTool();

  it('returns error when action is missing', async () => {
    const result = await tool.execute({});
    assert.ok(result.includes('Error: action is required'));
  });

  it('returns error for unknown action', async () => {
    const result = await tool.execute({ action: 'rebase' });
    assert.ok(result.includes('Error: unknown action'));
    assert.ok(result.includes('rebase'));
    assert.ok(result.includes('Allowed:'));
  });

  it('lists all allowed actions in error message', async () => {
    const result = await tool.execute({ action: 'squash' });
    assert.ok(result.includes('status'));
    assert.ok(result.includes('diff'));
    assert.ok(result.includes('log'));
    assert.ok(result.includes('commit'));
    assert.ok(result.includes('push'));
    assert.ok(result.includes('pull'));
    assert.ok(result.includes('merge'));
  });
});

describe('GitTool — safety: force push blocking', () => {
  const tool = new GitTool();

  it('blocks --force push to main', async () => {
    const result = await tool.execute({
      action: 'push',
      args: '--force main',
    });
    assert.ok(result.includes('Error: force push to main/master is blocked'));
  });

  it('blocks --force push to master', async () => {
    const result = await tool.execute({
      action: 'push',
      args: '--force master',
    });
    assert.ok(result.includes('Error: force push to main/master is blocked'));
  });

  it('blocks --force with origin main', async () => {
    const result = await tool.execute({
      action: 'push',
      args: '--force origin main',
    });
    assert.ok(result.includes('Error: force push to main/master is blocked'));
  });

  it('blocks --force with origin master', async () => {
    const result = await tool.execute({
      action: 'push',
      args: '--force origin master',
    });
    assert.ok(result.includes('Error: force push to main/master is blocked'));
  });

  it('does not block force push to feature branches', async () => {
    // This will fail because there's no git repo, but should NOT be blocked
    const result = await tool.execute({
      action: 'push',
      args: '--force origin feature/my-branch',
    });
    assert.ok(!result.includes('force push to main/master is blocked'));
  });
});

describe('GitTool — safety: git clean blocking', () => {
  const tool = new GitTool();

  it('blocks git clean -f (dangerous file deletion)', async () => {
    // clean is not in ALLOWED_ACTIONS, so this should fail as unknown action
    const result = await tool.execute({
      action: 'reset',
      args: '&& git clean -f',
    });
    // With injection detection, the && characters are caught first
    assert.ok(result.includes('Error: arguments contain disallowed characters') || result.includes('Error: git clean -f is blocked'));
  });
});

describe('GitTool — action routing (allowed actions)', () => {
  const tool = new GitTool();

  it('accepts status action', async () => {
    const result = await tool.execute({ action: 'status' });
    // Should either succeed or fail with git error, not "unknown action"
    assert.ok(!result.includes('unknown action'));
  });

  it('accepts diff action', async () => {
    const result = await tool.execute({ action: 'diff' });
    assert.ok(!result.includes('unknown action'));
  });

  it('accepts log action', async () => {
    const result = await tool.execute({ action: 'log' });
    assert.ok(!result.includes('unknown action'));
  });

  it('accepts branch action', async () => {
    const result = await tool.execute({ action: 'branch' });
    assert.ok(!result.includes('unknown action'));
  });

  it('accepts stash action', async () => {
    const result = await tool.execute({ action: 'stash' });
    assert.ok(!result.includes('unknown action'));
  });

  it('accepts blame action', async () => {
    const result = await tool.execute({ action: 'blame' });
    assert.ok(!result.includes('unknown action'));
  });

  it('accepts tag action', async () => {
    const result = await tool.execute({ action: 'tag' });
    assert.ok(!result.includes('unknown action'));
  });

  it('accepts add action', async () => {
    const result = await tool.execute({ action: 'add' });
    assert.ok(!result.includes('unknown action'));
  });

  it('accepts reset action', async () => {
    const result = await tool.execute({ action: 'reset' });
    assert.ok(!result.includes('unknown action'));
  });
});

describe('GitTool — disallowed actions', () => {
  const tool = new GitTool();

  it('rejects rebase action', async () => {
    const result = await tool.execute({ action: 'rebase' });
    assert.ok(result.includes('Error: unknown action'));
  });

  it('rejects cherry-pick action', async () => {
    const result = await tool.execute({ action: 'cherry-pick' });
    assert.ok(result.includes('Error: unknown action'));
  });

  it('rejects init action', async () => {
    const result = await tool.execute({ action: 'init' });
    assert.ok(result.includes('Error: unknown action'));
  });

  it('restricts clone to safe hosts', async () => {
    const result = await tool.execute({ action: 'clone', args: 'https://evil.com/repo.git' });
    assert.ok(result.includes('Error: clone is restricted'));
  });

  it('allows clone from github.com', async () => {
    // Will fail at git level (not a real repo) but should pass URL validation
    const result = await tool.execute({ action: 'clone', args: 'https://github.com/owner/repo' });
    assert.ok(!result.includes('Error: clone is restricted'));
  });
});

describe('GitTool — with PolicyEnforcer (main push block)', () => {
  it('accepts constructor with undefined policyEnforcer', () => {
    const tool = new GitTool(undefined);
    assert.strictEqual(tool.name, 'git');
  });

  it('accepts constructor without arguments', () => {
    const tool = new GitTool();
    assert.strictEqual(tool.name, 'git');
  });
});
