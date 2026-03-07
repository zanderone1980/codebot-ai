import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { GitHubConnector } from './github';

describe('GitHubConnector', () => {
  it('has correct metadata', () => {
    const gh = new GitHubConnector();
    assert.strictEqual(gh.name, 'github');
    assert.strictEqual(gh.displayName, 'GitHub');
    assert.strictEqual(gh.envKey, 'GITHUB_TOKEN');
    assert.strictEqual(gh.authType, 'api_key');
  });

  it('has all expected actions', () => {
    const gh = new GitHubConnector();
    const names = gh.actions.map(a => a.name);
    assert.ok(names.includes('list_repos'));
    assert.ok(names.includes('create_issue'));
    assert.ok(names.includes('list_issues'));
    assert.ok(names.includes('create_pr'));
    assert.ok(names.includes('list_prs'));
    assert.ok(names.includes('get_issue'));
    assert.ok(names.includes('get_repo_info'));
    assert.strictEqual(gh.actions.length, 7);
  });

  it('create_issue requires owner, repo, and title', async () => {
    const gh = new GitHubConnector();
    const action = gh.actions.find(a => a.name === 'create_issue')!;
    const result = await action.execute({ owner: '', repo: '', title: '' }, 'fake-token');
    assert.ok(result.includes('Error:'));
  });

  it('list_issues requires owner and repo', async () => {
    const gh = new GitHubConnector();
    const action = gh.actions.find(a => a.name === 'list_issues')!;
    const result = await action.execute({}, 'fake-token');
    assert.ok(result.includes('Error:'));
  });

  it('validate returns false for invalid token', async () => {
    const gh = new GitHubConnector();
    // This will fail because the token is fake — validate should return false
    const valid = await gh.validate('obviously-invalid-token');
    assert.strictEqual(valid, false);
  });
});
