import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { GitHubConnector, isGithubAuthError } from './github';
import { assertContractClean, validateConnectorContract } from './connector-contract';
import { ConnectorReauthError, isConnectorReauthError } from './base';

/**
 * GitHubConnector tests — pre-PR-9: validates host injection blocking,
 * input validation, action routing, metadata, and error messages.
 *
 * PR 9 (2026-04-26) extensions:
 *   - assertContractClean passes (zero §8 violations)
 *   - Per-verb capabilities match the agreed table
 *   - Read verbs omit preview/idempotency/redact
 *   - create_issue / create_pr preview shape (pure-from-args, no network)
 *   - redactArgsForAudit hashes body, keeps everything else
 *   - Idempotency declarations: both kind:'unsupported' with reasons
 *     that explicitly state GitHub does NOT provide a client-supplied
 *     idempotency key — no fake idempotency
 *   - isGithubAuthError classifier — 401/403 disambiguation including
 *     RATE LIMIT and ABUSE DETECTION exclusions (rate-limit 403 must
 *     NOT trigger reauth; user just waits)
 *   - ConnectorReauthError catchability via isConnectorReauthError
 *
 * Tests cover the classifier directly with no fetch mock.
 */

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

// ─── PR 9 — §8 contract migration ─────────────────────────────────────────

describe('GitHubConnector — §8 contract compliance (PR 9)', () => {
  it('passes assertContractClean with zero violations', () => {
    assert.doesNotThrow(() => assertContractClean(new GitHubConnector()));
  });

  it('reports zero contract violations from validateConnectorContract', () => {
    assert.deepStrictEqual(validateConnectorContract(new GitHubConnector()), []);
  });

  it('exposes 7 actions (PR 9 migration only — no new actions added)', () => {
    const gh = new GitHubConnector();
    const names = gh.actions.map((a) => a.name).sort();
    assert.deepStrictEqual(names, [
      'create_issue', 'create_pr', 'get_issue', 'get_repo_info',
      'list_issues', 'list_prs', 'list_repos',
    ]);
  });

  it('declares vaultKeyName explicitly', () => {
    const gh = new GitHubConnector();
    assert.strictEqual(gh.vaultKeyName, 'github');
  });
});

describe('GitHubConnector — per-verb capability labels', () => {
  function getAction(name: string) {
    const gh = new GitHubConnector();
    const a = gh.actions.find((x) => x.name === name);
    if (!a) throw new Error(`action ${name} not found`);
    return a;
  }

  it('list_repos: read-only + account-access + net-fetch', () => {
    assert.deepStrictEqual(
      getAction('list_repos').capabilities?.slice().sort(),
      ['account-access', 'net-fetch', 'read-only'],
    );
  });

  it('list_issues: read-only + account-access + net-fetch', () => {
    assert.deepStrictEqual(
      getAction('list_issues').capabilities?.slice().sort(),
      ['account-access', 'net-fetch', 'read-only'],
    );
  });

  it('list_prs: read-only + account-access + net-fetch', () => {
    assert.deepStrictEqual(
      getAction('list_prs').capabilities?.slice().sort(),
      ['account-access', 'net-fetch', 'read-only'],
    );
  });

  it('get_issue: read-only + account-access + net-fetch', () => {
    assert.deepStrictEqual(
      getAction('get_issue').capabilities?.slice().sort(),
      ['account-access', 'net-fetch', 'read-only'],
    );
  });

  it('get_repo_info: read-only + account-access + net-fetch', () => {
    assert.deepStrictEqual(
      getAction('get_repo_info').capabilities?.slice().sort(),
      ['account-access', 'net-fetch', 'read-only'],
    );
  });

  it('create_issue: account-access + net-fetch + send-on-behalf', () => {
    assert.deepStrictEqual(
      getAction('create_issue').capabilities?.slice().sort(),
      ['account-access', 'net-fetch', 'send-on-behalf'],
    );
  });

  it('create_pr: account-access + net-fetch + send-on-behalf', () => {
    assert.deepStrictEqual(
      getAction('create_pr').capabilities?.slice().sort(),
      ['account-access', 'net-fetch', 'send-on-behalf'],
    );
  });

  it('all 5 read-only verbs omit preview/idempotency/redact', () => {
    for (const name of ['list_repos', 'list_issues', 'list_prs', 'get_issue', 'get_repo_info']) {
      const a = getAction(name);
      assert.strictEqual(a.preview, undefined, `${name}.preview must be undefined for read-only verb`);
      assert.strictEqual(a.idempotency, undefined, `${name}.idempotency must be undefined for read-only verb`);
      assert.strictEqual(a.redactArgsForAudit, undefined, `${name}.redactArgsForAudit must be undefined for read-only verb`);
    }
  });
});

