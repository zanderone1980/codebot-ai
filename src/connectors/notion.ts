/**
 * Notion Connector — search / list_databases / query_database / create_page / update_page.
 *
 * Auth: Bearer integration token (NOTION_API_KEY). API v1, version 2022-06-28.
 *
 * §8 Connector Contract (PR 19)
 * -----------------------------
 * Five actions. Three reads + two writes:
 *
 *   search          — read   ['read-only', 'account-access', 'net-fetch']
 *   list_databases  — read   ['read-only', 'account-access', 'net-fetch']
 *   query_database  — read   ['read-only', 'account-access', 'net-fetch']
 *
 *   create_page     — write  ['account-access', 'net-fetch', 'send-on-behalf']
 *                     idempotency: { kind: 'unsupported', reason: ... }
 *                     Notion's POST /pages does not accept a
 *                     client-supplied idempotency key; each call creates
 *                     a new page with a fresh server-assigned id. There
 *                     is no `client_request_id` parameter and no
 *                     `Idempotency-Key` header. Two identical POSTs
 *                     create two pages, period.
 *
 *   update_page     — write  ['account-access', 'net-fetch', 'send-on-behalf']
 *                     idempotency: { kind: 'unsupported', reason: ... }
 *                     PATCH /blocks/{id}/children APPENDS the supplied
 *                     children blocks to the page. There is no dedup —
 *                     calling it twice with the same body appends those
 *                     blocks twice. The connector does NOT pretend the
 *                     append-only semantics are equivalent to
 *                     idempotency.
 *
 * Reauth detection (`isNotionAuthError`)
 * --------------------------------------
 * Notion error responses carry `{ object: 'error', code: <string>, ... }`.
 * Decision rules:
 *   - HTTP 401 → always reauth.
 *   - HTTP 403/400 with `code` in the auth-class set
 *     (`unauthorized`, `restricted_resource`) → reauth.
 *   - HTTP 429 → NOT reauth (rate limit).
 *   - HTTP 403/400 with `code` in the non-auth-class set
 *     (`rate_limited`, `validation_error`, `object_not_found`,
 *     `conflict_error`, `internal_server_error`, `service_unavailable`)
 *     → NOT reauth.
 *   - HTTP 403/400 with mixed or unrecognized code → NOT reauth
 *     (fail closed; user retries instead of an unnecessary reconnect).
 *   - Anything else → NOT reauth.
 *
 * `vaultKeyName: 'notion'` declared explicitly.
 */

import { Connector, ConnectorAction, ConnectorPreview, ConnectorReauthError } from './base';
import { createHash } from 'crypto';

const TIMEOUT = 15_000;
const MAX_RESPONSE = 10_000;
const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

function truncate(text: string): string {
  return text.length <= MAX_RESPONSE ? text : text.substring(0, MAX_RESPONSE) + '\n... (truncated)';
}

function hashAndLength(value: string): { hash: string; length: number } {
  return {
    hash: createHash('sha256').update(value).digest('hex').substring(0, 16),
    length: value.length,
  };
}

// ─── Reauth classifier (pure, no network) ─────────────────────────────────

interface NotionApiError {
  object?: 'error' | 'list' | 'page' | string;
  code?: string;
  message?: string;
  status?: number;
}

const NOTION_AUTH_CODES: ReadonlySet<string> = new Set([
  'unauthorized',
  'restricted_resource',
]);
const NOTION_NON_AUTH_CODES: ReadonlySet<string> = new Set([
  'rate_limited',
  'validation_error',
  'object_not_found',
  'conflict_error',
  'internal_server_error',
  'service_unavailable',
]);

export function isNotionAuthError(status: number, body: NotionApiError | undefined): boolean {
  if (status === 401) return true;
  if (status === 429) return false;
  if (status !== 403 && status !== 400) return false;
  const code = body?.code;
  if (code && NOTION_NON_AUTH_CODES.has(code)) return false;
  if (code && NOTION_AUTH_CODES.has(code)) return true;
  return false;
}

// ─── HTTP wrapper ─────────────────────────────────────────────────────────

async function notionFetch(
  endpoint: string,
  token: string,
  method = 'GET',
  body?: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const res = await fetch(`${NOTION_API}${endpoint}`, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
        'Notion-Version': NOTION_VERSION,
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    clearTimeout(timer);
    let data: Record<string, unknown> = {};
    if (res.status !== 204) {
      try { data = (await res.json()) as Record<string, unknown>; } catch { data = {}; }
    }
    if (isNotionAuthError(res.status, data as NotionApiError)) {
      const code = (data as NotionApiError).code || 'unknown';
      throw new ConnectorReauthError('notion', `Notion auth failed: HTTP ${res.status} code=${code}`);
    }
    return { status: res.status, data };
  } catch (err: unknown) {
    clearTimeout(timer);
    throw err;
  }
}

