/**
 * Linear Connector — GraphQL API.
 *
 * Auth: API key (LINEAR_API_KEY). Single endpoint:
 * https://api.linear.app/graphql
 *
 * §8 Connector Contract (PR 23)
 * -----------------------------
 * Four actions. Two reads + two writes.
 *
 *   list_issues   — read   ['read-only', 'account-access', 'net-fetch']
 *   list_teams    — read   ['read-only', 'account-access', 'net-fetch']
 *
 *   create_issue  — write  ['account-access', 'net-fetch', 'send-on-behalf']
 *                   idempotency: { kind: 'unsupported', reason: ... }
 *                   Linear `issueCreate(input)` mutation has no
 *                   server-checked dedup. They DO accept a
 *                   `clientMutationId` field, but that is just echoed
 *                   back in the response — it does not prevent
 *                   duplicate creates. Two POSTs with the same input
 *                   create two issues with different identifiers.
 *
 *   update_issue  — write  ['account-access', 'net-fetch', 'send-on-behalf']
 *                   idempotency: { kind: 'unsupported', reason: ... }
 *                   `issueUpdate(id, input)` is field-level idempotent
 *                   in the narrow case (same input twice -> same end
 *                   state), but Linear has no client idempotency key,
 *                   and concurrent edits between calls make retries
 *                   genuinely unsafe. The connector documents the gap
 *                   honestly rather than overclaiming.
 *
 * Reauth detection (`isLinearAuthError`)
 * --------------------------------------
 * Linear returns auth failures as HTTP 200 with GraphQL `errors[]`.
 * Decision rules (HTTP-status-aware + GraphQL-error-aware):
 *   - HTTP 401 → always reauth.
 *   - HTTP 200 with errors[] containing message matching
 *     /authentication|invalid api key|unauthenticated|token expired/i
 *     → reauth.
 *   - HTTP 200 with errors[] otherwise → NOT reauth (validation,
 *     not-found, scope, etc.).
 *   - HTTP 429 → never reauth.
 *   - Anything else → NOT reauth (fail closed).
 *
 * `vaultKeyName: 'linear'` declared explicitly.
 */

import { Connector, ConnectorAction, ConnectorPreview, ConnectorReauthError } from './base';
import { createHash } from 'crypto';

const ENDPOINT = 'https://api.linear.app/graphql';
const TIMEOUT = 15_000;
const MAX_RESPONSE = 10_000;

function hashAndLength(value: string): { hash: string; length: number } {
  return {
    hash: createHash('sha256').update(value).digest('hex').substring(0, 16),
    length: value.length,
  };
}

// ─── Reauth classifier (pure, no network) ─────────────────────────────────

interface LinearGraphQLError {
  message?: string;
  extensions?: { code?: string; type?: string };
}

const LINEAR_AUTH_MESSAGE_RE = /authentication|invalid api key|unauthenticated|token expired|unauthorized/i;

export function isLinearAuthError(
  status: number,
  body: { errors?: LinearGraphQLError[] } | undefined,
): boolean {
  if (status === 401) return true;
  if (status === 429) return false;
  if (status !== 200) return false;
  const errs = body?.errors ?? [];
  if (errs.length === 0) return false;
  return errs.some(e => typeof e.message === 'string' && LINEAR_AUTH_MESSAGE_RE.test(e.message));
}

// ─── HTTP wrapper ─────────────────────────────────────────────────────────

async function gql(
  query: string,
  variables: Record<string, unknown>,
  credential: string,
): Promise<{ data?: Record<string, unknown>; errors?: LinearGraphQLError[] }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const res = await fetch(ENDPOINT, {
      method: 'POST',
      headers: {
        'Authorization': credential,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ query, variables }),
      signal: controller.signal,
    });
    clearTimeout(timer);
    let body: { data?: Record<string, unknown>; errors?: LinearGraphQLError[] } = {};
    try { body = await res.json() as typeof body; } catch { body = {}; }
    if (isLinearAuthError(res.status, body)) {
      throw new ConnectorReauthError('linear', `Linear auth failed: HTTP ${res.status}${body.errors ? ` ${body.errors[0]?.message || ''}` : ''}`);
    }
    return body;
  } catch (err: unknown) {
    clearTimeout(timer);
    throw err;
  }
}

