/**
 * GitHub Connector — REST API v3
 *
 * Auth: Bearer token (Personal Access Token or GITHUB_TOKEN)
 * Actions: list_repos, create_issue, list_issues, get_issue, create_pr, list_prs, get_repo_info
 *
 * PR 9 (2026-04-26): migrated to the §8 connector contract.
 *   - Per-verb capability labels declared.
 *   - `create_issue` and `create_pr` ship `preview` (no network call,
 *     pure args inspection) and `redactArgsForAudit` (body → hash+length).
 *   - Idempotency declared: read verbs omit; both mutating verbs use
 *     `{ kind: 'unsupported', reason: ... }`.
 *
 *     **GitHub REST does not provide client-supplied idempotency keys**
 *     for these endpoints. `POST /repos/.../issues` creates a new issue
 *     on every call (no `(owner, repo, title, body)` server-side dedup).
 *     `POST /repos/.../pulls` enforces (head, base) uniqueness for OPEN
 *     PRs by REJECTING duplicates with 422 — that is not idempotency in
 *     the contract sense (idempotent retry returns the same result;
 *     GitHub returns an error). The connector does not implement a
 *     preflight dedup check, and explicitly does NOT treat the 422 as
 *     safe-retry semantics.
 *   - Reauth detection: 401 → reauth; 403 → reauth ONLY when the
 *     message indicates auth (bad credentials, scope, SSO). 403 with
 *     "rate limit" or "abuse detection" stays a normal error so the
 *     dashboard doesn't prompt "reconnect" when the user just needs to
 *     wait.
 *   - `vaultKeyName: 'github'` declared explicitly.
 *
 * No new actions added in this PR. Migration only.
 */

import { Connector, ConnectorAction, ConnectorPreview, ConnectorReauthError } from './base';
import { createHash } from 'crypto';

const BASE_URL = 'https://api.github.com';
const TIMEOUT = 15_000;
const MAX_RESPONSE = 10_000;

async function apiRequest(
  method: string,
  path: string,
  credential: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    const opts: RequestInit = {
      method,
      headers: {
        'Authorization': `Bearer ${credential}`,
        'Accept': 'application/vnd.github.v3+json',
        'Content-Type': 'application/json',
        'User-Agent': 'CodeBot-AI',
      },
      signal: controller.signal,
    };
    if (body) opts.body = JSON.stringify(body);

    const res = await fetch(`${BASE_URL}${path}`, opts);
    clearTimeout(timer);

    const text = await res.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch { data = text; }
    return { status: res.status, data };
  } catch (err: unknown) {
    clearTimeout(timer);
    throw err;
  }
}

/**
 * Classify a GitHub API error response as auth-failure (reauth needed)
 * vs. anything else. Pure function — exported for direct unit testing
 * without a fetch mock.
 *
 * Honest disambiguation per PR 9:
 *   - 401 → always reauth (token expired/revoked).
 *   - 403 → reauth ONLY when the message names an auth-class problem
 *     (bad credentials, scope, SSO). 403 with "rate limit" or "abuse
 *     detection" returns false: those are throttling, not auth, and
 *     the user should NOT be prompted to reconnect for them.
 *   - Other 403s default to false (could be permission-not-auth, e.g.
 *     "Must have admin rights"). Surfacing them as plain errors is
 *     more honest than fake-prompting reconnection.
 *   - All other statuses → false.
 */
export function isGithubAuthError(status: number, data: unknown): boolean {
  if (status === 401) return true;
  if (status !== 403) return false;
  const msg = String(((data as Record<string, unknown> | undefined)?.message as string | undefined) ?? '').toLowerCase();
  // Explicit non-auth 403 cases — return BEFORE the auth check so a
  // misleading auth-class word in a rate-limit message can't trigger
  // reauth.
  if (msg.includes('rate limit') || msg.includes('abuse detection')) return false;
  // Auth-class 403s
  if (msg.includes('bad credentials')) return true;
  if (msg.includes('resource not accessible')) return true;
  if (msg.includes('must authenticate')) return true;
  if (msg.includes('sso')) return true;
  // Default: don't claim reauth on 403. Permission-class errors should
  // surface as plain errors, not "please reconnect GitHub."
  return false;
}