describe('GitHubConnector — create_issue preview', () => {
  function getCreate() {
    const gh = new GitHubConnector();
    return gh.actions.find((a) => a.name === 'create_issue')!;
  }

  it('returns the documented {summary, details} shape', async () => {
    const result = await getCreate().preview!(
      { owner: 'octo', repo: 'demo', title: 'Bug', body: 'reproduce by...', labels: 'bug,urgent', assignees: 'alice' },
      'fake-credential-not-used',
    );
    assert.ok(typeof result.summary === 'string' && result.summary.length > 0);
    assert.ok(typeof result.details === 'object');
  });

  it('summary names repo + title + body length+hash + labels + assignees', async () => {
    const result = await getCreate().preview!(
      { owner: 'octo', repo: 'demo', title: 'Bug Report', body: 'hello world', labels: 'bug,urgent', assignees: 'alice' },
      'fake-cred',
    );
    assert.match(result.summary, /octo\/demo/);
    assert.match(result.summary, /Bug Report/);
    assert.match(result.summary, /11 chars/);   // 'hello world' length
    assert.match(result.summary, /sha256:[a-f0-9]+/);
    assert.match(result.summary, /bug,urgent/);
    assert.match(result.summary, /alice/);
  });

  it('summary shows "(none)" for missing labels and assignees', async () => {
    const result = await getCreate().preview!(
      { owner: 'octo', repo: 'demo', title: 'Bug', body: '' },
      'fake-cred',
    );
    assert.match(result.summary, /Labels:\s+\(none\)/);
    assert.match(result.summary, /Assignees:\s+\(none\)/);
  });

  it('details object exposes structured fields', async () => {
    const result = await getCreate().preview!(
      { owner: 'octo', repo: 'demo', title: 'Bug', body: 'hello' },
      'fake-cred',
    );
    const d = result.details as Record<string, unknown>;
    assert.strictEqual(d.owner, 'octo');
    assert.strictEqual(d.repo, 'demo');
    assert.strictEqual(d.title, 'Bug');
    assert.strictEqual(d.bodyLength, 5);
    assert.match(String(d.bodyHash), /^[a-f0-9]{16}$/);
  });

  it('preview makes NO network call (pure args inspection)', async () => {
    // We exercise this by passing a token that would 401 if used. The
    // preview function doesn't call apiRequest, so the call must not
    // throw and must not return any HTTP error indicators.
    const result = await getCreate().preview!(
      { owner: 'octo', repo: 'demo', title: 'Bug', body: 'b' },
      'definitely-not-a-real-token',
    );
    assert.match(result.summary, /Would create a GitHub issue/);
    assert.doesNotMatch(result.summary, /[Ee]rror/);
  });
});

describe('GitHubConnector — create_pr preview', () => {
  function getCreate() {
    const gh = new GitHubConnector();
    return gh.actions.find((a) => a.name === 'create_pr')!;
  }

  it('summary names repo + title + head + base + body length+hash', async () => {
    const result = await getCreate().preview!(
      { owner: 'octo', repo: 'demo', title: 'Add feature', body: 'PR body content', head: 'feat/x', base: 'develop' },
      'fake-cred',
    );
    assert.match(result.summary, /Would open a GitHub pull request/);
    assert.match(result.summary, /octo\/demo/);
    assert.match(result.summary, /Add feature/);
    assert.match(result.summary, /From:\s+feat\/x/);
    assert.match(result.summary, /Into:\s+develop/);
    assert.match(result.summary, /15 chars/);  // 'PR body content' length
    assert.match(result.summary, /sha256:[a-f0-9]+/);
  });

  it('base defaults to "main" when missing', async () => {
    const result = await getCreate().preview!(
      { owner: 'octo', repo: 'demo', title: 'Add feature', body: 'b', head: 'feat/x' },
      'fake-cred',
    );
    assert.match(result.summary, /Into:\s+main/);
  });

  it('preview makes NO network call', async () => {
    const result = await getCreate().preview!(
      { owner: 'octo', repo: 'demo', title: 'Add feature', body: 'b', head: 'feat/x' },
      'definitely-not-a-real-token',
    );
    assert.doesNotMatch(result.summary, /[Ee]rror/);
  });
});