// ─── Title / block helpers (unchanged behavior, kept for read formatting) ─

function extractTitle(page: Record<string, unknown>): string {
  const properties = page.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties) return '(untitled)';
  for (const val of Object.values(properties)) {
    if (val.type === 'title') {
      const titleArr = val.title as Array<{ plain_text: string }> | undefined;
      if (titleArr?.length) return titleArr.map(t => t.plain_text).join('');
    }
  }
  return '(untitled)';
}

// ─── Idempotency declaration constants ────────────────────────────────────

const CREATE_PAGE_IDEMPOTENCY_REASON =
  'Notion POST /pages does not accept a client-supplied idempotency key. There is no `client_request_id` parameter and no `Idempotency-Key` header; two identical POSTs create two pages with different server-assigned ids. The connector does NOT preflight-dedup.';

const UPDATE_PAGE_IDEMPOTENCY_REASON =
  'Notion PATCH /blocks/{id}/children APPENDS the supplied children blocks to the page. There is no dedup mechanism — calling it twice with the same body appends those blocks twice. The connector does NOT treat the append-only semantics as equivalent to idempotency.';

// ─── Redaction helpers (mutating verbs only) ──────────────────────────────

/** Redact `content` (body text) to hash+length. Keep title, parent_id,
 *  parent_type — auditors need to know what page got created and where,
 *  but the body text itself is workspace-content-class and may contain
 *  PII or sensitive notes. */
function redactCreatePageArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  if (typeof args.content === 'string' && args.content.length > 0) {
    const d = hashAndLength(args.content);
    out.content = `<redacted sha256:${d.hash} len:${d.length}>`;
  }
  return out;
}

/** Redact `content` for update_page. Keep `page_id` — the auditor
 *  needs to know which page was mutated. */
function redactUpdatePageArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  if (typeof args.content === 'string' && args.content.length > 0) {
    const d = hashAndLength(args.content);
    out.content = `<redacted sha256:${d.hash} len:${d.length}>`;
  }
  return out;
}

// ─── Preview functions (pure, no network) ─────────────────────────────────

function previewCreatePage(args: Record<string, unknown>): ConnectorPreview {
  const title = String(args.title ?? '');
  const parentId = String(args.parent_id ?? '');
  const parentType = (typeof args.parent_type === 'string' && args.parent_type.length > 0)
    ? args.parent_type
    : 'page';
  const content = typeof args.content === 'string' ? args.content : '';
  const paragraphCount = content
    ? content.split('\n').filter(s => s.length > 0).length
    : 0;
  const digest = content.length > 0 ? hashAndLength(content) : null;

  const lines = [
    `Would create Notion page:`,
    `  Title:        ${title}`,
    `  Parent type:  ${parentType}`,
    `  Parent ID:    ${parentId}`,
    `  Body:         ${digest ? `${digest.length} chars (sha256:${digest.hash}), ${paragraphCount} paragraph(s)` : '(empty)'}`,
    `  Effect:       creates a brand-new page in the chosen ${parentType}; visible to anyone with access to that ${parentType}.`,
  ];
  return {
    summary: lines.join('\n'),
    details: {
      title,
      parentId,
      parentType,
      paragraphCount,
      contentLength: digest?.length ?? 0,
      contentHash: digest?.hash ?? null,
    },
  };
}

function previewUpdatePage(args: Record<string, unknown>): ConnectorPreview {
  const pageId = String(args.page_id ?? '');
  const content = typeof args.content === 'string' ? args.content : '';
  const paragraphCount = content
    ? content.split('\n').filter(s => s.length > 0).length
    : 0;
  const digest = content.length > 0 ? hashAndLength(content) : null;

  const lines = [
    `Would APPEND to Notion page:`,
    `  Page ID:      ${pageId}`,
    `  Body:         ${digest ? `${digest.length} chars (sha256:${digest.hash}), ${paragraphCount} paragraph(s)` : '(empty — would error)'}`,
    `  Effect:       appends ${paragraphCount} new paragraph block(s) to the end of the page. Append-only — does NOT replace existing content.`,
    `  Idempotency:  none. Two identical calls append the body twice.`,
  ];
  return {
    summary: lines.join('\n'),
    details: {
      pageId,
      paragraphCount,
      contentLength: digest?.length ?? 0,
      contentHash: digest?.hash ?? null,
    },
  };
}