/**
 * Wraps `apiRequest` and throws `ConnectorReauthError` on auth-class
 * failures. Actions call this instead of apiRequest directly so the
 * throw happens in one place. Non-auth errors pass through as before
 * (caller renders them via `formatError`).
 */
async function apiRequestOrReauth(
  method: string,
  path: string,
  credential: string,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: unknown }> {
  const result = await apiRequest(method, path, credential, body);
  if (isGithubAuthError(result.status, result.data)) {
    const errMsg = String(((result.data as Record<string, unknown> | undefined)?.message as string | undefined) ?? `HTTP ${result.status}`);
    throw new ConnectorReauthError('github', `GitHub auth failed (${result.status}): ${errMsg}`);
  }
  return result;
}

function truncate(text: string): string {
  if (text.length <= MAX_RESPONSE) return text;
  return text.substring(0, MAX_RESPONSE) + '\n... (truncated)';
}

function formatError(status: number, data: unknown): string {
  const msg = typeof data === 'object' && data && 'message' in data
    ? (data as { message: string }).message
    : JSON.stringify(data).substring(0, 200);
  return `Error: GitHub API ${status}: ${msg}`;
}

/** SHA-256 hash + length for audit redaction. Hex, first 16 chars. */
function hashAndLength(value: string): { hash: string; length: number } {
  return {
    hash: createHash('sha256').update(value).digest('hex').substring(0, 16),
    length: value.length,
  };
}

// ─── Idempotency declarations (per §8 connector contract) ─────────────────

const CREATE_ISSUE_IDEMPOTENCY_REASON =
  'GitHub REST POST /repos/{owner}/{repo}/issues does not accept a client-supplied idempotency key. Each POST creates a distinct issue with a new number; there is no server-side dedup on (owner, repo, title, body). The connector does not implement a preflight dedup check.';

const CREATE_PR_IDEMPOTENCY_REASON =
  'GitHub REST POST /repos/{owner}/{repo}/pulls has no client-supplied idempotency key. Duplicate open PRs for the same (head, base) may be rejected by GitHub with HTTP 422, but that is NOT a client-supplied idempotency key and this connector does NOT treat it as safe retry semantics. The connector does not implement a preflight dedup check.';

// ─── Redaction helpers (mutating verbs only) ──────────────────────────────

/**
 * Redact issue/PR body to hash+length. Keep all other fields visible —
 * auditors need owner/repo/title/labels/assignees/head/base to make
 * the audit log useful. Body is the largest and most-sensitive field.
 * Audit log lives at ~/.codebot/audit/ (local hash-chained file), not
 * a transmission target.
 */
function redactGithubBodyArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  if (typeof args.body === 'string') {
    const d = hashAndLength(args.body);
    out.body = `<redacted sha256:${d.hash} len:${d.length}>`;
  }
  return out;
}

// ─── Preview functions (pure, no network) ─────────────────────────────────

/**
 * Preview for create_issue. Pure — no network call. The credential
 * parameter is ignored; preview is "what would happen" computed
 * entirely from the args the user is about to authorize.
 */
function previewCreateIssue(args: Record<string, unknown>): ConnectorPreview {
  const owner = String(args.owner ?? '');
  const repo = String(args.repo ?? '');
  const title = String(args.title ?? '');
  const bodyStr = String(args.body ?? '');
  const labels = typeof args.labels === 'string' ? args.labels : '';
  const assignees = typeof args.assignees === 'string' ? args.assignees : '';
  const bodyDigest = hashAndLength(bodyStr);

  const lines = [
    `Would create a GitHub issue:`,
    `  Repo:       ${owner}/${repo}`,
    `  Title:      ${title}`,
    `  Body:       ${bodyDigest.length} chars (sha256:${bodyDigest.hash})`,
    `  Labels:     ${labels || '(none)'}`,
    `  Assignees:  ${assignees || '(none)'}`,
  ];

  return {
    summary: lines.join('\n'),
    details: {
      owner,
      repo,
      title,
      bodyLength: bodyDigest.length,
      bodyHash: bodyDigest.hash,
      labels: labels || undefined,
      assignees: assignees || undefined,
    },
  };
}

