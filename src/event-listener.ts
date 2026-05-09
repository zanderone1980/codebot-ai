/**
 * Event listener — HTTP receiver for signed inbound events.
 *
 * Closes the "no real-time subscriptions" gap from the code-quality audit:
 * CodeBot can now react to GitHub webhooks, Slack events, CI hooks, etc.,
 * with the same hash-chained audit guarantee as every other tool call.
 *
 * Flow:
 *   inbound POST → HMAC verify → audit-chain → optional dispatch → response
 *
 * Security model:
 *   - HMAC-SHA256 over (timestamp + body) using a shared secret
 *   - 5-minute timestamp window to defeat replay
 *   - Constant-time HMAC compare (crypto.timingSafeEqual)
 *   - Bodies > MAX_BODY_BYTES rejected
 *   - HTTP only — TLS termination is the operator's job (reverse proxy)
 *
 * Audit guarantee:
 *   - Every accepted event writes a `webhook_received` entry FIRST,
 *     before any dispatch decision. Tampering after the fact breaks
 *     the chain.
 *   - Rejections (bad signature, replay, oversize) write a
 *     `webhook_rejected` entry so forgery attempts are forensically
 *     visible.
 *   - Dispatches write a `webhook_dispatched` entry referencing the
 *     received entry's hash.
 */

import * as http from 'http';
import * as crypto from 'crypto';
import { AuditLogger } from './audit';

/** Maximum request body in bytes. 1 MB is plenty for any webhook payload. */
const MAX_BODY_BYTES = 1_000_000;

/** Replay window in seconds. Older signed events are rejected. */
const TIMESTAMP_WINDOW_SEC = 5 * 60;

/** Header carrying the HMAC-SHA256 hex digest. */
const HEADER_SIGNATURE = 'x-codebot-signature';

/** Header carrying the unix-epoch timestamp the signature is over. */
const HEADER_TIMESTAMP = 'x-codebot-timestamp';

/** Header carrying the event type (free-form, e.g. 'github.pr.opened'). */
const HEADER_EVENT_TYPE = 'x-codebot-event';

export interface EventListenerOptions {
  /** TCP port to bind. */
  port: number;
  /** Shared secret for HMAC. Required — there is no unauthenticated mode. */
  secret: string;
  /** Bind address. Defaults to 127.0.0.1; set to '0.0.0.0' to expose. */
  host?: string;
  /** Audit logger to chain events into. Caller owns the logger lifecycle. */
  audit: AuditLogger;
  /**
   * Optional dispatch hook. Invoked AFTER the receive entry is written.
   * The hook returns a free-form summary that is written to the
   * `webhook_dispatched` audit entry. Errors are caught and audited.
   */
  onEvent?: (event: ReceivedEvent) => Promise<string>;
}

export interface ReceivedEvent {
  /** Resolved event type from `x-codebot-event` header. */
  type: string;
  /** Parsed JSON body. Any other content type → `{ raw: string }`. */
  body: Record<string, unknown>;
  /** Unix-epoch seconds when the sender claims to have signed. */
  timestamp: number;
  /** Hash of the audit entry that recorded this receive. */
  receiveAuditHash: string;
}

/** Result of one HTTP request, surfaced for tests. */
export interface HandleResult {
  status: number;
  reason: string;
  /** Audit hash of the `webhook_received` entry, if accepted. */
  receiveAuditHash?: string;
  /** Audit hash of the `webhook_dispatched` entry, if a dispatch ran. */
  dispatchAuditHash?: string;
}

/** Compute the canonical signing string. Stable across senders. */
function canonicalSigningInput(timestamp: string, body: string): string {
  return `${timestamp}.${body}`;
}

/** Verify HMAC-SHA256 in constant time. Returns true iff signatures match. */
function verifySignature(secret: string, signingInput: string, providedHex: string): boolean {
  if (!/^[0-9a-fA-F]+$/.test(providedHex)) return false;
  const expected = crypto.createHmac('sha256', secret).update(signingInput).digest();
  let provided: Buffer;
  try {
    provided = Buffer.from(providedHex, 'hex');
  } catch {
    return false;
  }
  if (provided.length !== expected.length) return false;
  return crypto.timingSafeEqual(provided, expected);
}

