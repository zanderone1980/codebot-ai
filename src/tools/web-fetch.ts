import { Tool } from '../types';
import { cacheGet, cacheSet } from '../offline-cache';
import { validateAndPinOutboundUrl } from '../net-guard';
import { fetch as undiciFetch } from 'undici';

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

  private validateUrl(url: string): string | null {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      return 'Invalid URL';
    }

    // Only allow http and https protocols
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      return `Blocked protocol: ${parsed.protocol} — only http/https allowed`;
    }

    // Block requests to private/internal IPs
    const hostname = parsed.hostname.toLowerCase();

    // Block localhost variants
    if (hostname === 'localhost' || hostname === '::1' || hostname === '0.0.0.0') {
      return 'Blocked: requests to localhost are not allowed';
    }

    // Block cloud metadata endpoints
    if (hostname === '169.254.169.254' || hostname === 'metadata.google.internal') {
      return 'Blocked: requests to cloud metadata endpoints are not allowed';
    }

    // Block private IPv4 ranges
    const ipMatch = hostname.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (ipMatch) {
      const [, a, b] = ipMatch.map(Number);
      if (a === 127) return 'Blocked: loopback IP range (127.x.x.x)'; // Full 127.0.0.0/8
      if (a === 10) return 'Blocked: private IP range (10.x.x.x)';
      if (a === 172 && b >= 16 && b <= 31) return 'Blocked: private IP range (172.16-31.x.x)';
      if (a === 192 && b === 168) return 'Blocked: private IP range (192.168.x.x)';
      if (a === 0) return 'Blocked: invalid IP (0.x.x.x)';
      if (a === 169 && b === 254) return 'Blocked: link-local IP (169.254.x.x)';
    }

    // ── v1.6.0 security hardening: IPv6 private range blocking ──

    // Remove brackets for IPv6 addresses
    const bare = hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();

    // IPv6 loopback
    if (bare === '::1' || bare === '0:0:0:0:0:0:0:1') {
      return 'Blocked: IPv6 loopback (::1)';
    }

    // IPv6 link-local (fe80::/10)
    if (/^fe[89ab][0-9a-f]:/i.test(bare)) {
      return 'Blocked: IPv6 link-local address (fe80::/10)';
    }

    // IPv6 unique local address (fc00::/7 — includes fd00::/8)
    if (/^f[cd][0-9a-f]{2}:/i.test(bare)) {
      return 'Blocked: IPv6 unique local address (fc00::/7)';
    }

    // IPv6 multicast (ff00::/8)
    if (/^ff[0-9a-f]{2}:/i.test(bare)) {
      return 'Blocked: IPv6 multicast address (ff00::/8)';
    }

    // IPv6-mapped IPv4 addresses (::ffff:x.x.x.x)
    const mappedMatch = bare.match(/^::ffff:(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
    if (mappedMatch) {
      const [, a, b] = mappedMatch.map(Number);
      if (a === 127) return 'Blocked: IPv4-mapped loopback';
      if (a === 10) return 'Blocked: IPv4-mapped private IP';
      if (a === 172 && b >= 16 && b <= 31) return 'Blocked: IPv4-mapped private IP';
      if (a === 192 && b === 168) return 'Blocked: IPv4-mapped private IP';
      if (a === 0) return 'Blocked: IPv4-mapped invalid IP';
      if (a === 169 && b === 254) return 'Blocked: IPv4-mapped link-local';
    }

    return null; // URL is safe
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const url = args.url as string;
    if (!url) return 'Error: url is required';
    const method = (args.method as string) || 'GET';

    // P2-1 (2025): literal + DNS check. validateOutboundUrl caught
    // hostnames that resolved to private IPs — not just literal loopbacks.
    //
    // 2026-04-23 (external review): the P2-1 check resolved once here and
    // `fetch` resolved again before connecting. A DNS-rebinding attacker
    // could return a public IP on the first query and a private IP on the
    // second. Fixed by `validateAndPinOutboundUrl`: it resolves once,
    // deny-list-checks, and hands back a dispatcher whose connect-time
    // lookup is pinned to the already-validated IP. No second resolve.
    const pin = await validateAndPinOutboundUrl(url);
    if (pin.blockReason) return `Error: ${pin.blockReason}`;
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
      // AbortController covers both connection AND body reading (res.text())
      const controller = new AbortController();
      const bodyTimeout = setTimeout(() => controller.abort(), 30_000);

      // Use undici's fetch when we have a pinned dispatcher so the IP
      // we validated is the IP that gets dialed. Fall back to the global
      // fetch only for IP-literal URLs where no pin is needed.
      const res = pin.dispatcher
        ? await undiciFetch(url, {
            method,
            headers,
            body,
            signal: controller.signal,
            dispatcher: pin.dispatcher,
          })
        : await fetch(url, {
            method,
            headers,
            body,
            signal: controller.signal,
          });

      const contentType = res.headers.get('content-type') || '';
      let responseText: string;
      try {
        responseText = await res.text();
      } finally {
        clearTimeout(bodyTimeout);
      }

      // Truncate very large responses
      const maxLen = 50000;
      const truncated = responseText.length > maxLen
        ? responseText.substring(0, maxLen) + `\n\n... (truncated, ${responseText.length} total chars)`
        : responseText;

      const statusLine = `HTTP ${res.status} ${res.statusText}`;

      // Cache successful GET responses for offline fallback (1h TTL)
      if (method === 'GET' && res.ok) {
        const cacheKey = `web_fetch:${url}`;
        const cacheValue = contentType.includes('text/html') ? this.htmlToText(truncated) : truncated;
        cacheSet(cacheKey, cacheValue, 3_600_000);
      }

      // For HTML, strip tags to get readable text
      if (contentType.includes('text/html')) {
        const text = this.htmlToText(truncated);
        return `${statusLine}\n\n${text}`;
      }

      return `${statusLine}\n\n${truncated}`;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);

      // Offline fallback: serve from cache if network fails (GET only)
      if (method === 'GET') {
        const cacheKey = `web_fetch:${url}`;
        const cached = cacheGet(cacheKey);
        if (cached) {
          return `[Offline — cached response]\n\n${cached}`;
        }
      }

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
