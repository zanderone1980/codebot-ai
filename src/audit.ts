import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { maskSecretsInString } from './secrets';
import { encryptLine, decryptLine } from './encryption';
import { codebotPath } from './paths';
import { warnNonFatal } from './warn';

/**
 * Audit logger for CodeBot v1.7.0
 *
 * Provides append-only JSONL logging of all security-relevant actions.
 * Logs are stored at ~/.codebot/audit/audit-YYYY-MM-DD.jsonl
 *
 * v1.7.0: Hash-chained entries for tamper detection.
 * Each entry includes a SHA-256 hash of (prevHash + entry content).
 * Verification walks the chain and detects any modifications.
 *
 * NEVER throws — audit failures must not crash the agent.
 */

export interface AuditEntry {
  timestamp: string;
  sessionId: string;
  sequence: number;
  tool: string;
  action:
    | 'execute'
    | 'deny'
    | 'error'
    | 'security_block'
    | 'policy_block'
    | 'capability_block'
    | 'constitutional_block'
    // Streaming-exec actions (dashboard terminal). exec_start is the
    // allow evidence written after the gate chain passes; _prepareToolCall
    // does not audit allows, so without this the streaming path would
    // leave no positive trail. exec_complete records exitCode + 512-byte
    // tails. exec_error records tool-level refusals (sandbox_required,
    // spawn_error, etc.).
    | 'exec_start'
    | 'exec_complete'
    | 'exec_error'
    // Model router actions (PR 5 of personal-agent-infrastructure.md).
    // `switch` records a successful per-turn model swap (same provider).
    // `fallback` records that the router wanted to switch but couldn't —
    // typically because the desired tier model lives on a different
    // provider family, which PR 5 does not yet support.
    | 'switch'
    | 'fallback'
    // Budget actions (PR 6 of personal-agent-infrastructure.md).
    // `budget_block` records that an additional model call was refused
    // because the session has already reached the effective cap.
    // `budget_warning` records crossing a configured threshold (default
    // 50/75/95% of cap). Each threshold fires at most once per session.
    | 'budget_block'
    | 'budget_warning'
    // PR 11 — capability allowlist + router receipts.
    // `capability_allow` records the session-start opt-in via
    // `--allow-capability`. Always emitted when the allowlist is
    // non-empty so a forensic reader can answer "did this session
    // run with bypassable labels?" from the chain alone.
    // `no_op` is a router-only audit: emitted once per turn when the
    // router ran but the chosen tier already routes to the current
    // model, so no swap happened. Closes the silence gap that made
    // pre-PR-11 sessions look as if the router never fired.
    | 'capability_allow'
    | 'no_op'
    // PR 27 — CodingAgentProvider boundary.
    // `task_start` records spec submission to a coding-agent provider.
    // `task_event` records a discrete event from the provider's stream
    // (status, log, file_change, command, etc.). `task_approval_request`
    // records a permission prompt the provider raised mid-run.
    // `task_complete` records terminal status (succeeded | failed). The
    // CLI / dashboard will read these rows to render the Tasks tab and
    // to chain back to the connector audit rows for issue→PR workflows.
    | 'task_start'
    | 'task_event'
    | 'task_approval_request'
    | 'task_complete'
    | 'task_cancelled'
    // RFC 005 — event-driven listener.
    // `webhook_received` records every signed inbound HTTP event before any
    // handler runs. `webhook_rejected` records HMAC / replay / oversize
    // failures so forgery attempts are forensically visible.
    // `webhook_dispatched` records the resulting action invocation,
    // referencing the receive entry's hash for chain-of-custody.
    | 'webhook_received'
    | 'webhook_rejected'
    | 'webhook_dispatched';
  args: Record<string, unknown>;
  result?: string;
  reason?: string;
  prevHash: string;
  hash: string;
}

/** Result of verifying an audit chain */
export interface VerifyResult {
  valid: boolean;
  entriesChecked: number;
  firstInvalidAt?: number;
  reason?: string;
  /**
   * True when the session consists entirely of pre-hash-chain entries
   * (no `hash`, `prevHash`, or `sequence` fields). These predate the
   * v1.7.0 hash-chain feature and cannot be cryptographically verified.
   * Callers should typically skip these with a warning rather than
   * treating them as tampering.
   */
  legacy?: boolean;
}

