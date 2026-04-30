/**
 * Jira Connector — REST API v3.
 *
 * Auth: API token + email + base URL (Basic auth).
 * Credential stored as JSON: { "JIRA_TOKEN", "JIRA_EMAIL", "JIRA_URL" }
 * (or top-level lowercase token / email / url).
 *
 * §8 Connector Contract (PR 22)
 * -----------------------------
 * Five actions. Two reads + three writes.
 *
 *   list_issues     — read   ['read-only', 'account-access', 'net-fetch']
 *   search          — read   ['read-only', 'account-access', 'net-fetch']
 *
 *   create_issue    — write  ['account-access', 'net-fetch', 'send-on-behalf']
 *                     idempotency: { kind: 'unsupported', reason: ... }
 *                     Jira POST /rest/api/3/issue does not accept a
 *                     client-supplied idempotency key. There is no
 *                     `client_request_id`, no `Idempotency-Key` header,
 *                     and the API will happily create a new issue per
 *                     POST even with byte-identical bodies.
 *
 *   update_issue    — write  ['account-access', 'net-fetch', 'send-on-behalf']
 *                     idempotency: { kind: 'unsupported', reason: ... }
 *                     The PUT /issue/{id} body-replacement IS naturally
 *                     idempotent at the field level (the same fields
 *                     submitted twice end at the same state). BUT this
 *                     action also performs a status transition via a
 *                     SEPARATE POST /issue/{id}/transitions, which is
 *                     NOT idempotent — calling it twice tries to
 *                     transition twice, the second often fails because
 *                     the transition is no longer available from the
 *                     new state. Treat the action as a unit: not safe
 *                     to retry blindly.
 *
 *   add_comment     — write  ['account-access', 'net-fetch', 'send-on-behalf']
 *                     idempotency: { kind: 'unsupported', reason: ... }
 *                     POST /comment creates a brand-new comment with a
 *                     server-assigned id every call. Two retries of the
 *                     same body produce two visible comments on the
 *                     issue. No dedup mechanism.
 *
 * Reauth detection (`isJiraAuthError`)
 * ------------------------------------
 * Atlassian responses on auth failure carry HTTP 401 with
 * `errorMessages: [...]`. Decision rules:
 *   - HTTP 401 → always reauth.
 *   - HTTP 429 → never reauth (rate limit).
 *   - HTTP 403 → NOT reauth. Atlassian's 403s are typically
 *     project-level permission ("authenticated but lacks Browse
 *     Projects on PROJ"), license ("user lacks application access"),
 *     or workflow restriction. Reconnecting won't help — the user
 *     fixes the Jira config, not the credential.
 *   - Anything else → NOT reauth (fail closed).
 *
 * `vaultKeyName: 'jira'` declared explicitly.
 */

import { Connector, ConnectorAction, ConnectorPreview, ConnectorReauthError } from './base';
import { createHash } from 'crypto';

const TIMEOUT = 15_000;
const MAX_RESPONSE = 10_000;

interface JiraAuth {
  token: string;
  email: string;
  url: string;
}

function parseAuth(credential: string): JiraAuth | null {
  try {
    const parsed = JSON.parse(credential);
    const token = parsed.JIRA_TOKEN || parsed.token;
    const email = parsed.JIRA_EMAIL || parsed.email;
    const url = (parsed.JIRA_URL || parsed.url || '').replace(/\/+$/, '');
    if (!token || !email || !url) return null;
    return { token, email, url };
  } catch {
    return null;
  }
}

function hashAndLength(value: string): { hash: string; length: number } {
  return {
    hash: createHash('sha256').update(value).digest('hex').substring(0, 16),
    length: value.length,
  };
}

// ─── Reauth classifier (pure, no network) ─────────────────────────────────

interface JiraApiError {
  errorMessages?: string[];
  errors?: Record<string, string>;
}

export function isJiraAuthError(status: number, _body: JiraApiError | undefined): boolean {
  if (status === 401) return true;
  // 403 is deliberately NOT reauth: Atlassian uses 403 for project /
  // license / workflow permission, not credential failure. Reconnect
  // won't help — fix Jira config.
  return false;
}

// ─── HTTP wrapper ─────────────────────────────────────────────────────────