describe('GitHubConnector — redactArgsForAudit (mutating verbs only)', () => {
  it('create_issue: body redacted to hash+length; everything else preserved', () => {
    const gh = new GitHubConnector();
    const action = gh.actions.find((a) => a.name === 'create_issue')!;
    const redacted = action.redactArgsForAudit!({
      owner: 'octo',
      repo: 'demo',
      title: 'Bug',
      body: 'top secret reproduce steps',
      labels: 'bug,urgent',
      assignees: 'alice,bob',
    });
    assert.strictEqual(redacted.owner, 'octo');
    assert.strictEqual(redacted.repo, 'demo');
    assert.strictEqual(redacted.title, 'Bug');
    assert.strictEqual(redacted.labels, 'bug,urgent');
    assert.strictEqual(redacted.assignees, 'alice,bob');
    assert.match(String(redacted.body), /^<redacted sha256:[a-f0-9]+ len:\d+>$/);
  });

  it('create_pr: body redacted; owner/repo/title/head/base preserved', () => {
    const gh = new GitHubConnector();
    const action = gh.actions.find((a) => a.name === 'create_pr')!;
    const redacted = action.redactArgsForAudit!({
      owner: 'octo',
      repo: 'demo',
      title: 'Add feature',
      body: 'detailed PR description with private context',
      head: 'feat/x',
      base: 'main',
    });
    assert.strictEqual(redacted.owner, 'octo');
    assert.strictEqual(redacted.repo, 'demo');
    assert.strictEqual(redacted.title, 'Add feature');
    assert.strictEqual(redacted.head, 'feat/x');
    assert.strictEqual(redacted.base, 'main');
    assert.match(String(redacted.body), /^<redacted sha256:[a-f0-9]+ len:\d+>$/);
  });

  it('redaction is deterministic (same body → same hash)', () => {
    const gh = new GitHubConnector();
    const action = gh.actions.find((a) => a.name === 'create_issue')!;
    const a = action.redactArgsForAudit!({ owner: 'x', repo: 'y', title: 't', body: 'same content' });
    const b = action.redactArgsForAudit!({ owner: 'p', repo: 'q', title: 's', body: 'same content' });
    assert.strictEqual(a.body, b.body, 'identical body must produce identical hash');
  });

  it('redaction handles missing body (no crash, no fake hash)', () => {
    const gh = new GitHubConnector();
    const action = gh.actions.find((a) => a.name === 'create_issue')!;
    const redacted = action.redactArgsForAudit!({ owner: 'x', repo: 'y', title: 't' });
    assert.strictEqual(redacted.body, undefined, 'missing body must NOT get a fabricated hash');
  });
});

describe('GitHubConnector — idempotency declarations (unsupported arm)', () => {
  it('create_issue: kind=unsupported with reason citing GitHub + no client-supplied key', () => {
    const gh = new GitHubConnector();
    const action = gh.actions.find((a) => a.name === 'create_issue')!;
    assert.ok(action.idempotency);
    assert.strictEqual(action.idempotency!.kind, 'unsupported');
    if (action.idempotency!.kind === 'unsupported') {
      const reason = action.idempotency!.reason;
      assert.ok(reason.length > 0, 'reason must be non-empty');
      assert.match(reason, /GitHub/i);
      assert.match(reason, /does not accept a client-supplied idempotency key/i);
    }
  });

  it('create_pr: kind=unsupported with reason explicitly distinguishing 422 rejection from idempotency', () => {
    const gh = new GitHubConnector();
    const action = gh.actions.find((a) => a.name === 'create_pr')!;
    assert.ok(action.idempotency);
    assert.strictEqual(action.idempotency!.kind, 'unsupported');
    if (action.idempotency!.kind === 'unsupported') {
      const reason = action.idempotency!.reason;
      assert.ok(reason.length > 0);
      assert.match(reason, /GitHub/i);
      // Per the PR 9 review tweak: the reason must make the (head, base)
      // distinction unmistakable — call it rejection, NOT idempotency.
      assert.match(reason, /head, base/i, 'reason must mention head/base uniqueness');
      assert.match(reason, /not.*idempotency key|not a client-supplied idempotency/i,
        'reason must explicitly state this is NOT idempotency');
      assert.match(reason, /not.*safe retry/i,
        'reason must explicitly state this is NOT safe retry semantics');
    }
  });
});

