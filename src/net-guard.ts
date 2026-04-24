/**
 * Outbound-network safety guard with DNS resolution + IP pinning.
 *
 * ── History ──
 * P2-1: the original SSRF checks only inspected the literal hostname.
 * `internal.evil.example.com` → 10.0.0.1 passed validation because the
 * string was neither an IP nor a loopback. Fixed by resolving and
 * deny-listing every returned IP.
 *
 * 2026-04-23 external review: the P2-1 code resolves once *before* fetch
 * and fetch then resolves again *before* connecting. Between those two
 * lookups an attacker-controlled DNS server can flip the answer
 * (DNS rebinding). Narrow window but exploitable. Mitigated here by
 * *pinning the resolved IP into the dispatcher used by fetch* so the
 * connection never re-resolves — what passed validation is what gets
 * dialed.
 *
 * ── Usage ──
 *     const { blockReason, dispatcher } = await validateAndPinOutboundUrl(url);
 *     if (blockReason) return `Error: ${blockReason}`;
 *     const res = await fetch(url, { dispatcher });
 *
 * `validateOutboundUrl` is retained for callers that only need a yes/no
 * verdict (and accept the TOCTOU window). New callers should use the
 * pinned variant.
 *
 * ── Design notes ──
 *   - Pure functions + one async boundary at the DNS step.
 *   - `ipIsPrivate` centralizes the range table so future tweaks (e.g.
 *     adding a customer-defined allow/deny range) happen in one place.
 *   - `dns.lookup` with `all: true` returns every address the OS resolver
 *     would use. We check every one; a multi-record response with even
 *     one private address is blocked.
 *   - A hostname that doesn't resolve at all → we do NOT block it.
 *     Let the fetch fail with its own (more informative) error.
 *   - The pinned dispatcher uses undici's custom `connect.lookup`. When
 *     the actual TCP connect fires, it calls our lookup function which
 *     returns the pre-resolved IP — no second DNS round-trip, no race.
 */

import { lookup as dnsLookup, LookupAddress } from 'dns';
import { promisify } from 'util';
import { Agent as UndiciAgent, Dispatcher } from 'undici';

const lookupAsync = promisify(dnsLookup);

/**
 * Return a human-readable block reason if the IP is in a private /
 * loopback / link-local / ULA / metadata / multicast / reserved range.
 * Returns null if the IP is safe to dial.
 *
 * Handles both IPv4 ("10.0.0.1") and IPv6 ("fd00::1", "::ffff:10.0.0.1").
 */
export function ipIsPrivate(ip: string): string | null {
  if (!ip) return 'Blocked: empty IP';
  const lower = ip.toLowerCase().replace(/^\[/, '').replace(/\]$/, '');

  // ── IPv4 literal ─────────────────────────────────────────────────
  const v4 = lower.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const [, a, b] = v4.map(Number);
    if (a === 127) return `Blocked: loopback IP (${ip})`;
    if (a === 10) return `Blocked: private IP 10.x.x.x (${ip})`;
    if (a === 172 && b >= 16 && b <= 31) return `Blocked: private IP 172.16-31.x.x (${ip})`;
    if (a === 192 && b === 168) return `Blocked: private IP 192.168.x.x (${ip})`;
    if (a === 0) return `Blocked: reserved IP 0.x.x.x (${ip})`;
    if (a === 169 && b === 254) return `Blocked: link-local IP 169.254.x.x (${ip})`;
    if (a >= 224) return `Blocked: multicast/reserved IP ${a}.x.x.x (${ip})`;
    // Cloud metadata endpoint (literal match)
    if (ip === '169.254.169.254') return `Blocked: cloud metadata endpoint (${ip})`;
    return null;
  }

  // ── IPv6 literal ─────────────────────────────────────────────────
  if (lower === '::1' || lower === '0:0:0:0:0:0:0:1') return `Blocked: IPv6 loopback (${ip})`;
  if (lower === '::' || lower === '0:0:0:0:0:0:0:0') return `Blocked: IPv6 unspecified (${ip})`;
  if (/^fe[89ab][0-9a-f]:/i.test(lower)) return `Blocked: IPv6 link-local fe80::/10 (${ip})`;
  if (/^f[cd][0-9a-f]{2}:/i.test(lower)) return `Blocked: IPv6 unique local fc00::/7 (${ip})`;
  if (/^ff[0-9a-f]{2}:/i.test(lower)) return `Blocked: IPv6 multicast ff00::/8 (${ip})`;

  // IPv4-mapped IPv6 (::ffff:a.b.c.d) — delegate to v4 check
  const mapped = lower.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) {
    const v4reason = ipIsPrivate(mapped[1]);
    if (v4reason) return `Blocked: IPv4-mapped ${v4reason.replace(/^Blocked:\s*/, '')}`;
    return null;
  }

  return null;
}