async function apiRequest(
  method: string,
  path: string,
  auth: JiraAuth,
  body?: Record<string, unknown>,
): Promise<{ status: number; data: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  const basic = Buffer.from(`${auth.email}:${auth.token}`).toString('base64');
  try {
    const opts: RequestInit = {
      method,
      headers: {
        'Authorization': `Basic ${basic}`,
        'Accept': 'application/json',
        'Content-Type': 'application/json',
      },
      signal: controller.signal,
    };
    if (body) opts.body = JSON.stringify(body);
    const res = await fetch(`${auth.url}/rest/api/3${path}`, opts);
    clearTimeout(timer);
    const text = await res.text();
    let data: unknown;
    try { data = JSON.parse(text); } catch { data = text; }
    if (isJiraAuthError(res.status, data as JiraApiError)) {
      throw new ConnectorReauthError('jira', `Jira auth failed: HTTP ${res.status}`);
    }
    return { status: res.status, data };
  } catch (err: unknown) {
    clearTimeout(timer);
    throw err;
  }
}

function truncate(text: string): string {
  return text.length <= MAX_RESPONSE ? text : text.substring(0, MAX_RESPONSE) + '\n... (truncated)';
}

function formatError(status: number, data: unknown): string {
  if (typeof data === 'object' && data && 'errorMessages' in data) {
    const msgs = (data as { errorMessages: string[] }).errorMessages;
    return `Error: Jira API ${status}: ${msgs.join(', ')}`;
  }
  return `Error: Jira API ${status}: ${JSON.stringify(data).substring(0, 200)}`;
}

// ─── Idempotency declaration constants ────────────────────────────────────

const CREATE_ISSUE_IDEMPOTENCY_REASON =
  'Jira POST /rest/api/3/issue does not accept a client-supplied idempotency key. There is no `client_request_id`, no `Idempotency-Key` header. Two identical POSTs create two distinct issues with different keys. The connector does NOT preflight-dedup.';

const UPDATE_ISSUE_IDEMPOTENCY_REASON =
  'PUT /issue/{id} body-replacement is field-level idempotent on its own, but this action ALSO performs a status transition via a SEPARATE POST /issue/{id}/transitions which is NOT idempotent: the transition is consumed by the first call and the second call typically fails because the named transition is no longer available from the new state. Treat the whole action as a unit; it is not safe to retry blindly.';

const ADD_COMMENT_IDEMPOTENCY_REASON =
  'Jira POST /comment creates a brand-new comment with a server-assigned id every call. Two retries of the same body produce two visible comments on the issue. No client-supplied dedup mechanism exists.';

// ─── Redaction helpers (mutating verbs only) ──────────────────────────────

function redactCreateIssueArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  if (typeof args.description === 'string' && args.description.length > 0) {
    const d = hashAndLength(args.description);
    out.description = `<redacted sha256:${d.hash} len:${d.length}>`;
  }
  return out;
}

function redactUpdateIssueArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  if (typeof args.description === 'string' && args.description.length > 0) {
    const d = hashAndLength(args.description);
    out.description = `<redacted sha256:${d.hash} len:${d.length}>`;
  }
  return out;
}

function redactAddCommentArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  if (typeof args.comment === 'string' && args.comment.length > 0) {
    const d = hashAndLength(args.comment);
    out.comment = `<redacted sha256:${d.hash} len:${d.length}>`;
  }
  return out;
}

// ─── Preview functions (pure, no network) ─────────────────────────────────

function previewCreateIssue(args: Record<string, unknown>): ConnectorPreview {
  const project = String(args.project ?? '');
  const summary = String(args.summary ?? '');
  const issuetype = (typeof args.issuetype === 'string' && args.issuetype.length > 0) ? args.issuetype : 'Task';
  const priority = (typeof args.priority === 'string' && args.priority.length > 0) ? args.priority : '(unspecified)';
  const assignee = (typeof args.assignee === 'string' && args.assignee.length > 0) ? args.assignee : '(unassigned)';
  const labels = (typeof args.labels === 'string' && args.labels.length > 0)
    ? args.labels.split(',').map(l => l.trim()).filter(Boolean)
    : [];
  const description = typeof args.description === 'string' ? args.description : '';
  const descDigest = description.length > 0 ? hashAndLength(description) : null;

  const lines = [
    `Would create Jira issue:`,
    `  Project:     ${project}`,
    `  Type:        ${issuetype}`,
    `  Summary:     ${summary}`,
    `  Priority:    ${priority}`,
    `  Assignee:    ${assignee}`,
    labels.length > 0 ? `  Labels:      ${labels.join(', ')}` : `  Labels:      (none)`,
    descDigest ? `  Description: ${descDigest.length} chars (sha256:${descDigest.hash})` : `  Description: (empty)`,
    `  Effect:      visible to anyone with Browse Projects on ${project}; notifies watchers and assignee.`,
  ];
  return {
    summary: lines.join('\n'),
    details: {
      project,
      summary,
      issuetype,
      priority,
      assignee,
      labels,
      descriptionLength: descDigest?.length ?? 0,
      descriptionHash: descDigest?.hash ?? null,
    },
  };
}

