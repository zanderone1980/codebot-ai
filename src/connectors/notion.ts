/**
 * Notion Connector — Search, create pages, update, list databases.
 *
 * Auth: Notion API key (NOTION_API_KEY) — Internal integration token.
 * Uses Notion REST API v1 (2022-06-28).
 */

import { Connector, ConnectorAction } from './base';

const TIMEOUT = 15_000;
const MAX_RESPONSE = 10_000;
const NOTION_API = 'https://api.notion.com/v1';
const NOTION_VERSION = '2022-06-28';

function truncate(text: string): string {
  return text.length <= MAX_RESPONSE ? text : text.substring(0, MAX_RESPONSE) + '\n... (truncated)';
}

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
    const data = await res.json() as Record<string, unknown>;
    return { status: res.status, data };
  } catch (err: unknown) {
    clearTimeout(timer);
    throw err;
  }
}

function extractTitle(page: Record<string, unknown>): string {
  const properties = page.properties as Record<string, Record<string, unknown>> | undefined;
  if (!properties) return '(untitled)';

  // Find the title property
  for (const val of Object.values(properties)) {
    if (val.type === 'title') {
      const titleArr = val.title as Array<{ plain_text: string }> | undefined;
      if (titleArr?.length) return titleArr.map(t => t.plain_text).join('');
    }
  }
  return '(untitled)';
}

function extractRichText(blocks: Array<Record<string, unknown>>): string {
  return blocks.map(block => {
    const type = block.type as string;
    const content = block[type] as Record<string, unknown> | undefined;
    if (!content) return '';

    const richText = content.rich_text as Array<{ plain_text: string }> | undefined;
    if (richText) {
      const text = richText.map(t => t.plain_text).join('');
      if (type === 'heading_1') return `# ${text}`;
      if (type === 'heading_2') return `## ${text}`;
      if (type === 'heading_3') return `### ${text}`;
      if (type === 'bulleted_list_item') return `• ${text}`;
      if (type === 'numbered_list_item') return `- ${text}`;
      if (type === 'to_do') {
        const checked = (content.checked as boolean) ? '[x]' : '[ ]';
        return `${checked} ${text}`;
      }
      return text;
    }
    return '';
  }).filter(Boolean).join('\n');
}

export class NotionConnector implements Connector {
  name = 'notion';
  displayName = 'Notion';
  description = 'Search pages, create and update content, and query databases in Notion.';
  authType: Connector['authType'] = 'api_key';
  envKey = 'NOTION_API_KEY';

  actions: ConnectorAction[] = [
    {
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
      execute: async (args, cred) => {
        const query = args.query as string;
        const count = Math.min((args.count as number) || 10, 50);
        if (!query) return 'Error: query is required';

        try {
          const body: Record<string, unknown> = {
            query,
            page_size: count,
          };
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
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'create_page',
      description: 'Create a new page in Notion',
      parameters: {
        type: 'object',
        properties: {
          title: { type: 'string', description: 'Page title' },
          parent_id: { type: 'string', description: 'Parent page or database ID' },
          parent_type: { type: 'string', description: '"page" or "database" (default "page")' },
          content: { type: 'string', description: 'Page content (plain text, will be converted to blocks)' },
        },
        required: ['title', 'parent_id'],
      },
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

        // Convert content to blocks
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
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'update_page',
      description: 'Append content to an existing Notion page',
      parameters: {
        type: 'object',
        properties: {
          page_id: { type: 'string', description: 'Page ID to update' },
          content: { type: 'string', description: 'Content to append (plain text, each line becomes a paragraph)' },
        },
        required: ['page_id', 'content'],
      },
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
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'list_databases',
      description: 'List all databases shared with the integration',
      parameters: {
        type: 'object',
        properties: {
          count: { type: 'number', description: 'Max results (default 10, max 50)' },
        },
      },
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
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
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
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
  ];

  async validate(credential: string): Promise<boolean> {
    try {
      const { status } = await notionFetch('/users/me', credential);
      return status === 200;
    } catch {
      return false;
    }
  }
}