/**
 * Cheap pre-filter on a hostname that is obviously a name (not an IP,
 * not "localhost"). We call this BEFORE DNS resolution so obvious
 * bad cases fail fast.
 */
export function checkHostnameLiteral(hostname: string): string | null {
  if (!hostname) return 'Blocked: empty hostname';
  const lower = hostname.toLowerCase();

  // Named loopbacks / metadata
  if (lower === 'localhost') return 'Blocked: localhost';
  if (lower === '0.0.0.0') return 'Blocked: 0.0.0.0';
  if (lower === 'metadata.google.internal') return 'Blocked: GCP metadata endpoint';
  if (lower === 'metadata') return 'Blocked: metadata shorthand';

  // Literal IP addresses — delegate to ipIsPrivate
  const bare = lower.replace(/^\[/, '').replace(/\]$/, '');
  if (/^[\d.]+$/.test(bare) || bare.includes(':')) {
    return ipIsPrivate(bare);
  }
  return null;
}

/**
 * Resolve the hostname and reject if ANY returned address is in a
 * private range. `dns.lookup(..., { all: true })` returns every
 * address the OS resolver would use — which is exactly what the real
 * fetch call will see next, so the check and the fetch stay in sync.
 */
export async function resolveAndCheck(hostname: string): Promise<string | null> {
  let addresses: Array<{ address: string; family: number }>;
  try {
    addresses = await lookupAsync(hostname, { all: true });
  } catch {
    // DNS failure: we don't block here — let the actual fetch fail
    // with its own error, which is more informative to the user than
    // "blocked due to unresolvable hostname" (which it isn't).
    return null;
  }
  for (const { address } of addresses) {
    const reason = ipIsPrivate(address);
    if (reason) {
      return `${reason} — hostname "${hostname}" resolved to ${address}`;
    }
  }
  return null;
}

/**
 * One-call safety check for outbound URLs. Returns a block reason
 * string, or null if the URL is safe to fetch.
 *
 * Also rejects non-http(s) protocols up front since file:// / gopher://
 * / data:// URLs shouldn't go through a fetch tool.
 *
 * NOTE: this verdict-only API is vulnerable to DNS-rebinding TOCTOU
 * because the actual `fetch` call resolves the hostname again. For
 * hardened callers (web_fetch, http_client), use
 * `validateAndPinOutboundUrl` — it returns a dispatcher that uses the
 * already-resolved IP, eliminating the re-resolve.
 */
export async function validateOutboundUrl(url: string): Promise<string | null> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return `Invalid URL: ${url}`;
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return `Blocked protocol: ${parsed.protocol} — only http/https allowed`;
  }
  const literal = checkHostnameLiteral(parsed.hostname);
  if (literal) return literal;

  // If the hostname was a literal IP, the literal check has already
  // answered and we return null here without a DNS round-trip.
  const bare = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '');
  const isIpLiteral = /^[\d.]+$/.test(bare) || bare.includes(':');
  if (isIpLiteral) return null;

  return resolveAndCheck(parsed.hostname);
}

// ── IP-pinned outbound (TOCTOU-safe) ──────────────────────────────────

/** Result of a validate-and-pin call. */
export interface PinnedOutbound {
  /** Non-null if the URL must not be fetched. */
  blockReason: string | null;
  /** The resolved IP the dispatcher is pinned to (null if blocked or IP literal). */
  resolvedIp: string | null;
  /** Undici dispatcher with a custom lookup pinned to resolvedIp. Null if blocked. */
  dispatcher: Dispatcher | null;
}

/**
 * Build an undici Agent whose connection lookup always returns the
 * pinned address. Every TCP connect made through this dispatcher
 * bypasses re-resolution — the hostname goes through SNI/Host header
 * untouched, but the connection dials `pinnedIp`.
 */