describe('GitHubConnector — auth-error classifier (no fetch mock)', () => {
  // Direct unit tests on the pure classifier function. No network mock
  // layer introduced — same approach as PR 8 / Gmail.

  it('401 → reauth (always — token expired/revoked)', () => {
    assert.strictEqual(isGithubAuthError(401, {}), true);
    assert.strictEqual(isGithubAuthError(401, { message: 'Bad credentials' }), true);
    assert.strictEqual(isGithubAuthError(401, { message: 'literally anything' }), true);
  });

  it('403 + "Bad credentials" → reauth', () => {
    assert.strictEqual(isGithubAuthError(403, { message: 'Bad credentials' }), true);
  });

  it('403 + "Resource not accessible by integration" → reauth (scope problem)', () => {
    assert.strictEqual(isGithubAuthError(403, { message: 'Resource not accessible by integration' }), true);
  });

  it('403 + "Resource not accessible by personal access token" → reauth', () => {
    assert.strictEqual(isGithubAuthError(403, { message: 'Resource not accessible by personal access token' }), true);
  });

  it('403 + "Must authenticate to access this endpoint" → reauth', () => {
    assert.strictEqual(isGithubAuthError(403, { message: 'Must authenticate to access this endpoint.' }), true);
  });

  it('403 + SSO requirement → reauth', () => {
    assert.strictEqual(isGithubAuthError(403, { message: 'You must authorize SSO for organization' }), true);
  });

  it('403 + "API rate limit exceeded" → NOT reauth (user just waits)', () => {
    // Critical: this case must NOT prompt the user to reconnect.
    assert.strictEqual(isGithubAuthError(403, { message: 'API rate limit exceeded for user ID 1234.' }), false);
  });

  it('403 + "abuse detection mechanism" → NOT reauth', () => {
    assert.strictEqual(
      isGithubAuthError(403, { message: 'You have triggered an abuse detection mechanism. Please wait a few minutes before trying again.' }),
      false,
    );
  });

  it('403 + "secondary rate limit" → NOT reauth', () => {
    // GitHub uses "rate limit" wording for both primary and secondary
    // limits — the substring check catches both.
    assert.strictEqual(isGithubAuthError(403, { message: 'You have exceeded a secondary rate limit.' }), false);
  });

  it('403 + permission-not-auth (e.g. "Must have admin rights") → NOT reauth', () => {
    // 403 doesn't match any auth-class keyword. Surfaces as a plain
    // error rather than fake-prompting reconnection.
    assert.strictEqual(isGithubAuthError(403, { message: 'Must have admin rights to Repository.' }), false);
  });

  it('200 OK → not reauth', () => {
    assert.strictEqual(isGithubAuthError(200, {}), false);
  });

  it('500 server error → not reauth', () => {
    assert.strictEqual(isGithubAuthError(500, { message: 'internal error' }), false);
  });

  it('404 → not reauth', () => {
    assert.strictEqual(isGithubAuthError(404, { message: 'Not Found' }), false);
  });

  it('handles missing/malformed data without crashing', () => {
    assert.strictEqual(isGithubAuthError(200, undefined), false);
    assert.strictEqual(isGithubAuthError(401, undefined), true);
    assert.strictEqual(isGithubAuthError(403, undefined), false);  // no message → not auth
    assert.strictEqual(isGithubAuthError(403, null), false);
    assert.strictEqual(isGithubAuthError(403, 'not an object'), false);
  });
});

describe('GitHubConnector — ConnectorReauthError contract', () => {
  it('ConnectorReauthError instances pass isConnectorReauthError', () => {
    const e = new ConnectorReauthError('github', 'token expired');
    assert.ok(isConnectorReauthError(e));
    assert.strictEqual(e.kind, 'reauth-required');
    assert.strictEqual(e.service, 'github');
  });
});