function formatErrors(errors: LinearGraphQLError[]): string {
  return `Error: Linear API: ${errors.map(e => e.message || JSON.stringify(e)).join(', ')}`;
}

function truncate(text: string): string {
  return text.length <= MAX_RESPONSE ? text : text.substring(0, MAX_RESPONSE) + '\n... (truncated)';
}

// ─── Idempotency declaration constants ────────────────────────────────────

const CREATE_ISSUE_IDEMPOTENCY_REASON =
  'Linear `issueCreate(input)` has no server-checked dedup. The schema accepts a `clientMutationId` field but it is only echoed back in the response — it does NOT prevent duplicate creates. Two POSTs with the same input create two distinct issues with different identifiers.';

const UPDATE_ISSUE_IDEMPOTENCY_REASON =
  'Linear `issueUpdate(id, input)` is field-level idempotent in the narrow case (same input twice ends at the same state), but the API exposes no client idempotency key, and concurrent edits between retries make blind retries genuinely unsafe. The connector documents the gap honestly rather than overclaiming.';

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

// ─── Preview functions (pure, no network) ─────────────────────────────────

function previewCreateIssue(args: Record<string, unknown>): ConnectorPreview {
  const title = String(args.title ?? '');
  const teamId = String(args.team_id ?? '');
  const priority = typeof args.priority === 'number' ? args.priority : null;
  const priorityLabel = priority === null ? '(unspecified)'
    : ['None', 'Urgent', 'High', 'Medium', 'Low'][priority] ?? String(priority);
  const assignee = (typeof args.assignee_id === 'string' && args.assignee_id.length > 0) ? args.assignee_id : '(unassigned)';
  const labels = (typeof args.labels === 'string' && args.labels.length > 0)
    ? args.labels.split(',').map(s => s.trim()).filter(Boolean)
    : [];
  const description = typeof args.description === 'string' ? args.description : '';
  const descDigest = description.length > 0 ? hashAndLength(description) : null;

  const lines = [
    `Would create Linear issue:`,
    `  Title:       ${title}`,
    `  Team ID:     ${teamId}`,
    `  Priority:    ${priorityLabel}`,
    `  Assignee:    ${assignee}`,
    labels.length > 0 ? `  Label IDs:   ${labels.join(', ')}` : `  Label IDs:   (none)`,
    descDigest ? `  Description: ${descDigest.length} chars (sha256:${descDigest.hash})` : `  Description: (empty)`,
    `  Effect:      visible to anyone with access to the team; notifies subscribers/assignee.`,
  ];
  return {
    summary: lines.join('\n'),
    details: { title, teamId, priority, priorityLabel, assignee, labels, descriptionLength: descDigest?.length ?? 0, descriptionHash: descDigest?.hash ?? null },
  };
}

function previewUpdateIssue(args: Record<string, unknown>): ConnectorPreview {
  const issueId = String(args.issue_id ?? '');
  const changes: string[] = [];
  if (typeof args.title === 'string') changes.push(`  title -> ${args.title}`);
  if (typeof args.description === 'string') {
    const d = hashAndLength(args.description);
    changes.push(`  description -> ${d.length} chars (sha256:${d.hash})`);
  }
  if (typeof args.state_id === 'string') changes.push(`  state_id -> ${args.state_id}`);
  if (typeof args.priority === 'number') changes.push(`  priority -> ${args.priority}`);
  if (typeof args.assignee_id === 'string') changes.push(`  assignee_id -> ${args.assignee_id}`);
  const summary = changes.length === 0
    ? `Would update Linear issue ${issueId} — but NO fields are set; the API call would error.`
    : `Would update Linear issue ${issueId}:\n${changes.join('\n')}\n  Idempotency: NONE — concurrent edits between retries are unsafe.`;
  return { summary, details: { issueId, changedFields: changes.length } };
}

