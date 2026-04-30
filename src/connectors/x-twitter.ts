/**
 * X (Twitter) Connector — X API v2.
 *
 * Auth: JSON credential bundle with OAuth 1.0a keys for posting:
 *   { "apiKey", "apiSecret", "accessToken", "accessSecret" }
 * Or env vars: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET.
 *
 * §8 Connector Contract (PR 20)
 * -----------------------------
 * Five actions. Two reads + three writes. The writes are the riskiest
 * surface in the entire connector ladder — public posting is
 * irreversible (screenshotted, archived, indexed) and per §2 of
 * `docs/personal-agent-infrastructure.md` is **always-ask, every time**.
 *
 *   get_me          — read   ['read-only', 'account-access', 'net-fetch']
 *   search_tweets   — read   ['read-only', 'account-access', 'net-fetch']
 *
 *   post_tweet      — write  ['account-access', 'net-fetch', 'send-on-behalf']
 *                     idempotency: { kind: 'unsupported', reason: ... }
 *                     X API v2 has NO client-supplied idempotency key.
 *                     X DOES server-side-dedup recent identical text
 *                     (403 + "duplicate content"), but that is rejection
 *                     of repeated posts, not a safe-retry contract: the
 *                     dedup window is short, opaque, and applies only
 *                     to byte-identical text — not idempotent in any
 *                     meaningful sense for the agent.
 *
 *   post_thread     — write  ['account-access', 'net-fetch', 'send-on-behalf']
 *                     idempotency: { kind: 'unsupported', reason: ... }
 *                     The N-tweet thread is NOT atomic. If tweet 3 of 5
 *                     fails, tweets 1-2 are LIVE and PUBLIC; the agent
 *                     cannot roll them back. Each individual tweet
 *                     suffers the same no-idempotency-key gap as
 *                     post_tweet. Treat partial threads as a real
 *                     hazard, not an edge case.
 *
 *   delete_tweet    — write  ['account-access', 'net-fetch', 'send-on-behalf', 'delete-data']
 *                     idempotency: { kind: 'unsupported', reason: ... }
 *                     HTTP DELETE on /tweets/{id} is naturally
 *                     idempotent (404 once the tweet is gone), but the
 *                     API exposes no client-supplied key. The connector
 *                     documents the gap rather than equating natural
 *                     HTTP semantics with a server-checked dedup contract.
 *
 * Reauth detection (`isXAuthError`)
 * ---------------------------------
 * X API v2 errors carry `{ title, detail, type, status }`. Decision rules:
 *   - HTTP 401 → always reauth.
 *   - HTTP 429 → never reauth (rate limit, user retries).
 *   - HTTP 403 with title in {Unauthorized, Forbidden} → reauth.
 *   - HTTP 403 with detail naming "duplicate content" → NOT reauth
 *     (X's server-side dedup; this is success-shaped from a credentials
 *     standpoint).
 *   - HTTP 403 with detail naming "rate limit" or "abuse" → NOT reauth.
 *   - HTTP 422 (validation) → NOT reauth.
 *   - Anything else → NOT reauth (fail closed).
 *
 * `vaultKeyName: 'x'` declared explicitly.
 */

import { Connector, ConnectorAction, ConnectorPreview, ConnectorReauthError } from './base';
import * as crypto from 'crypto';

const BASE_URL = 'https://api.x.com/2';
const TIMEOUT = 15_000;
const MAX_TWEET_LENGTH = 280;

interface XCredentials {
  apiKey: string;
  apiSecret: string;
  accessToken: string;
  accessSecret: string;
}

