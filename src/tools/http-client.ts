import { Tool, CapabilityLabel } from '../types';
import { validateOutboundUrl } from '../net-guard';

export class HttpClientTool implements Tool {
  name = 'http_client';
  description = 'Make HTTP requests. Supports GET, POST, PUT, DELETE, PATCH with headers, auth, and body.';
  permission: Tool['permission'] = 'prompt';
  capabilities: CapabilityLabel[] = ['read-only', 'net-fetch'];
  parameters = {
    type: 'object',
    properties: {
      method: { type: 'string', description: 'HTTP method: GET, POST, PUT, DELETE, PATCH, HEAD (default: GET)' },
      url: { type: 'string', description: 'Full URL to request' },
      headers: { type: 'object', description: 'Request headers as key-value pairs' },
      body: { type: 'string', description: 'Request body (JSON string or plain text)' },
      auth: { type: 'string', description: 'Authorization header value (e.g., "Bearer token123")' },
      timeout: { type: 'number', description: 'Timeout in ms (default: 30000)' },
    },
    required: ['url'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const url = args.url as string;
    if (!url) return 'Error: url is required';

    // P2-1 fix: was `this.isBlocked(parsedUrl)` — literal hostname
    // string match only, which missed DNS→private-IP redirects. Now
    // goes through validateOutboundUrl which does literal + DNS
    // resolution check. The legacy isBlocked method below is kept
    // for backwards compat but no longer the first line of defense.
    let parsedUrl: URL;
    try {
      parsedUrl = new URL(url);
    } catch {
      return `Error: invalid URL: ${url}`;
    }
    const blockReason = await validateOutboundUrl(url);
    if (blockReason) {
      // Keep the legacy wording ("blocked for security") that downstream
      // tooling/tests grep for; append the specific reason in parens.
      if (/^Invalid URL/.test(blockReason)) return `Error: invalid URL: ${url}`;
      if (/^Blocked protocol/.test(blockReason)) {
        return `Error: requests to unsupported protocols are blocked for security (${blockReason}).`;
      }
      return `Error: requests to private/local addresses are blocked for security (${blockReason}).`;
    }

    const method = ((args.method as string) || 'GET').toUpperCase();
    const timeoutMs = (args.timeout as number) || 30_000;
    const headers: Record<string, string> = {};

    // Set headers
    if (args.headers && typeof args.headers === 'object') {
      for (const [k, v] of Object.entries(args.headers as Record<string, string>)) {
        headers[k] = String(v);
      }
    }
    if (args.auth) {
      headers['Authorization'] = args.auth as string;
    }

    // Auto-set content type for body
    const body = args.body as string | undefined;
    if (body && !headers['Content-Type'] && !headers['content-type']) {
      try { JSON.parse(body); headers['Content-Type'] = 'application/json'; } catch { /* leave as-is */ }
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const res = await fetch(url, {
        method,
        headers,
        body: ['GET', 'HEAD'].includes(method) ? undefined : body,
        signal: controller.signal,
      });

      const contentType = res.headers.get('content-type') || '';
      let responseBody: string;

      try {
        responseBody = await res.text();
      } finally {
        clearTimeout(timer);
      }

      // Try to pretty-print JSON
      if (contentType.includes('json') || responseBody.startsWith('{') || responseBody.startsWith('[')) {
        try {
          const parsed = JSON.parse(responseBody);
          responseBody = JSON.stringify(parsed, null, 2);
        } catch { /* keep raw */ }
      }

      // Truncate huge responses
      if (responseBody.length > 10_000) {
        responseBody = responseBody.substring(0, 10_000) + '\n...(truncated)';
      }

      const headerLines = Array.from(res.headers.entries())
        .slice(0, 10)
        .map(([k, v]) => `  ${k}: ${v}`)
        .join('\n');

      return `${res.status} ${res.statusText}\n\nHeaders:\n${headerLines}\n\nBody:\n${responseBody}`;
    } catch (err: unknown) {
      clearTimeout(timer);
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes('abort')) return `Error: request timed out after ${timeoutMs}ms`;
      return `Error: ${msg}`;
    }
  }

  private isBlocked(url: URL): boolean {
    const host = url.hostname.toLowerCase();
    if (url.protocol === 'file:') return true;
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1' || host === '0.0.0.0') return true;
    if (host === '169.254.169.254') return true; // cloud metadata
    if (/^10\./.test(host) || /^192\.168\./.test(host) || /^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
    return false;
  }
}
