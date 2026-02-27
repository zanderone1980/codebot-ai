import { Tool } from '../types';

export class WebFetchTool implements Tool {
  name = 'web_fetch';
  description = 'Make HTTP requests to URLs or APIs. Fetch web pages, call REST APIs, post data. Supports GET, POST, PUT, PATCH, DELETE.';
  permission: Tool['permission'] = 'prompt';
  parameters = {
    type: 'object',
    properties: {
      url: { type: 'string', description: 'URL to fetch' },
      method: { type: 'string', description: 'HTTP method (default: GET)', enum: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE'] },
      headers: { type: 'object', description: 'Request headers as key-value pairs' },
      body: { type: 'string', description: 'Request body (for POST/PUT/PATCH)' },
      json: { type: 'object', description: 'JSON body (auto-sets Content-Type)' },
    },
    required: ['url'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const url = args.url as string;
    const method = (args.method as string) || 'GET';
    const headers: Record<string, string> = (args.headers as Record<string, string>) || {};

    let body: string | undefined;
    if (args.json) {
      body = JSON.stringify(args.json);
      if (!headers['Content-Type'] && !headers['content-type']) {
        headers['Content-Type'] = 'application/json';
      }
    } else if (args.body) {
      body = args.body as string;
    }

    try {
      const res = await fetch(url, {
        method,
        headers,
        body,
        signal: AbortSignal.timeout(30000),
      });

      const contentType = res.headers.get('content-type') || '';
      const responseText = await res.text();

      // Truncate very large responses
      const maxLen = 50000;
      const truncated = responseText.length > maxLen
        ? responseText.substring(0, maxLen) + `\n\n... (truncated, ${responseText.length} total chars)`
        : responseText;

      const statusLine = `HTTP ${res.status} ${res.statusText}`;

      // For HTML, strip tags to get readable text
      if (contentType.includes('text/html')) {
        const text = this.htmlToText(truncated);
        return `${statusLine}\n\n${text}`;
      }

      return `${statusLine}\n\n${truncated}`;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      return `Error: ${msg}`;
    }
  }

  private htmlToText(html: string): string {
    return html
      // Remove script/style blocks
      .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
      // Convert common block elements to newlines
      .replace(/<\/?(div|p|br|h[1-6]|li|tr|blockquote|pre|section|article|header|footer|nav|main)[^>]*>/gi, '\n')
      // Remove all remaining tags
      .replace(/<[^>]+>/g, '')
      // Decode common entities
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&nbsp;/g, ' ')
      // Clean up whitespace
      .replace(/[ \t]+/g, ' ')
      .replace(/\n\s*\n\s*\n/g, '\n\n')
      .trim();
  }
}