function previewUpdateIssue(args: Record<string, unknown>): ConnectorPreview {
  const issueKey = String(args.issue_key ?? '');
  const changes: string[] = [];
  if (typeof args.summary === 'string') changes.push(`  summary -> ${args.summary}`);
  if (typeof args.description === 'string') {
    const d = hashAndLength(args.description);
    changes.push(`  description -> ${d.length} chars (sha256:${d.hash})`);
  }
  if (typeof args.status === 'string') changes.push(`  status (transition) -> ${args.status}`);
  if (typeof args.assignee === 'string') changes.push(`  assignee -> ${args.assignee}`);

  const summary = changes.length === 0
    ? `Would update Jira ${issueKey} — but NO fields are set; the API call would be a no-op.`
    : `Would update Jira ${issueKey}:\n${changes.join('\n')}\n  Note: status transition is a separate POST and is NOT idempotent if retried.`;

  return {
    summary,
    details: {
      issueKey,
      changedFields: changes.length,
      transitionTarget: typeof args.status === 'string' ? args.status : null,
    },
  };
}

function previewAddComment(args: Record<string, unknown>): ConnectorPreview {
  const issueKey = String(args.issue_key ?? '');
  const comment = typeof args.comment === 'string' ? args.comment : '';
  const digest = comment.length > 0 ? hashAndLength(comment) : null;
  return {
    summary: [
      `Would add comment to Jira ${issueKey}:`,
      digest ? `  Comment:     ${digest.length} chars (sha256:${digest.hash})` : `  Comment:     (empty — would error)`,
      `  Effect:      visible to anyone with Browse Projects on the parent project; notifies watchers.`,
      `  Idempotency: NONE — retrying creates a duplicate comment.`,
    ].join('\n'),
    details: {
      issueKey,
      commentLength: digest?.length ?? 0,
      commentHash: digest?.hash ?? null,
    },
  };
}

// ─── Action definitions ───────────────────────────────────────────────────