export function createPinnedDispatcher(pinnedIp: string, family: 4 | 6): Dispatcher {
  // Signature matches Node's dns.lookup callback form, which is exactly
  // what undici's `connect.lookup` wants. We always return the
  // pre-resolved address with the correct family so the http stack dials
  // the already-validated IP instead of doing a second DNS round-trip.
  //
  // Modern Node (22+) calls the resolver in `all: true` mode and expects
  // the callback to fire with an array of `{ address, family }` records.
  // We detect the mode from `opts.all` and match its contract exactly —
  // otherwise `net.emitLookup` reads `.address` off `undefined` and throws
  // ERR_INVALID_IP_ADDRESS.
  const pinnedLookup = (
    _hostname: string,
    opts: { all?: boolean } | number | undefined,
    cb: (
      err: NodeJS.ErrnoException | null,
      addressOrArray: string | Array<{ address: string; family: number }>,
      family?: number,
    ) => void,
  ): void => {
    const wantsAll = typeof opts === 'object' && opts !== null && opts.all === true;
    if (wantsAll) {
      cb(null, [{ address: pinnedIp, family }]);
    } else {
      cb(null, pinnedIp, family);
    }
  };
  return new UndiciAgent({
    connect: {
      lookup: pinnedLookup as unknown as UndiciAgent.Options['connect'] extends { lookup?: infer L } ? L : never,
    },
  });
}

/**
 * Pick the first safe address from a resolver response. Returns the
 * block reason if any returned address is private (multi-record
 * responses with even one private IP are blocked — safer than picking
 * only the public one).
 */
function pickPinnedAddress(addresses: LookupAddress[]): { address: LookupAddress | null; reason: string | null } {
  if (addresses.length === 0) {
    return { address: null, reason: 'DNS returned no addresses' };
  }
  for (const addr of addresses) {
    const reason = ipIsPrivate(addr.address);
    if (reason) return { address: null, reason };
  }
  return { address: addresses[0], reason: null };
}

/**
 * Hardened outbound URL validation: resolves the hostname, checks every
 * returned address against the deny-list, and returns a dispatcher
 * pinned to the resolved IP. The caller passes the dispatcher to
 * `fetch(url, { dispatcher })`; fetch then reuses the pin instead of
 * performing its own second resolve.
 *
 * IP literal URLs skip the DNS step — the literal is already the final
 * address and either passes or fails the deny-list on its own.
 */
export async function validateAndPinOutboundUrl(url: string): Promise<PinnedOutbound> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return { blockReason: `Invalid URL: ${url}`, resolvedIp: null, dispatcher: null };
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    return {
      blockReason: `Blocked protocol: ${parsed.protocol} — only http/https allowed`,
      resolvedIp: null,
      dispatcher: null,
    };
  }

  const literal = checkHostnameLiteral(parsed.hostname);
  if (literal) return { blockReason: literal, resolvedIp: null, dispatcher: null };

  const bare = parsed.hostname.replace(/^\[/, '').replace(/\]$/, '');
  const isIpLiteral = /^[\d.]+$/.test(bare) || bare.includes(':');
  if (isIpLiteral) {
    // IP literal already passed the deny-list via checkHostnameLiteral.
    // No pin needed; the default dispatcher is fine because there's no
    // hostname → IP step left to spoof.
    return { blockReason: null, resolvedIp: bare, dispatcher: null };
  }

  let addresses: LookupAddress[];
  try {
    addresses = await lookupAsync(parsed.hostname, { all: true });
  } catch {
    // Unresolvable — don't block. Fetch will fail with a clearer error.
    return { blockReason: null, resolvedIp: null, dispatcher: null };
  }

  const pick = pickPinnedAddress(addresses);
  if (pick.reason) {
    return {
      blockReason: `${pick.reason} — hostname "${parsed.hostname}"`,
      resolvedIp: null,
      dispatcher: null,
    };
  }
  if (!pick.address) {
    return { blockReason: null, resolvedIp: null, dispatcher: null };
  }

  const family = pick.address.family === 6 ? 6 : 4;
  const dispatcher = createPinnedDispatcher(pick.address.address, family);
  return {
    blockReason: null,
    resolvedIp: pick.address.address,
    dispatcher,
  };
}