/**
 * Preview for create_pr. Pure — no network call.
 */
function previewCreatePr(args: Record<string, unknown>): ConnectorPreview {
  const owner = String(args.owner ?? '');
  const repo = String(args.repo ?? '');
  const title = String(args.title ?? '');
  const head = String(args.head ?? '');
  const base = typeof args.base === 'string' && args.base.length > 0 ? args.base : 'main';
  const bodyStr = String(args.body ?? '');
  const bodyDigest = hashAndLength(bodyStr);

  const lines = [
    `Would open a GitHub pull request:`,
    `  Repo:    ${owner}/${repo}`,
    `  Title:   ${title}`,
    `  From:    ${head}`,
    `  Into:    ${base}`,
    `  Body:    ${bodyDigest.length} chars (sha256:${bodyDigest.hash})`,
  ];

  return {
    summary: lines.join('\n'),
    details: {
      owner,
      repo,
      title,
      head,
      base,
      bodyLength: bodyDigest.length,
      bodyHash: bodyDigest.hash,
    },
  };
}

// ─── Action definitions ───────────────────────────────────────────────────

const listRepos: ConnectorAction = {
  name: 'list_repos',
  description: 'List repositories for the authenticated user or a specific user/org',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'User or org (omit for authenticated user)' },
      per_page: { type: 'number', description: 'Results per page (default 10, max 100)' },
    },
  },
  capabilities: ['read-only', 'account-access', 'net-fetch'],
  // Read-only — no preview / idempotency / redaction required.
  execute: async (args, cred) => {
    const owner = args.owner as string;
    const perPage = Math.min((args.per_page as number) || 10, 100);
    const path = owner
      ? `/users/${encodeURIComponent(owner)}/repos?per_page=${perPage}&sort=updated`
      : `/user/repos?per_page=${perPage}&sort=updated`;
    try {
      const { status, data } = await apiRequestOrReauth('GET', path, cred);
      if (status !== 200) return formatError(status, data);
      const repos = data as Array<{ full_name: string; description: string; stargazers_count: number; language: string; updated_at: string }>;
      if (!repos.length) return 'No repositories found.';
      const lines = repos.map(r =>
        `  ${r.full_name} — ${r.description || '(no description)'} [${r.language || '?'}, ★${r.stargazers_count}]`
      );
      return truncate(`Repositories (${repos.length}):\n${lines.join('\n')}`);
    } catch (err: unknown) {
      if (err instanceof ConnectorReauthError) throw err;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

const createIssue: ConnectorAction = {
  name: 'create_issue',
  description: 'Create a new issue in a GitHub repository',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      title: { type: 'string', description: 'Issue title' },
      body: { type: 'string', description: 'Issue body (Markdown)' },
      labels: { type: 'string', description: 'Comma-separated label names' },
      assignees: { type: 'string', description: 'Comma-separated assignee usernames' },
    },
    required: ['owner', 'repo', 'title'],
  },
  capabilities: ['account-access', 'net-fetch', 'send-on-behalf'],
  idempotency: {
    kind: 'unsupported',
    reason: CREATE_ISSUE_IDEMPOTENCY_REASON,
  },
  preview: async (args, _credential): Promise<ConnectorPreview> => previewCreateIssue(args),
  redactArgsForAudit: redactGithubBodyArgs,
  execute: async (args, cred) => {
    const owner = args.owner as string;
    const repo = args.repo as string;
    const title = args.title as string;
    if (!owner || !repo || !title) return 'Error: owner, repo, and title are required';

    const payload: Record<string, unknown> = { title, body: (args.body as string) || '' };
    if (args.labels) payload.labels = (args.labels as string).split(',').map(l => l.trim());
    if (args.assignees) payload.assignees = (args.assignees as string).split(',').map(a => a.trim());

    try {
      const { status, data } = await apiRequestOrReauth('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues`, cred, payload);
      if (status !== 201) return formatError(status, data);
      const issue = data as { number: number; html_url: string; title: string };
      return `Issue #${issue.number} created: ${issue.title}\n${issue.html_url}`;
    } catch (err: unknown) {
      if (err instanceof ConnectorReauthError) throw err;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

const listIssues: ConnectorAction = {
  name: 'list_issues',
  description: 'List open issues in a repository',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      state: { type: 'string', description: 'State: open, closed, all (default: open)' },
      per_page: { type: 'number', description: 'Results per page (default 10)' },
    },
    required: ['owner', 'repo'],
  },
  capabilities: ['read-only', 'account-access', 'net-fetch'],
  execute: async (args, cred) => {
    const owner = args.owner as string;
    const repo = args.repo as string;
    if (!owner || !repo) return 'Error: owner and repo are required';
    const state = (args.state as string) || 'open';
    const perPage = Math.min((args.per_page as number) || 10, 100);
    try {
      const { status, data } = await apiRequestOrReauth('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues?state=${state}&per_page=${perPage}`, cred);
      if (status !== 200) return formatError(status, data);
      const issues = data as Array<{ number: number; title: string; state: string; user: { login: string }; labels: Array<{ name: string }> }>;
      if (!issues.length) return `No ${state} issues found.`;
      const lines = issues.map(i => {
        const labels = i.labels.map(l => l.name).join(', ');
        return `  #${i.number} [${i.state}] ${i.title} (by ${i.user.login})${labels ? ` [${labels}]` : ''}`;
      });
      return truncate(`Issues (${issues.length}):\n${lines.join('\n')}`);
    } catch (err: unknown) {
      if (err instanceof ConnectorReauthError) throw err;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

const createPr: ConnectorAction = {
  name: 'create_pr',
  description: 'Create a pull request',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      title: { type: 'string', description: 'PR title' },
      body: { type: 'string', description: 'PR description (Markdown)' },
      head: { type: 'string', description: 'Branch with changes' },
      base: { type: 'string', description: 'Target branch (default: main)' },
    },
    required: ['owner', 'repo', 'title', 'head'],
  },
  capabilities: ['account-access', 'net-fetch', 'send-on-behalf'],
  idempotency: {
    kind: 'unsupported',
    reason: CREATE_PR_IDEMPOTENCY_REASON,
  },
  preview: async (args, _credential): Promise<ConnectorPreview> => previewCreatePr(args),
  redactArgsForAudit: redactGithubBodyArgs,
  execute: async (args, cred) => {
    const owner = args.owner as string;
    const repo = args.repo as string;
    const title = args.title as string;
    const head = args.head as string;
    if (!owner || !repo || !title || !head) return 'Error: owner, repo, title, and head are required';

    const payload = {
      title,
      body: (args.body as string) || '',
      head,
      base: (args.base as string) || 'main',
    };
    try {
      const { status, data } = await apiRequestOrReauth('POST', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls`, cred, payload);
      if (status !== 201) return formatError(status, data);
      const pr = data as { number: number; html_url: string; title: string };
      return `PR #${pr.number} created: ${pr.title}\n${pr.html_url}`;
    } catch (err: unknown) {
      if (err instanceof ConnectorReauthError) throw err;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

const listPrs: ConnectorAction = {
  name: 'list_prs',
  description: 'List pull requests in a repository',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      state: { type: 'string', description: 'State: open, closed, all (default: open)' },
      per_page: { type: 'number', description: 'Results per page (default 10)' },
    },
    required: ['owner', 'repo'],
  },
  capabilities: ['read-only', 'account-access', 'net-fetch'],
  execute: async (args, cred) => {
    const owner = args.owner as string;
    const repo = args.repo as string;
    if (!owner || !repo) return 'Error: owner and repo are required';
    const state = (args.state as string) || 'open';
    const perPage = Math.min((args.per_page as number) || 10, 100);
    try {
      const { status, data } = await apiRequestOrReauth('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/pulls?state=${state}&per_page=${perPage}`, cred);
      if (status !== 200) return formatError(status, data);
      const prs = data as Array<{ number: number; title: string; state: string; user: { login: string }; head: { ref: string } }>;
      if (!prs.length) return `No ${state} pull requests found.`;
      const lines = prs.map(p =>
        `  #${p.number} [${p.state}] ${p.title} (${p.head.ref} by ${p.user.login})`
      );
      return truncate(`Pull Requests (${prs.length}):\n${lines.join('\n')}`);
    } catch (err: unknown) {
      if (err instanceof ConnectorReauthError) throw err;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

const getIssue: ConnectorAction = {
  name: 'get_issue',
  description: 'Get a single issue with full body and comments',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
      number: { type: 'number', description: 'Issue number' },
    },
    required: ['owner', 'repo', 'number'],
  },
  capabilities: ['read-only', 'account-access', 'net-fetch'],
  execute: async (args, cred) => {
    const owner = args.owner as string;
    const repo = args.repo as string;
    const num = args.number as number;
    if (!owner || !repo || !num) return 'Error: owner, repo, and number are required';

    try {
      const issueRes = await apiRequestOrReauth('GET',
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${num}`, cred);
      if (issueRes.status !== 200) return formatError(issueRes.status, issueRes.data);

      const commentsRes = await apiRequestOrReauth('GET',
        `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/issues/${num}/comments?per_page=20`, cred);

      const issue = issueRes.data as {
        number: number; title: string; body: string; state: string;
        user: { login: string }; labels: Array<{ name: string }>;
        html_url: string; created_at: string;
      };

      const comments = (commentsRes.status === 200
        ? commentsRes.data as Array<{ user: { login: string }; body: string; created_at: string }>
        : []);

      let output = `#${issue.number}: ${issue.title}\n`;
      output += `State: ${issue.state} | By: ${issue.user.login}\n`;
      output += `Labels: ${issue.labels.map(l => l.name).join(', ') || 'none'}\n`;
      output += `URL: ${issue.html_url}\n\n`;
      output += `--- Body ---\n${issue.body || '(empty)'}\n`;

      if (comments.length > 0) {
        output += `\n--- Comments (${comments.length}) ---\n`;
        for (const c of comments) {
          output += `\n[${c.user.login}] ${c.created_at}\n${c.body}\n`;
        }
      }

      return truncate(output);
    } catch (err: unknown) {
      if (err instanceof ConnectorReauthError) throw err;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

const getRepoInfo: ConnectorAction = {
  name: 'get_repo_info',
  description: 'Get detailed information about a repository',
  parameters: {
    type: 'object',
    properties: {
      owner: { type: 'string', description: 'Repository owner' },
      repo: { type: 'string', description: 'Repository name' },
    },
    required: ['owner', 'repo'],
  },
  capabilities: ['read-only', 'account-access', 'net-fetch'],
  execute: async (args, cred) => {
    const owner = args.owner as string;
    const repo = args.repo as string;
    if (!owner || !repo) return 'Error: owner and repo are required';
    try {
      const { status, data } = await apiRequestOrReauth('GET', `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`, cred);
      if (status !== 200) return formatError(status, data);
      const r = data as {
        full_name: string; description: string; language: string;
        stargazers_count: number; forks_count: number; open_issues_count: number;
        default_branch: string; html_url: string; created_at: string; updated_at: string;
        topics: string[];
      };
      return [
        `${r.full_name}`,
        `  ${r.description || '(no description)'}`,
        `  Language: ${r.language || 'N/A'}  Stars: ${r.stargazers_count}  Forks: ${r.forks_count}  Issues: ${r.open_issues_count}`,
        `  Default branch: ${r.default_branch}`,
        r.topics?.length ? `  Topics: ${r.topics.join(', ')}` : '',
        `  URL: ${r.html_url}`,
        `  Updated: ${r.updated_at}`,
      ].filter(Boolean).join('\n');
    } catch (err: unknown) {
      if (err instanceof ConnectorReauthError) throw err;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

export class GitHubConnector implements Connector {
  name = 'github';
  displayName = 'GitHub';
  description = 'Create issues, PRs, review code, and manage repositories on GitHub.';
  authType: Connector['authType'] = 'api_key';
  envKey = 'GITHUB_TOKEN';
  vaultKeyName = 'github';

  actions: ConnectorAction[] = [listRepos, createIssue, listIssues, createPr, listPrs, getIssue, getRepoInfo];

  async validate(credential: string): Promise<boolean> {
    try {
      const { status } = await apiRequest('GET', '/user', credential);
      return status === 200;
    } catch {
      return false;
    }
  }
}