function parseCredentials(credential: string): XCredentials {
  try {
    const parsed = JSON.parse(credential);
    if (parsed.apiKey && parsed.apiSecret && parsed.accessToken && parsed.accessSecret) {
      return parsed as XCredentials;
    }
  } catch { /* not JSON, try env assembly */ }
  const apiKey = process.env.X_API_KEY || process.env.TWITTER_API_KEY || '';
  const apiSecret = process.env.X_API_SECRET || process.env.TWITTER_API_SECRET || '';
  const accessToken = process.env.X_ACCESS_TOKEN || process.env.TWITTER_ACCESS_TOKEN || '';
  const accessSecret = process.env.X_ACCESS_SECRET || process.env.TWITTER_ACCESS_SECRET || '';
  if (!apiKey || !apiSecret || !accessToken || !accessSecret) {
    throw new Error(
      'X credentials incomplete. Provide JSON: { "apiKey", "apiSecret", "accessToken", "accessSecret" } ' +
      'or set env vars: X_API_KEY, X_API_SECRET, X_ACCESS_TOKEN, X_ACCESS_SECRET'
    );
  }
  return { apiKey, apiSecret, accessToken, accessSecret };
}

function generateOAuthHeader(method: string, url: string, creds: XCredentials): string {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const nonce = crypto.randomBytes(16).toString('hex');
  const params: Record<string, string> = {
    oauth_consumer_key: creds.apiKey,
    oauth_nonce: nonce,
    oauth_signature_method: 'HMAC-SHA1',
    oauth_timestamp: timestamp,
    oauth_token: creds.accessToken,
    oauth_version: '1.0',
  };
  const sortedParams = Object.keys(params).sort()
    .map(k => `${encodeURIComponent(k)}=${encodeURIComponent(params[k])}`)
    .join('&');
  const baseString = [
    method.toUpperCase(),
    encodeURIComponent(url),
    encodeURIComponent(sortedParams),
  ].join('&');
  const signingKey = `${encodeURIComponent(creds.apiSecret)}&${encodeURIComponent(creds.accessSecret)}`;
  const signature = crypto.createHmac('sha1', signingKey).update(baseString).digest('base64');
  params.oauth_signature = signature;
  return `OAuth ${Object.keys(params).sort()
    .map(k => `${encodeURIComponent(k)}="${encodeURIComponent(params[k])}"`)
    .join(', ')}`;
}

function hashAndLength(value: string): { hash: string; length: number } {
  return {
    hash: crypto.createHash('sha256').update(value).digest('hex').substring(0, 16),
    length: value.length,
  };
}

// ─── Reauth classifier (pure, no network) ─────────────────────────────────

interface XApiError {
  title?: string;
  detail?: string;
  type?: string;
  status?: number;
  errors?: Array<{ message?: string; code?: number }>;
}

const X_AUTH_TITLES: ReadonlySet<string> = new Set([
  'Unauthorized',
  'Forbidden',
]);

/**
 * Decide whether an X API response indicates a reauth-class failure.
 * Pure function. The 403-with-duplicate-content path is the trickiest:
 * it returns 403 not because credentials are bad but because X
 * server-side-dedupes recent identical text. We do NOT treat that as
 * a reauth condition (the user fixes the post, not the credentials).
 */
export function isXAuthError(status: number, body: XApiError | undefined): boolean {
  if (status === 401) return true;
  if (status === 429) return false;
  if (status === 422) return false;
  if (status !== 403) return false;
  const detail = String(body?.detail || '').toLowerCase();
  if (detail.includes('duplicate content')) return false;
  if (detail.includes('rate limit') || detail.includes('abuse') || detail.includes('quota')) return false;
  const title = String(body?.title || '');
  if (X_AUTH_TITLES.has(title)) return true;
  return false;
}

// ─── HTTP wrapper ─────────────────────────────────────────────────────────

async function xApiCall(
  method: string,
  endpoint: string,
  creds: XCredentials,
  body?: Record<string, unknown>,
): Promise<{ ok: boolean; status: number; data: Record<string, unknown> }> {
  const url = `${BASE_URL}${endpoint}`;
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const bodyStr = body ? JSON.stringify(body) : undefined;
    const authHeader = generateOAuthHeader(method, url, creds);
    const res = await fetch(url, {
      method,
      headers: {
        'Authorization': authHeader,
        'Content-Type': 'application/json',
      },
      body: bodyStr,
      signal: controller.signal,
    });
    clearTimeout(timer);
    let data: Record<string, unknown> = {};
    if (res.status !== 204) {
      try { data = await res.json() as Record<string, unknown>; } catch { data = {}; }
    }
    if (isXAuthError(res.status, data as XApiError)) {
      throw new ConnectorReauthError('x', `X auth failed: HTTP ${res.status} title=${(data as XApiError).title || 'unknown'}`);
    }
    return { ok: res.ok, status: res.status, data };
  } catch (err: unknown) {
    clearTimeout(timer);
    throw err;
  }
}