const MAX_LOG_SIZE = 10 * 1024 * 1024; // 10MB before rotation
const MAX_ARG_LENGTH = 500;
const GENESIS_HASH = 'genesis';

export class AuditLogger {
  private logDir: string;
  private sessionId: string;
  private sequence: number = 0;
  private prevHash: string = GENESIS_HASH;

  constructor(logDir?: string) {
    this.logDir = logDir || codebotPath('audit');
    this.sessionId = `${Date.now()}-${Math.random().toString(36).substring(2, 8)}`;
    try {
      fs.mkdirSync(this.logDir, { recursive: true });
    } catch (err) {
      warnNonFatal('audit.init', err);
    }
  }

  getSessionId(): string {
    return this.sessionId;
  }

  /** Append a hash-chained audit entry to the log file */
  log(entry: Omit<AuditEntry, 'timestamp' | 'sessionId' | 'sequence' | 'prevHash' | 'hash'>): void {
    try {
      this.sequence++;

      // Build entry without hash first (hash is computed over the other fields)
      const partial = {
        timestamp: new Date().toISOString(),
        sessionId: this.sessionId,
        sequence: this.sequence,
        tool: entry.tool,
        action: entry.action,
        args: this.sanitizeArgs(entry.args),
        result: entry.result,
        reason: entry.reason,
        prevHash: this.prevHash,
      };

      // Compute hash: SHA-256 of (prevHash + JSON of partial entry)
      const hashInput = this.prevHash + JSON.stringify(partial);
      const hash = crypto.createHash('sha256').update(hashInput).digest('hex');

      const fullEntry: AuditEntry = { ...partial, hash };
      this.prevHash = hash;

      const logFile = this.getLogFilePath();
      const line = encryptLine(JSON.stringify(fullEntry)) + '\n';

      this.rotateIfNeeded(logFile);
      fs.appendFileSync(logFile, line, 'utf-8');
    } catch {
      // Audit failures must NEVER crash the agent
    }
  }

  /** Read log entries, optionally filtered */
  query(filter?: { tool?: string; action?: string; since?: string; sessionId?: string }): AuditEntry[] {
    const entries: AuditEntry[] = [];
    try {
      const files = fs.readdirSync(this.logDir)
        .filter(f => f.startsWith('audit-') && f.endsWith('.jsonl'))
        .sort();

      for (const file of files) {
        const content = fs.readFileSync(path.join(this.logDir, file), 'utf-8');
        for (const rawLine of content.split('\n')) {
          if (!rawLine.trim()) continue;
          try {
            const entry = JSON.parse(decryptLine(rawLine)) as AuditEntry;
            if (filter?.tool && entry.tool !== filter.tool) continue;
            if (filter?.action && entry.action !== filter.action) continue;
            if (filter?.since && entry.timestamp < filter.since) continue;
            if (filter?.sessionId && entry.sessionId !== filter.sessionId) continue;
            entries.push(entry);
          } catch { /* skip malformed */ }
        }
      }
    } catch {
      // Can't read logs
    }
    return entries;
  }