// ─── Action definitions ───────────────────────────────────────────────────

const search: ConnectorAction = {
  name: 'search',
  description: 'Search across all pages and databases in your Notion workspace',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query text' },
      filter: { type: 'string', description: 'Filter by type: "page" or "database" (default: both)' },
      count: { type: 'number', description: 'Max results (default 10, max 50)' },
    },
    required: ['query'],
  },
  capabilities: ['read-only', 'account-access', 'net-fetch'],
  execute: async (args, cred) => {
    const query = args.query as string;
    const count = Math.min((args.count as number) || 10, 50);
    if (!query) return 'Error: query is required';

    try {
      const body: Record<string, unknown> = { query, page_size: count };
      if (args.filter === 'page' || args.filter === 'database') {
        body.filter = { value: args.filter, property: 'object' };
      }
      const { status, data } = await notionFetch('/search', cred, 'POST', body);
      if (status !== 200) return `Error: Notion API ${status}: ${JSON.stringify(data).substring(0, 200)}`;

      const results = (data.results as Array<Record<string, unknown>>) || [];
      if (!results.length) return `No results found for "${query}".`;

      const lines = results.map(r => {
        const type = r.object as string;
        const id = (r.id as string) || '';
        const title = extractTitle(r);
        const url = (r.url as string) || '';
        return `  [${type}] ${title}\n    ID: ${id}${url ? `\n    URL: ${url}` : ''}`;
      });
      return truncate(`Search results for "${query}" (${results.length}):\n\n${lines.join('\n\n')}`);
    } catch (err: unknown) {
      if (err instanceof ConnectorReauthError) throw err;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

const createPage: ConnectorAction = {
  name: 'create_page',
  description: 'Create a new page in Notion. Body content is appended as paragraph blocks (one per non-empty line).',
  parameters: {
    type: 'object',
    properties: {
      title: { type: 'string', description: 'Page title' },
      parent_id: { type: 'string', description: 'Parent page or database ID' },
      parent_type: { type: 'string', description: '"page" or "database" (default "page")' },
      content: { type: 'string', description: 'Page content (plain text; each non-empty line becomes a paragraph block)' },
    },
    required: ['title', 'parent_id'],
  },
  capabilities: ['account-access', 'net-fetch', 'send-on-behalf'],
  preview: async (args, _credential): Promise<ConnectorPreview> => previewCreatePage(args),
  redactArgsForAudit: redactCreatePageArgs,
  idempotency: { kind: 'unsupported', reason: CREATE_PAGE_IDEMPOTENCY_REASON },
  execute: async (args, cred) => {
    const title = args.title as string;
    const parentId = args.parent_id as string;
    const parentType = (args.parent_type as string) || 'page';
    const content = (args.content as string) || '';
    if (!title || !parentId) return 'Error: title and parent_id are required';

    const parent = parentType === 'database'
      ? { database_id: parentId }
      : { page_id: parentId };

    const properties: Record<string, unknown> = {
      title: { title: [{ text: { content: title } }] },
    };

    const children: Array<Record<string, unknown>> = [];
    if (content) {
      const paragraphs = content.split('\n').filter(Boolean);
      for (const para of paragraphs) {
        children.push({
          object: 'block',
          type: 'paragraph',
          paragraph: {
            rich_text: [{ type: 'text', text: { content: para } }],
          },
        });
      }
    }

    try {
      const body: Record<string, unknown> = { parent, properties };
      if (children.length) body.children = children;
      const { status, data } = await notionFetch('/pages', cred, 'POST', body);
      if (status === 200 || status === 201) {
        const url = (data.url as string) || '';
        return `Page created: "${title}"${url ? `\nURL: ${url}` : ''}\nID: ${(data.id as string) || 'unknown'}`;
      }
      return `Error: Notion API ${status}: ${JSON.stringify(data).substring(0, 200)}`;
    } catch (err: unknown) {
      if (err instanceof ConnectorReauthError) throw err;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

const updatePage: ConnectorAction = {
  name: 'update_page',
  description: 'Append content to an existing Notion page (append-only — does not replace existing blocks)',
  parameters: {
    type: 'object',
    properties: {
      page_id: { type: 'string', description: 'Page ID to update' },
      content: { type: 'string', description: 'Content to append (plain text, each non-empty line becomes a paragraph)' },
    },
    required: ['page_id', 'content'],
  },
  capabilities: ['account-access', 'net-fetch', 'send-on-behalf'],
  preview: async (args, _credential): Promise<ConnectorPreview> => previewUpdatePage(args),
  redactArgsForAudit: redactUpdatePageArgs,
  idempotency: { kind: 'unsupported', reason: UPDATE_PAGE_IDEMPOTENCY_REASON },
  execute: async (args, cred) => {
    const pageId = args.page_id as string;
    const content = args.content as string;
    if (!pageId || !content) return 'Error: page_id and content are required';

    const children = content.split('\n').filter(Boolean).map(line => ({
      object: 'block' as const,
      type: 'paragraph' as const,
      paragraph: {
        rich_text: [{ type: 'text' as const, text: { content: line } }],
      },
    }));

    try {
      const { status, data } = await notionFetch(
        `/blocks/${pageId}/children`,
        cred,
        'PATCH',
        { children },
      );
      if (status === 200) {
        return `Content appended to page ${pageId}. Added ${children.length} paragraph(s).`;
      }
      return `Error: Notion API ${status}: ${JSON.stringify(data).substring(0, 200)}`;
    } catch (err: unknown) {
      if (err instanceof ConnectorReauthError) throw err;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

const listDatabases: ConnectorAction = {
  name: 'list_databases',
  description: 'List all databases shared with the integration',
  parameters: {
    type: 'object',
    properties: {
      count: { type: 'number', description: 'Max results (default 10, max 50)' },
    },
  },
  capabilities: ['read-only', 'account-access', 'net-fetch'],
  execute: async (args, cred) => {
    const count = Math.min((args.count as number) || 10, 50);
    try {
      const { status, data } = await notionFetch('/search', cred, 'POST', {
        filter: { value: 'database', property: 'object' },
        page_size: count,
      });
      if (status !== 200) return `Error: Notion API ${status}: ${JSON.stringify(data).substring(0, 200)}`;
      const databases = (data.results as Array<Record<string, unknown>>) || [];
      if (!databases.length) return 'No databases found. Make sure your integration has access to at least one database.';
      const lines = databases.map(db => {
        const title = extractTitle(db);
        const id = (db.id as string) || '';
        const url = (db.url as string) || '';
        return `  ${title}\n    ID: ${id}${url ? `\n    URL: ${url}` : ''}`;
      });
      return truncate(`Databases (${databases.length}):\n\n${lines.join('\n\n')}`);
    } catch (err: unknown) {
      if (err instanceof ConnectorReauthError) throw err;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

const queryDatabase: ConnectorAction = {
  name: 'query_database',
  description: 'Query a Notion database to list its entries',
  parameters: {
    type: 'object',
    properties: {
      database_id: { type: 'string', description: 'Database ID to query' },
      count: { type: 'number', description: 'Max results (default 20, max 100)' },
    },
    required: ['database_id'],
  },
  capabilities: ['read-only', 'account-access', 'net-fetch'],
  execute: async (args, cred) => {
    const dbId = args.database_id as string;
    const count = Math.min((args.count as number) || 20, 100);
    if (!dbId) return 'Error: database_id is required';
    try {
      const { status, data } = await notionFetch(
        `/databases/${dbId}/query`,
        cred,
        'POST',
        { page_size: count },
      );
      if (status !== 200) return `Error: Notion API ${status}: ${JSON.stringify(data).substring(0, 200)}`;
      const results = (data.results as Array<Record<string, unknown>>) || [];
      if (!results.length) return 'No entries in this database.';
      const lines = results.map(entry => {
        const title = extractTitle(entry);
        const id = (entry.id as string) || '';
        return `  ${title} [${id.substring(0, 8)}]`;
      });
      return truncate(`Database entries (${results.length}):\n\n${lines.join('\n')}`);
    } catch (err: unknown) {
      if (err instanceof ConnectorReauthError) throw err;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

// ─── Connector ────────────────────────────────────────────────────────────

export class NotionConnector implements Connector {
  name = 'notion';
  displayName = 'Notion';
  description = 'Search pages, create and update content, and query databases in Notion.';
  authType: Connector['authType'] = 'api_key';
  envKey = 'NOTION_API_KEY';
  vaultKeyName = 'notion';

  actions: ConnectorAction[] = [search, createPage, updatePage, listDatabases, queryDatabase];

  async validate(credential: string): Promise<boolean> {
    try {
      const { status } = await notionFetch('/users/me', credential);
      return status === 200;
    } catch {
      return false;
    }
  }
}