// ─── Idempotency declaration constants ────────────────────────────────────

const POST_TWEET_IDEMPOTENCY_REASON =
  'X API v2 has no client-supplied idempotency key — there is no `idempotency_key` parameter and no `Idempotency-Key` header. X does server-side-dedupe byte-identical recent text (returning 403 + "duplicate content"), but that is rejection of repeated posts, not a safe-retry contract: the dedup window is short and opaque, and any change to the text bypasses dedup entirely. The connector does NOT treat the dedup behavior as idempotency.';

const POST_THREAD_IDEMPOTENCY_REASON =
  'Thread posting is NOT atomic. The connector posts each tweet in sequence; if tweet N fails, tweets 1..N-1 remain LIVE and PUBLIC, and the agent cannot roll them back. Each individual tweet suffers the same no-idempotency-key gap as post_tweet. Partial threads are a real hazard, not an edge case.';

const DELETE_TWEET_IDEMPOTENCY_REASON =
  'HTTP DELETE on /tweets/{id} is naturally idempotent at the protocol level (404 once the tweet is gone), but the X API exposes no client-supplied idempotency key. The connector documents this gap rather than equating natural HTTP semantics with a server-checked dedup contract.';

// ─── Redaction helpers (mutating verbs only) ──────────────────────────────

/** Redact tweet text to hash+length. Tweets become public on success
 *  but the audit row is written BEFORE that, may be denied, and may
 *  carry draft text that never went out — keep the audit row free of
 *  unposted draft content. The preview shows full text for human
 *  review; the audit carries the hash for forensic cross-reference. */
function redactPostTweetArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  if (typeof args.message === 'string' && args.message.length > 0) {
    const d = hashAndLength(args.message);
    out.message = `<redacted sha256:${d.hash} len:${d.length}>`;
  }
  return out;
}

function redactPostThreadArgs(args: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = { ...args };
  if (typeof args.tweets === 'string' && args.tweets.length > 0) {
    const tweets = args.tweets.split('|||').map(t => t.trim()).filter(Boolean);
    const totalLen = tweets.reduce((sum, t) => sum + t.length, 0);
    const d = hashAndLength(args.tweets);
    out.tweets = `<redacted ${tweets.length} tweet(s), total ${totalLen} chars sha256:${d.hash} len:${d.length}>`;
  }
  return out;
}

// ─── Preview functions (pure, no network) ─────────────────────────────────

function previewPostTweet(args: Record<string, unknown>): ConnectorPreview {
  const message = String(args.message ?? '');
  const replyTo = typeof args.reply_to === 'string' && args.reply_to.length > 0 ? args.reply_to : '';
  const digest = message.length > 0 ? hashAndLength(message) : null;
  const lengthOk = message.length <= MAX_TWEET_LENGTH;

  const lines = [
    `Would post tweet on X (PUBLIC):`,
    `  Text:        ${message}`,
    `  Length:      ${message.length}/${MAX_TWEET_LENGTH}${lengthOk ? '' : '  ⚠ OVER LIMIT — would error'}`,
    `  Hash:        sha256:${digest?.hash ?? '(empty)'}`,
    replyTo ? `  Reply to:    ${replyTo}` : `  Reply to:    (none — top-level tweet)`,
    `  Effect:      visible to anyone who can view your account; archived by third parties; indexed by search engines.`,
    `  Idempotency: NONE — once posted, the agent cannot un-post. Delete is a separate explicit action.`,
  ];
  return {
    summary: lines.join('\n'),
    details: {
      length: message.length,
      lengthOk,
      replyTo: replyTo || null,
      contentHash: digest?.hash ?? null,
      // Deliberately include full text in details so the preview UI
      // can render exactly what the user is approving. Audit-side
      // redaction is separate (see redactPostTweetArgs).
      fullText: message,
    },
  };
}