  /**
   * Verify the hash chain integrity of audit entries.
   * Walks through entries for a given session and checks each hash.
   */
  static verify(entries: AuditEntry[]): VerifyResult {
    if (entries.length === 0) {
      return { valid: true, entriesChecked: 0 };
    }

    // Detect pre-hash-chain (legacy) entries. These were written before
    // v1.7.0 added hash/prevHash/sequence and cannot be cryptographically
    // verified. Reading entry.hash.substring(...) on these would crash —
    // surface them as a structured result instead.
    const isLegacy = (e: AuditEntry): boolean =>
      typeof e.hash !== 'string' || typeof e.prevHash !== 'string' || typeof e.sequence !== 'number';

    const legacyCount = entries.filter(isLegacy).length;
    if (legacyCount === entries.length) {
      const sid = entries[0]?.sessionId ?? 'unknown';
      return {
        valid: false,
        entriesChecked: 0,
        legacy: true,
        reason: `legacy unhashed entries (${legacyCount}) for sessionId=${sid} — predate v1.7.0 hash chain`,
      };
    }
    if (legacyCount > 0) {
      // Mixed: some entries hashed, some not. Treat as chain corruption.
      const firstLegacy = entries.find(isLegacy)!;
      return {
        valid: false,
        entriesChecked: legacyCount,
        firstInvalidAt: typeof firstLegacy.sequence === 'number' ? firstLegacy.sequence : undefined,
        reason: `mixed chain: ${legacyCount}/${entries.length} entries lack hash fields for sessionId=${firstLegacy.sessionId ?? 'unknown'} — possible corruption`,
      };
    }

    // Sort by sequence
    const sorted = [...entries].sort((a, b) => a.sequence - b.sequence);

    for (let i = 0; i < sorted.length; i++) {
      const entry = sorted[i];

      // Check sequence continuity
      if (i === 0 && entry.prevHash !== GENESIS_HASH) {
        // First entry should reference genesis (unless it's a continuation)
        // Allow non-genesis for continuation of previous sessions
      }

      // Recompute hash
      const partial = {
        timestamp: entry.timestamp,
        sessionId: entry.sessionId,
        sequence: entry.sequence,
        tool: entry.tool,
        action: entry.action,
        args: entry.args,
        result: entry.result,
        reason: entry.reason,
        prevHash: entry.prevHash,
      };

      const hashInput = entry.prevHash + JSON.stringify(partial);
      const expectedHash = crypto.createHash('sha256').update(hashInput).digest('hex');

      if (entry.hash !== expectedHash) {
        return {
          valid: false,
          entriesChecked: i + 1,
          firstInvalidAt: entry.sequence,
          reason: `Hash mismatch at sequence ${entry.sequence}: expected ${expectedHash.substring(0, 16)}..., got ${entry.hash.substring(0, 16)}...`,
        };
      }

      // Check chain continuity (sequence i+1 should reference sequence i's hash)
      if (i < sorted.length - 1) {
        const next = sorted[i + 1];
        if (next.prevHash !== entry.hash) {
          return {
            valid: false,
            entriesChecked: i + 2,
            firstInvalidAt: next.sequence,
            reason: `Chain break at sequence ${next.sequence}: prevHash doesn't match previous entry's hash`,
          };
        }
      }
    }

    return { valid: true, entriesChecked: sorted.length };
  }

  /**
   * Verify all entries for a given session.
   */
  verifySession(sessionId?: string): VerifyResult {
    const sid = sessionId || this.sessionId;
    const entries = this.query({ sessionId: sid });
    return AuditLogger.verify(entries);
  }

  private getLogFilePath(): string {
    const date = new Date().toISOString().split('T')[0];
    return path.join(this.logDir, `audit-${date}.jsonl`);
  }

  private rotateIfNeeded(logFile: string): void {
    try {
      if (!fs.existsSync(logFile)) return;
      const stat = fs.statSync(logFile);
      if (stat.size >= MAX_LOG_SIZE) {
        const rotated = logFile.replace('.jsonl', `-${Date.now()}.jsonl`);
        fs.renameSync(logFile, rotated);
      }
    } catch {
      // Rotation failure is non-fatal
    }
  }

  private sanitizeArgs(args: Record<string, unknown>): Record<string, unknown> {
    const sanitized: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(args)) {
      if (typeof value === 'string') {
        let masked = maskSecretsInString(value);
        if (masked.length > MAX_ARG_LENGTH) {
          masked = masked.substring(0, MAX_ARG_LENGTH) + `... (${value.length} chars)`;
        }
        sanitized[key] = masked;
      } else if (typeof value === 'object' && value !== null) {
        const str = JSON.stringify(value);
        const masked = maskSecretsInString(str);
        sanitized[key] = masked.length > MAX_ARG_LENGTH
          ? masked.substring(0, MAX_ARG_LENGTH) + '...'
          : masked;
      } else {
        sanitized[key] = value;
      }
    }
    return sanitized;
  }
}