/**
 * Read the request body up to the byte cap. Resolves with the body as a
 * string, or rejects with 'too_large' if the cap is hit.
 */
function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        req.destroy();
        reject(new Error('too_large'));
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf-8')));
    req.on('error', (err) => reject(err));
  });
}

/**
 * Process one inbound HTTP request. Pure function over (req, body) so it
 * can be tested without standing up a real server.
 *
 * NEVER throws — all errors become structured audit entries + HTTP responses.
 */
export async function handleInboundEvent(
  rawBody: string,
  headers: Record<string, string | undefined>,
  opts: EventListenerOptions,
): Promise<HandleResult> {
  const sig = headers[HEADER_SIGNATURE];
  const tsHeader = headers[HEADER_TIMESTAMP];
  const eventType = headers[HEADER_EVENT_TYPE] || 'unknown';

  // Reject early if mandatory headers are missing — record as rejected.
  if (!sig || !tsHeader) {
    opts.audit.log({
      tool: 'event-listener',
      action: 'webhook_rejected',
      args: { eventType, reason: 'missing_headers' },
      reason: 'Required headers x-codebot-signature and x-codebot-timestamp missing',
    });
    return { status: 400, reason: 'missing_headers' };
  }

  const timestamp = Number(tsHeader);
  if (!Number.isFinite(timestamp)) {
    opts.audit.log({
      tool: 'event-listener',
      action: 'webhook_rejected',
      args: { eventType, reason: 'bad_timestamp', tsHeader },
    });
    return { status: 400, reason: 'bad_timestamp' };
  }

  const nowSec = Math.floor(Date.now() / 1000);
  if (Math.abs(nowSec - timestamp) > TIMESTAMP_WINDOW_SEC) {
    opts.audit.log({
      tool: 'event-listener',
      action: 'webhook_rejected',
      args: { eventType, reason: 'stale_timestamp', skewSec: nowSec - timestamp },
    });
    return { status: 400, reason: 'stale_timestamp' };
  }

  const signingInput = canonicalSigningInput(tsHeader, rawBody);
  if (!verifySignature(opts.secret, signingInput, sig)) {
    opts.audit.log({
      tool: 'event-listener',
      action: 'webhook_rejected',
      args: { eventType, reason: 'bad_signature' },
    });
    return { status: 401, reason: 'bad_signature' };
  }

  // Parse body. JSON preferred; fall back to raw text envelope.
  let body: Record<string, unknown>;
  try {
    const parsed = JSON.parse(rawBody);
    body = parsed && typeof parsed === 'object' && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : { value: parsed };
  } catch {
    body = { raw: rawBody };
  }

  // Hash-chain the receive BEFORE any dispatch.
  opts.audit.log({
    tool: 'event-listener',
    action: 'webhook_received',
    args: { eventType, timestamp, bodyKeys: Object.keys(body).slice(0, 16) },
  });

  // Re-fetch the most recent entry hash by re-querying for our session.
  // This is the receive-entry hash for chain-of-custody.
  const sessionEntries = opts.audit.query({ sessionId: opts.audit.getSessionId(), action: 'webhook_received' });
  const lastReceive = sessionEntries[sessionEntries.length - 1];
  const receiveAuditHash = lastReceive?.hash ?? '';

  const event: ReceivedEvent = { type: eventType, body, timestamp, receiveAuditHash };

  if (!opts.onEvent) {
    return { status: 200, reason: 'received', receiveAuditHash };
  }

  let dispatchSummary: string;
  try {
    dispatchSummary = await opts.onEvent(event);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    opts.audit.log({
      tool: 'event-listener',
      action: 'webhook_dispatched',
      args: { eventType, receiveAuditHash, ok: false, error: msg.substring(0, 200) },
    });
    return { status: 500, reason: 'dispatch_failed', receiveAuditHash };
  }

  opts.audit.log({
    tool: 'event-listener',
    action: 'webhook_dispatched',
    args: { eventType, receiveAuditHash, ok: true, summary: dispatchSummary.substring(0, 500) },
  });

  const dispatched = opts.audit.query({ sessionId: opts.audit.getSessionId(), action: 'webhook_dispatched' });
  const lastDispatch = dispatched[dispatched.length - 1];

  return {
    status: 200,
    reason: 'dispatched',
    receiveAuditHash,
    dispatchAuditHash: lastDispatch?.hash,
  };
}