// ─── Action definitions ───────────────────────────────────────────────────

const createIssue: ConnectorAction = {
  name: 'create_issue',
  description: 'Create a new Linear issue',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Issue title' },
      description: { type: 'string', description: 'Issue description (Markdown)' },
      team_id: { type: 'string', description: 'Team ID (use list_teams to find)' },
      priority: { type: 'number', description: 'Priority: 0=None, 1=Urgent, 2=High, 3=Medium, 4=Low' },
      assignee_id: { type: 'string', description: 'Assignee user ID' },
      labels: { type: 'string', description: 'Comma-separated label IDs' },
    },
    required: ['title', 'team_id'],
  },
  capabilities: ['account-access', 'net-fetch', 'send-on-behalf'],
  preview: async (args, _credential): Promise<ConnectorPreview> => previewCreateIssue(args),
  redactArgsForAudit: redactCreateIssueArgs,
  idempotency: { kind: 'unsupported', reason: CREATE_ISSUE_IDEMPOTENCY_REASON },
  execute: async (args, cred) => {
    const title = args.title as string;
    const teamId = args.team_id as string;
    if (!title || !teamId) return 'Error: title and team_id are required';

    const input: Record<string, unknown> = { title, teamId };
    if (args.description) input.description = args.description;
    if (args.priority !== undefined) input.priority = args.priority;
    if (args.assignee_id) input.assigneeId = args.assignee_id;
    if (args.labels) input.labelIds = (args.labels as string).split(',').map(l => l.trim());

    try {
      const result = await gql(`
        mutation CreateIssue($input: IssueCreateInput!) {
          issueCreate(input: $input) {
            success
            issue { id identifier title url }
          }
        }
      `, { input }, cred);
      if (result.errors) return formatErrors(result.errors);
      const create = result.data?.issueCreate as { success: boolean; issue: { identifier: string; title: string; url: string } };
      if (!create?.success) return 'Error: issue creation failed';
      return `Issue ${create.issue.identifier} created: ${create.issue.title}\n${create.issue.url}`;
    } catch (err: unknown) {
      if (err instanceof ConnectorReauthError) throw err;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

const listIssues: ConnectorAction = {
  name: 'list_issues',
  description: 'List issues (optionally filtered by team)',
  parameters: {
    type: 'object',
    properties: {
      team_id: { type: 'string', description: 'Filter by team ID' },
      first: { type: 'number', description: 'Number of issues to return (default 10)' },
      state: { type: 'string', description: 'Filter by state name (e.g., "In Progress", "Done")' },
    },
  },
  capabilities: ['read-only', 'account-access', 'net-fetch'],
  execute: async (args, cred) => {
    const first = Math.min((args.first as number) || 10, 50);
    const filters: string[] = [];
    if (args.team_id) filters.push(`team: { id: { eq: "${args.team_id}" } }`);
    if (args.state) filters.push(`state: { name: { eq: "${args.state}" } }`);
    const filterStr = filters.length ? `(filter: { ${filters.join(', ')} })` : '';

    try {
      const result = await gql(`
        query ListIssues($first: Int!) {
          issues${filterStr}(first: $first, orderBy: updatedAt) {
            nodes {
              identifier title
              state { name }
              assignee { name }
              priority priorityLabel
              url
            }
          }
        }
      `, { first }, cred);
      if (result.errors) return formatErrors(result.errors);
      const issues = (result.data?.issues as { nodes: Array<{ identifier: string; title: string; state: { name: string }; assignee: { name: string } | null; priorityLabel: string; url: string }> })?.nodes || [];
      if (!issues.length) return 'No issues found.';
      const lines = issues.map(i =>
        `  ${i.identifier} [${i.state?.name}] ${i.title} (${i.assignee?.name || 'unassigned'}, ${i.priorityLabel})`
      );
      return truncate(`Issues (${issues.length}):\n${lines.join('\n')}`);
    } catch (err: unknown) {
      if (err instanceof ConnectorReauthError) throw err;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

const updateIssue: ConnectorAction = {
  name: 'update_issue',
  description: 'Update an existing Linear issue',
  parameters: {
    type: 'object',
    properties: {
      issue_id: { type: 'string', description: 'Issue ID (UUID) or identifier (e.g., TEAM-123)' },
      title: { type: 'string', description: 'New title' },
      description: { type: 'string', description: 'New description' },
      state_id: { type: 'string', description: 'New state ID' },
      priority: { type: 'number', description: 'New priority (0-4)' },
      assignee_id: { type: 'string', description: 'New assignee ID' },
    },
    required: ['issue_id'],
  },
  capabilities: ['account-access', 'net-fetch', 'send-on-behalf'],
  preview: async (args, _credential): Promise<ConnectorPreview> => previewUpdateIssue(args),
  redactArgsForAudit: redactUpdateIssueArgs,
  idempotency: { kind: 'unsupported', reason: UPDATE_ISSUE_IDEMPOTENCY_REASON },
  execute: async (args, cred) => {
    const issueId = args.issue_id as string;
    if (!issueId) return 'Error: issue_id is required';

    const input: Record<string, unknown> = {};
    if (args.title) input.title = args.title;
    if (args.description) input.description = args.description;
    if (args.state_id) input.stateId = args.state_id;
    if (args.priority !== undefined) input.priority = args.priority;
    if (args.assignee_id) input.assigneeId = args.assignee_id;

    if (Object.keys(input).length === 0) return 'Error: at least one field to update is required';

    try {
      const result = await gql(`
        mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
          issueUpdate(id: $id, input: $input) {
            success
            issue { identifier title url }
          }
        }
      `, { id: issueId, input }, cred);
      if (result.errors) return formatErrors(result.errors);
      const update = result.data?.issueUpdate as { success: boolean; issue: { identifier: string; title: string; url: string } };
      if (!update?.success) return 'Error: issue update failed';
      return `Issue ${update.issue.identifier} updated: ${update.issue.title}`;
    } catch (err: unknown) {
      if (err instanceof ConnectorReauthError) throw err;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

const listTeams: ConnectorAction = {
  name: 'list_teams',
  description: 'List all teams in the workspace',
  parameters: { type: 'object', properties: {} },
  capabilities: ['read-only', 'account-access', 'net-fetch'],
  execute: async (_args, cred) => {
    try {
      const result = await gql(`
        query ListTeams {
          teams {
            nodes {
              id name key description
              members { nodes { name } }
              states { nodes { id name } }
            }
          }
        }
      `, {}, cred);
      if (result.errors) return formatErrors(result.errors);
      const teams = (result.data?.teams as { nodes: Array<{ id: string; name: string; key: string; description: string; members: { nodes: Array<{ name: string }> }; states: { nodes: Array<{ id: string; name: string }> } }> })?.nodes || [];
      if (!teams.length) return 'No teams found.';
      const lines = teams.map(t => {
        const members = t.members?.nodes?.length || 0;
        const states = t.states?.nodes?.map(s => s.name).join(', ') || 'N/A';
        return `  ${t.key} - ${t.name} (${members} members)\n    ID: ${t.id}\n    States: ${states}${t.description ? `\n    ${t.description}` : ''}`;
      });
      return truncate(`Teams (${teams.length}):\n${lines.join('\n')}`);
    } catch (err: unknown) {
      if (err instanceof ConnectorReauthError) throw err;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

// ─── Connector ────────────────────────────────────────────────────────────

export class LinearConnector implements Connector {
  name = 'linear';
  displayName = 'Linear';
  description = 'Create and manage issues, list teams, and track work in Linear.';
  authType: Connector['authType'] = 'api_key';
  envKey = 'LINEAR_API_KEY';
  vaultKeyName = 'linear';

  actions: ConnectorAction[] = [createIssue, listIssues, updateIssue, listTeams];

  async validate(credential: string): Promise<boolean> {
    try {
      const result = await gql('query { viewer { id name } }', {}, credential);
      return !result.errors && !!result.data?.viewer;
    } catch {
      return false;
    }
  }
}