function previewPostThread(args: Record<string, unknown>): ConnectorPreview {
  const tweetsRaw = String(args.tweets ?? '');
  const tweets = tweetsRaw ? tweetsRaw.split('|||').map(t => t.trim()).filter(Boolean) : [];
  const overLimit = tweets.findIndex(t => t.length > MAX_TWEET_LENGTH);
  const digest = tweetsRaw.length > 0 ? hashAndLength(tweetsRaw) : null;

  const tweetLines = tweets.map((t, i) => {
    const ok = t.length <= MAX_TWEET_LENGTH;
    return `    ${i + 1}. [${t.length}/${MAX_TWEET_LENGTH}${ok ? '' : ' OVER'}] ${t}`;
  });

  const lines = [
    `Would post thread on X (PUBLIC):`,
    `  Count:       ${tweets.length} tweet(s)`,
    `  Hash:        sha256:${digest?.hash ?? '(empty)'}`,
    `  Tweets:`,
    ...tweetLines,
    overLimit >= 0 ? `  ⚠ Tweet ${overLimit + 1} exceeds ${MAX_TWEET_LENGTH} chars — execute would error early.` : '',
    `  ⚠ NOT atomic: if tweet N fails, tweets 1..N-1 stay LIVE. The agent cannot roll back.`,
    `  Idempotency: NONE — partial threads are a real hazard.`,
  ].filter(Boolean);

  return {
    summary: lines.join('\n'),
    details: {
      count: tweets.length,
      contentHash: digest?.hash ?? null,
      anyOverLimit: overLimit >= 0,
      fullTweets: tweets,
    },
  };
}

function previewDeleteTweet(args: Record<string, unknown>): ConnectorPreview {
  const tweetId = String(args.tweet_id ?? '');
  return {
    summary: [
      `Would DELETE tweet on X:`,
      `  Tweet ID:    ${tweetId}`,
      `  Effect:      removes the tweet from your timeline. Replies and quote-tweets remain on X but lose the parent. Cached versions on third-party indexes (Wayback, search engines, scrapers) MAY persist.`,
      `  Idempotency: HTTP DELETE is naturally idempotent (second call returns 404), but no server-checked dedup key exists.`,
    ].join('\n'),
    details: { tweetId },
  };
}

// ─── Action definitions ───────────────────────────────────────────────────