/**
 * Long-running HTTP server wrapping handleInboundEvent. Caller is
 * responsible for `start()` / `stop()` lifecycle and signal handling.
 */
export class EventListener {
  private server: http.Server | null = null;
  private opts: EventListenerOptions;

  constructor(opts: EventListenerOptions) {
    if (!opts.secret || opts.secret.length < 16) {
      throw new Error('event-listener: secret must be at least 16 characters');
    }
    if (!Number.isInteger(opts.port) || opts.port < 1 || opts.port > 65535) {
      throw new Error('event-listener: port must be 1-65535');
    }
    this.opts = opts;
  }

  async start(): Promise<{ port: number }> {
    if (this.server) throw new Error('event-listener: already started');
    return new Promise((resolve, reject) => {
      const server = http.createServer(async (req, res) => {
        try {
          if (req.method !== 'POST' || req.url !== '/event') {
            res.statusCode = 404;
            res.end('Not Found');
            return;
          }
          let body: string;
          try {
            body = await readBody(req);
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            this.opts.audit.log({
              tool: 'event-listener',
              action: 'webhook_rejected',
              args: { reason: msg === 'too_large' ? 'too_large' : 'read_error' },
            });
            res.statusCode = msg === 'too_large' ? 413 : 400;
            res.end(msg);
            return;
          }
          const headers: Record<string, string | undefined> = {};
          for (const [k, v] of Object.entries(req.headers)) {
            headers[k.toLowerCase()] = Array.isArray(v) ? v[0] : v;
          }
          const result = await handleInboundEvent(body, headers, this.opts);
          res.statusCode = result.status;
          res.setHeader('content-type', 'application/json');
          res.end(JSON.stringify({
            ok: result.status >= 200 && result.status < 300,
            reason: result.reason,
            receiveAuditHash: result.receiveAuditHash,
            dispatchAuditHash: result.dispatchAuditHash,
          }));
        } catch (err) {
          // Last-resort guard. handleInboundEvent doesn't throw, but the
          // server-level wrapping must not crash the process.
          if (!res.writableEnded) {
            res.statusCode = 500;
            try { res.end('Internal Server Error'); } catch {}
          }
          // Best-effort audit; if even this fails we swallow.
          try {
            this.opts.audit.log({
              tool: 'event-listener',
              action: 'webhook_rejected',
              args: { reason: 'unexpected_error', error: (err as Error).message?.substring(0, 200) },
            });
          } catch {}
        }
      });
      server.once('error', reject);
      server.listen(this.opts.port, this.opts.host ?? '127.0.0.1', () => {
        this.server = server;
        const addr = server.address();
        const actualPort = typeof addr === 'object' && addr ? addr.port : this.opts.port;
        resolve({ port: actualPort });
      });
    });
  }

  async stop(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve) => {
      this.server!.close(() => resolve());
    });
    this.server = null;
  }

  /** Expose for tests so they can verify "is the server actually listening" without timing. */
  isListening(): boolean { return this.server !== null && this.server.listening; }
}

/** Helper for senders + tests: produce the headers a valid request needs. */
export function signEvent(
  secret: string,
  body: string,
  eventType: string,
  timestamp: number = Math.floor(Date.now() / 1000),
): Record<string, string> {
  const ts = String(timestamp);
  const sig = crypto.createHmac('sha256', secret).update(canonicalSigningInput(ts, body)).digest('hex');
  return {
    [HEADER_SIGNATURE]: sig,
    [HEADER_TIMESTAMP]: ts,
    [HEADER_EVENT_TYPE]: eventType,
    'content-type': 'application/json',
  };
}
