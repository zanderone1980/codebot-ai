import { Tool } from '../types';
import { validateAndPinOutboundUrl } from '../net-guard';
import { fetch as undiciFetch } from 'undici';

export class HttpClientTool implements Tool {
  name = 'http_client';
  description = 'Make HTTP requests. Supports GET, POST, PUT, DELETE, PATCH with headers, auth, and body.';
  permission: Tool['permission'] = 'prompt';
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

    // P2-1 fix (2025): literal + DNS check. validateOutboundUrl caught
    // hostnames that resolved to private IPs — not just literal loopbacks.
    //
    // 2026-04-23 (external review): the P2-1 check resolved once here and
    // `fetch` resolved again before connecting. A DNS-rebinding attacker
    // could return a public IP on the first query and a private IP on the
    // second. Fixed by `validateAndPinOutboundUrl`: resolves once,
    // deny-lists, and hands back a dispatcher whose connect-time lookup is
    // pinned to the already-validated IP. No second resolve.
    try {
      new URL(url);
    } catch {
      return `Error: invalid URL: ${url}`;
    }
    const pin = await validateAndPinOutboundUrl(url);
    if (pin.blockReason) {
      // Keep the legacy wording ("blocked for security") that downstream
      // tooling/tests grep for; append the specific reason in parens.
      if (/^Invalid URL/.test(pin.blockReason)) return `Error: invalid URL: ${url}`;
      if (/^Blocked protocol/.test(pin.blockReason)) {
        return `Error: requests to unsupported protocols are blocked for security (${pin.blockReason}).`;
      }
      return `Error: requests to private/local addresses are blocked for security (${pin.blockReason}).`;
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
      // Use undici's fetch when we have a pinned dispatcher so the IP we
      // validated is the IP that gets dialed. Fall back to the global
      // fetch only for IP-literal URLs where no pin is needed.
      const res = pin.dispatcher
        ? await undiciFetch(url, {
            method,
            headers,
            body: ['GET', 'HEAD'].includes(method) ? undefined : body,
            signal: controller.signal,
            dispatcher: pin.dispatcher,
          })
        : await fetch(url, {
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

}
