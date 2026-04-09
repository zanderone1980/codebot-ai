/**
 * Structured logging for Daemon Mode.
 *
 * Writes JSON-formatted log entries to ~/.codebot/daemon/daemon.log
 * with rotation (max 1000 entries). Provides in-memory tail for
 * dashboard access.
 */

import * as fs from 'fs';
import { codebotPath } from './paths';

export type LogLevel = 'info' | 'warn' | 'error' | 'debug';

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  message: string;
  context?: Record<string, unknown>;
}

export class DaemonLog {
  private entries: LogEntry[] = [];
  private maxMemoryEntries = 200;
  private maxFileEntries = 1000;

  info(message: string, context?: Record<string, unknown>): void {
    this.write('info', message, context);
  }

  warn(message: string, context?: Record<string, unknown>): void {
    this.write('warn', message, context);
  }

  error(message: string, context?: Record<string, unknown>): void {
    this.write('error', message, context);
  }

  debug(message: string, context?: Record<string, unknown>): void {
    this.write('debug', message, context);
  }

  /** Get recent log entries from memory */
  tail(count = 20): LogEntry[] {
    return this.entries.slice(-count);
  }

  /** Get all in-memory entries */
  getEntries(): LogEntry[] {
    return [...this.entries];
  }

  /** Format entries for display */
  format(entries?: LogEntry[]): string {
    const list = entries || this.entries;
    return list.map(e => {
      const ts = e.timestamp.substring(11, 19); // HH:MM:SS
      const level = e.level.toUpperCase().padEnd(5);
      return `[${ts}] ${level} ${e.message}`;
    }).join('\n');
  }

  private write(level: LogLevel, message: string, context?: Record<string, unknown>): void {
    const entry: LogEntry = {
      timestamp: new Date().toISOString(),
      level,
      message,
      context,
    };

    // Memory buffer
    this.entries.push(entry);
    if (this.entries.length > this.maxMemoryEntries) {
      this.entries = this.entries.slice(-this.maxMemoryEntries);
    }

    // Persist to file
    this.appendToFile(entry);
  }

  private appendToFile(entry: LogEntry): void {
    try {
      const dir = codebotPath('daemon');
      fs.mkdirSync(dir, { recursive: true });
      const logFile = codebotPath('daemon/daemon.log');

      // Append-only NDJSON: one JSON object per line, no re-reading
      fs.appendFileSync(logFile, JSON.stringify(entry) + '\n');

      // Rotate periodically to cap file size
      if (Math.random() < 0.05) {
        try {
          const content = fs.readFileSync(logFile, 'utf-8');
          const lines = content.trim().split('\n');
          if (lines.length > this.maxFileEntries) {
            fs.writeFileSync(logFile, lines.slice(-this.maxFileEntries).join('\n') + '\n');
          }
        } catch { /* rotation failed */ }
      }
    } catch { /* best-effort logging */ }
  }
}