const createIssue: ConnectorAction = {
  name: 'create_issue',
  description: 'Create a new Jira issue',
  parameters: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Project key (e.g., PROJ)' },
      summary: { type: 'string', description: 'Issue summary/title' },
      description: { type: 'string', description: 'Issue description' },
      issuetype: { type: 'string', description: 'Issue type: Bug, Task, Story, Epic (default: Task)' },
      priority: { type: 'string', description: 'Priority: Highest, High, Medium, Low, Lowest' },
      assignee: { type: 'string', description: 'Assignee account ID or email' },
      labels: { type: 'string', description: 'Comma-separated labels' },
    },
    required: ['project', 'summary'],
  },
  capabilities: ['account-access', 'net-fetch', 'send-on-behalf'],
  preview: async (args, _credential): Promise<ConnectorPreview> => previewCreateIssue(args),
  redactArgsForAudit: redactCreateIssueArgs,
  idempotency: { kind: 'unsupported', reason: CREATE_ISSUE_IDEMPOTENCY_REASON },
  execute: async (args, cred) => {
    const auth = parseAuth(cred);
    if (!auth) return 'Error: invalid Jira credentials (need token, email, and URL)';
    const project = args.project as string;
    const summary = args.summary as string;
    if (!project || !summary) return 'Error: project and summary are required';

    const fields: Record<string, unknown> = {
      project: { key: project },
      summary,
      issuetype: { name: (args.issuetype as string) || 'Task' },
    };
    if (args.description) {
      fields.description = {
        type: 'doc', version: 1,
        content: [{ type: 'paragraph', content: [{ type: 'text', text: args.description as string }] }],
      };
    }
    if (args.priority) fields.priority = { name: args.priority };
    if (args.assignee) fields.assignee = { id: args.assignee };
    if (args.labels) fields.labels = (args.labels as string).split(',').map(l => l.trim());

    try {
      const { status, data } = await apiRequest('POST', '/issue', auth, { fields });
      if (status !== 201) return formatError(status, data);
      const issue = data as { key: string; self: string };
      return `Issue ${issue.key} created: ${auth.url}/browse/${issue.key}`;
    } catch (err: unknown) {
      if (err instanceof ConnectorReauthError) throw err;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

const listIssues: ConnectorAction = {
  name: 'list_issues',
  description: 'List issues in a project',
  parameters: {
    type: 'object',
    properties: {
      project: { type: 'string', description: 'Project key' },
      status: { type: 'string', description: 'Filter by status (e.g., "To Do", "In Progress", "Done")' },
      max_results: { type: 'number', description: 'Max results (default 10)' },
    },
    required: ['project'],
  },
  capabilities: ['read-only', 'account-access', 'net-fetch'],
  execute: async (args, cred) => {
    const auth = parseAuth(cred);
    if (!auth) return 'Error: invalid Jira credentials';
    const project = args.project as string;
    if (!project) return 'Error: project is required';

    let jql = `project = ${project}`;
    if (args.status) jql += ` AND status = "${args.status}"`;
    jql += ' ORDER BY updated DESC';
    const maxResults = Math.min((args.max_results as number) || 10, 50);

    try {
      const { status, data } = await apiRequest('GET', `/search?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&fields=summary,status,assignee,priority,updated`, auth);
      if (status !== 200) return formatError(status, data);
      const result = data as { issues: Array<{ key: string; fields: { summary: string; status: { name: string }; assignee: { displayName: string } | null; priority: { name: string } } }> };
      if (!result.issues?.length) return 'No issues found.';
      const lines = result.issues.map(i =>
        `  ${i.key} [${i.fields.status?.name}] ${i.fields.summary} (${i.fields.assignee?.displayName || 'unassigned'}, ${i.fields.priority?.name || '?'})`
      );
      return truncate(`Issues (${result.issues.length}):\n${lines.join('\n')}`);
    } catch (err: unknown) {
      if (err instanceof ConnectorReauthError) throw err;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

const updateIssue: ConnectorAction = {
  name: 'update_issue',
  description: 'Update an existing Jira issue (fields and/or status transition)',
  parameters: {
    type: 'object',
    properties: {
      issue_key: { type: 'string', description: 'Issue key (e.g., PROJ-123)' },
      summary: { type: 'string', description: 'New summary' },
      description: { type: 'string', description: 'New description' },
      status: { type: 'string', description: 'Transition to status (e.g., "In Progress", "Done")' },
      assignee: { type: 'string', description: 'New assignee account ID' },
    },
    required: ['issue_key'],
  },
  capabilities: ['account-access', 'net-fetch', 'send-on-behalf'],
  preview: async (args, _credential): Promise<ConnectorPreview> => previewUpdateIssue(args),
  redactArgsForAudit: redactUpdateIssueArgs,
  idempotency: { kind: 'unsupported', reason: UPDATE_ISSUE_IDEMPOTENCY_REASON },
  execute: async (args, cred) => {
    const auth = parseAuth(cred);
    if (!auth) return 'Error: invalid Jira credentials';
    const issueKey = args.issue_key as string;
    if (!issueKey) return 'Error: issue_key is required';

    try {
      const fields: Record<string, unknown> = {};
      if (args.summary) fields.summary = args.summary;
      if (args.description) {
        fields.description = {
          type: 'doc', version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: args.description as string }] }],
        };
      }
      if (args.assignee) fields.assignee = { id: args.assignee };

      if (Object.keys(fields).length > 0) {
        const { status, data } = await apiRequest('PUT', `/issue/${encodeURIComponent(issueKey)}`, auth, { fields });
        if (status !== 204 && status !== 200) return formatError(status, data);
      }

      if (args.status) {
        const { status: tStatus, data: tData } = await apiRequest('GET', `/issue/${encodeURIComponent(issueKey)}/transitions`, auth);
        if (tStatus !== 200) return `Updated fields but could not transition status: ${formatError(tStatus, tData)}`;
        const transitions = (tData as { transitions: Array<{ id: string; name: string }> }).transitions || [];
        const target = transitions.find(t => t.name.toLowerCase() === (args.status as string).toLowerCase());
        if (!target) return `Updated fields but status "${args.status}" not available. Available: ${transitions.map(t => t.name).join(', ')}`;
        const { status: pStatus, data: pData } = await apiRequest('POST', `/issue/${encodeURIComponent(issueKey)}/transitions`, auth, { transition: { id: target.id } });
        if (pStatus !== 204 && pStatus !== 200) return `Updated fields but transition failed: ${formatError(pStatus, pData)}`;
      }

      return `Issue ${issueKey} updated.`;
    } catch (err: unknown) {
      if (err instanceof ConnectorReauthError) throw err;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

const addComment: ConnectorAction = {
  name: 'add_comment',
  description: 'Add a comment to a Jira issue',
  parameters: {
    type: 'object',
    properties: {
      issue_key: { type: 'string', description: 'Issue key (e.g., PROJ-123)' },
      comment: { type: 'string', description: 'Comment text' },
    },
    required: ['issue_key', 'comment'],
  },
  capabilities: ['account-access', 'net-fetch', 'send-on-behalf'],
  preview: async (args, _credential): Promise<ConnectorPreview> => previewAddComment(args),
  redactArgsForAudit: redactAddCommentArgs,
  idempotency: { kind: 'unsupported', reason: ADD_COMMENT_IDEMPOTENCY_REASON },
  execute: async (args, cred) => {
    const auth = parseAuth(cred);
    if (!auth) return 'Error: invalid Jira credentials';
    const issueKey = args.issue_key as string;
    const comment = args.comment as string;
    if (!issueKey || !comment) return 'Error: issue_key and comment are required';

    try {
      const body = {
        body: {
          type: 'doc', version: 1,
          content: [{ type: 'paragraph', content: [{ type: 'text', text: comment }] }],
        },
      };
      const { status, data } = await apiRequest('POST', `/issue/${encodeURIComponent(issueKey)}/comment`, auth, body);
      if (status !== 201) return formatError(status, data);
      return `Comment added to ${issueKey}.`;
    } catch (err: unknown) {
      if (err instanceof ConnectorReauthError) throw err;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

const search: ConnectorAction = {
  name: 'search',
  description: 'Search issues using JQL (Jira Query Language)',
  parameters: {
    type: 'object',
    properties: {
      jql: { type: 'string', description: 'JQL query (e.g., "project = PROJ AND status = Open")' },
      max_results: { type: 'number', description: 'Max results (default 10)' },
    },
    required: ['jql'],
  },
  capabilities: ['read-only', 'account-access', 'net-fetch'],
  execute: async (args, cred) => {
    const auth = parseAuth(cred);
    if (!auth) return 'Error: invalid Jira credentials';
    const jql = args.jql as string;
    if (!jql) return 'Error: jql is required';
    const maxResults = Math.min((args.max_results as number) || 10, 50);

    try {
      const { status, data } = await apiRequest('GET', `/search?jql=${encodeURIComponent(jql)}&maxResults=${maxResults}&fields=summary,status,assignee,priority,updated`, auth);
      if (status !== 200) return formatError(status, data);
      const result = data as { total: number; issues: Array<{ key: string; fields: { summary: string; status: { name: string }; assignee: { displayName: string } | null; priority: { name: string } } }> };
      if (!result.issues?.length) return 'No issues found.';
      const lines = result.issues.map(i =>
        `  ${i.key} [${i.fields.status?.name}] ${i.fields.summary} (${i.fields.assignee?.displayName || 'unassigned'})`
      );
      return truncate(`Search results (${result.issues.length} of ${result.total}):\n${lines.join('\n')}`);
    } catch (err: unknown) {
      if (err instanceof ConnectorReauthError) throw err;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

// ─── Connector ────────────────────────────────────────────────────────────

export class JiraConnector implements Connector {
  name = 'jira';
  displayName = 'Jira';
  description = 'Create and manage issues, search with JQL, and add comments in Jira.';
  authType: Connector['authType'] = 'api_key';
  envKey = 'JIRA_TOKEN';
  requiredEnvKeys = ['JIRA_TOKEN', 'JIRA_EMAIL', 'JIRA_URL'];
  vaultKeyName = 'jira';

  actions: ConnectorAction[] = [createIssue, listIssues, updateIssue, addComment, search];

  async validate(credential: string): Promise<boolean> {
    const auth = parseAuth(credential);
    if (!auth) return false;
    try {
      const { status } = await apiRequest('GET', '/myself', auth);
      return status === 200;
    } catch {
      return false;
    }
  }
}