const postTweet: ConnectorAction = {
  name: 'post_tweet',
  description: 'Post a tweet on X. ALWAYS-ASK every call — public, irreversible.',
  parameters: {
    type: 'object',
    properties: {
      message: { type: 'string', description: 'Tweet text (max 280 characters)' },
      reply_to: { type: 'string', description: 'Tweet ID to reply to (for threads)' },
    },
    required: ['message'],
  },
  capabilities: ['account-access', 'net-fetch', 'send-on-behalf'],
  preview: async (args, _credential): Promise<ConnectorPreview> => previewPostTweet(args),
  redactArgsForAudit: redactPostTweetArgs,
  idempotency: { kind: 'unsupported', reason: POST_TWEET_IDEMPOTENCY_REASON },
  execute: async (args, cred) => {
    const message = args.message as string;
    if (!message) return 'Error: message is required';
    if (message.length > MAX_TWEET_LENGTH) {
      return `Error: tweet is ${message.length} characters (max ${MAX_TWEET_LENGTH}). Shorten it or split into a thread.`;
    }
    try {
      const creds = parseCredentials(cred);
      const body: Record<string, unknown> = { text: message };
      if (args.reply_to) body.reply = { in_reply_to_tweet_id: args.reply_to as string };
      const { ok, data } = await xApiCall('POST', '/tweets', creds, body);
      if (!ok) {
        const detail = (data as XApiError).detail || (data as XApiError).title || JSON.stringify(data);
        return `Error: X API: ${detail}`;
      }
      const tweetData = (data as { data?: { id?: string } }).data;
      const tweetId = tweetData?.id || 'unknown';
      const tweetUrl = `https://x.com/i/web/status/${tweetId}`;
      return `Tweet posted successfully!\nID: ${tweetId}\nURL: ${tweetUrl}\nText: ${message}`;
    } catch (err: unknown) {
      if (err instanceof ConnectorReauthError) throw err;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

const postThread: ConnectorAction = {
  name: 'post_thread',
  description: 'Post a multi-tweet thread on X. NOT atomic — partial failures leave a partial thread live.',
  parameters: {
    type: 'object',
    properties: {
      tweets: { type: 'string', description: 'Tweets separated by ||| (e.g., "First ||| Second ||| Third")' },
    },
    required: ['tweets'],
  },
  capabilities: ['account-access', 'net-fetch', 'send-on-behalf'],
  preview: async (args, _credential): Promise<ConnectorPreview> => previewPostThread(args),
  redactArgsForAudit: redactPostThreadArgs,
  idempotency: { kind: 'unsupported', reason: POST_THREAD_IDEMPOTENCY_REASON },
  execute: async (args, cred) => {
    const tweetsRaw = args.tweets as string;
    if (!tweetsRaw) return 'Error: tweets are required (separate with |||)';
    const tweets = tweetsRaw.split('|||').map(t => t.trim()).filter(Boolean);
    if (tweets.length < 2) return 'Error: thread needs at least 2 tweets (separate with |||)';
    for (let i = 0; i < tweets.length; i++) {
      if (tweets[i].length > MAX_TWEET_LENGTH) {
        return `Error: tweet ${i + 1} is ${tweets[i].length} chars (max ${MAX_TWEET_LENGTH})`;
      }
    }
    try {
      const creds = parseCredentials(cred);
      const results: string[] = [];
      let lastTweetId: string | null = null;
      for (let i = 0; i < tweets.length; i++) {
        const body: Record<string, unknown> = { text: tweets[i] };
        if (lastTweetId) body.reply = { in_reply_to_tweet_id: lastTweetId };
        const { ok, data } = await xApiCall('POST', '/tweets', creds, body);
        if (!ok) {
          const detail = (data as XApiError).detail || JSON.stringify(data);
          return `Error posting tweet ${i + 1}: ${detail}\nPosted ${i} of ${tweets.length} tweets — partial thread is LIVE on X. You may want to delete the posted tweets manually.`;
        }
        lastTweetId = ((data as { data?: { id?: string } }).data?.id) || null;
        results.push(`  ${i + 1}. ${tweets[i].substring(0, 50)}... → ${lastTweetId}`);
        if (i < tweets.length - 1) await new Promise(r => setTimeout(r, 500));
      }
      const threadUrl = `https://x.com/i/web/status/${lastTweetId || 'unknown'}`;
      return `Thread posted! (${tweets.length} tweets)\n${results.join('\n')}\nThread: ${threadUrl}`;
    } catch (err: unknown) {
      if (err instanceof ConnectorReauthError) throw err;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

const deleteTweet: ConnectorAction = {
  name: 'delete_tweet',
  description: 'Delete a tweet by ID. Irreversible from this account.',
  parameters: {
    type: 'object',
    properties: {
      tweet_id: { type: 'string', description: 'ID of the tweet to delete' },
    },
    required: ['tweet_id'],
  },
  capabilities: ['account-access', 'net-fetch', 'send-on-behalf', 'delete-data'],
  preview: async (args, _credential): Promise<ConnectorPreview> => previewDeleteTweet(args),
  // Identity redactor — tweet_id is already public information; the
  // audit row should preserve it so a forensic reader can identify
  // which tweet was removed. Written as a deliberate per-contract
  // declaration, not a silent default.
  redactArgsForAudit: (args: Record<string, unknown>): Record<string, unknown> => ({ ...args }),
  idempotency: { kind: 'unsupported', reason: DELETE_TWEET_IDEMPOTENCY_REASON },
  execute: async (args, cred) => {
    const tweetId = args.tweet_id as string;
    if (!tweetId) return 'Error: tweet_id is required';
    try {
      const creds = parseCredentials(cred);
      const { ok, data } = await xApiCall('DELETE', `/tweets/${encodeURIComponent(tweetId)}`, creds);
      if (!ok) {
        const detail = (data as XApiError).detail || JSON.stringify(data);
        return `Error: ${detail}`;
      }
      return `Tweet ${tweetId} deleted.`;
    } catch (err: unknown) {
      if (err instanceof ConnectorReauthError) throw err;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

const getMe: ConnectorAction = {
  name: 'get_me',
  description: 'Get the authenticated user profile',
  parameters: { type: 'object', properties: {} },
  capabilities: ['read-only', 'account-access', 'net-fetch'],
  execute: async (_args, cred) => {
    try {
      const creds = parseCredentials(cred);
      const { ok, data } = await xApiCall('GET', '/users/me?user.fields=public_metrics,description,created_at', creds);
      if (!ok) {
        const detail = (data as XApiError).detail || JSON.stringify(data);
        return `Error: ${detail}`;
      }
      const user = (data as { data?: Record<string, unknown> }).data;
      if (!user) return 'Error: no user data returned';
      const metrics = (user.public_metrics as { followers_count?: number; following_count?: number; tweet_count?: number }) || {};
      return [
        `@${user.username} (${user.name})`,
        user.description ? `Bio: ${user.description}` : '',
        `Followers: ${metrics.followers_count || 0} | Following: ${metrics.following_count || 0}`,
        `Tweets: ${metrics.tweet_count || 0}`,
        `Joined: ${user.created_at || 'unknown'}`,
      ].filter(Boolean).join('\n');
    } catch (err: unknown) {
      if (err instanceof ConnectorReauthError) throw err;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

const searchTweets: ConnectorAction = {
  name: 'search_tweets',
  description: 'Search recent tweets (last 7 days)',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query (X search syntax supported)' },
      count: { type: 'number', description: 'Number of results (default 10, max 100)' },
    },
    required: ['query'],
  },
  capabilities: ['read-only', 'account-access', 'net-fetch'],
  execute: async (args, cred) => {
    const query = args.query as string;
    if (!query) return 'Error: query is required';
    try {
      const creds = parseCredentials(cred);
      const count = Math.min((args.count as number) || 10, 100);
      const endpoint = `/tweets/search/recent?query=${encodeURIComponent(query)}&max_results=${count}&tweet.fields=created_at,public_metrics,author_id`;
      const { ok, data } = await xApiCall('GET', endpoint, creds);
      if (!ok) {
        const detail = (data as XApiError).detail || JSON.stringify(data);
        return `Error: ${detail}`;
      }
      const tweets = (data as { data?: Array<{ text: string; id: string; created_at: string; public_metrics?: { like_count: number; retweet_count: number } }> }).data;
      if (!tweets?.length) return `No tweets found for "${query}".`;
      const lines = tweets.map(t => {
        const metrics = t.public_metrics;
        const stats = metrics ? ` [hearts:${metrics.like_count} rt:${metrics.retweet_count}]` : '';
        return `  ${t.text.substring(0, 120)}${stats}\n    -> https://x.com/i/web/status/${t.id}`;
      });
      return `Search results (${tweets.length}):\n${lines.join('\n')}`;
    } catch (err: unknown) {
      if (err instanceof ConnectorReauthError) throw err;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

// ─── Connector ────────────────────────────────────────────────────────────

export class XTwitterConnector implements Connector {
  name = 'x';
  displayName = 'X (Twitter)';
  description = 'Post tweets, reply to threads, and search on X (Twitter).';
  authType: Connector['authType'] = 'api_key';
  envKey = 'X_API_KEY';
  requiredEnvKeys = ['X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET'];
  vaultKeyName = 'x';

  actions: ConnectorAction[] = [postTweet, postThread, deleteTweet, getMe, searchTweets];

  async validate(credential: string): Promise<boolean> {
    try {
      const creds = parseCredentials(credential);
      const { ok } = await xApiCall('GET', '/users/me', creds);
      return ok;
    } catch {
      return false;
    }
  }
}
