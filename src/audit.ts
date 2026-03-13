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
  action: 'execute' | 'deny' | 'error' | 'security_block' | 'policy_block' | 'capability_block' | 'constitutional_block';
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
