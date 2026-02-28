import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { Message } from './types';

const SESSIONS_DIR = path.join(os.homedir(), '.codebot', 'sessions');

export interface SessionMeta {
  id: string;
  model: string;
  created: string;
  updated: string;
  messageCount: number;
  preview: string;
}

export class SessionManager {
  private sessionId: string;
  private filePath: string;
  private model: string;

  constructor(model: string, sessionId?: string) {
    this.model = model;
    this.sessionId = sessionId || crypto.randomUUID();
    fs.mkdirSync(SESSIONS_DIR, { recursive: true });
    this.filePath = path.join(SESSIONS_DIR, `${this.sessionId}.jsonl`);
  }

  getId(): string {
    return this.sessionId;
  }

  /** Append a message to the session file */
  save(message: Message): void {
    try {
      const line = JSON.stringify({
        ...message,
        _ts: new Date().toISOString(),
        _model: this.model,
      });
      fs.appendFileSync(this.filePath, line + '\n');
    } catch {
      // Don't crash on write failure — session persistence is best-effort
    }
  }

  /** Save all messages (atomic overwrite via temp file + rename) */
  saveAll(messages: Message[]): void {
    try {
      const lines = messages.map(m =>
        JSON.stringify({ ...m, _ts: new Date().toISOString(), _model: this.model })
      );
      const tmpPath = this.filePath + '.tmp';
      fs.writeFileSync(tmpPath, lines.join('\n') + '\n');
      fs.renameSync(tmpPath, this.filePath);
    } catch {
      // Don't crash — session persistence is best-effort
    }
  }

  /** Load messages from a session file (skips malformed lines) */
  load(): Message[] {
    if (!fs.existsSync(this.filePath)) return [];
    let content: string;
    try {
      content = fs.readFileSync(this.filePath, 'utf-8').trim();
    } catch {
      return [];
    }
    if (!content) return [];
    const messages: Message[] = [];
    for (const line of content.split('\n')) {
      try {
        const obj = JSON.parse(line);
        delete obj._ts;
        delete obj._model;
        messages.push(obj as Message);
      } catch {
        // Skip malformed line — don't crash the whole load
        continue;
      }
    }
    return messages;
  }

  /** List recent sessions */
  static list(limit = 10): SessionMeta[] {
    if (!fs.existsSync(SESSIONS_DIR)) return [];

    const files = fs.readdirSync(SESSIONS_DIR)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => {
        const fullPath = path.join(SESSIONS_DIR, f);
        const stat = fs.statSync(fullPath);
        return { name: f, mtime: stat.mtime };
      })
      .sort((a, b) => b.mtime.getTime() - a.mtime.getTime())
      .slice(0, limit);

    return files.map(f => {
      const id = f.name.replace('.jsonl', '');
      const fullPath = path.join(SESSIONS_DIR, f.name);
      const content = fs.readFileSync(fullPath, 'utf-8').trim();
      const lines = content ? content.split('\n') : [];
      let model = '';
      let created = '';
      let updated = '';
      let preview = '';

      if (lines.length > 0) {
        try {
          const first = JSON.parse(lines[0]);
          created = first._ts || '';
          model = first._model || '';
        } catch { /* skip */ }
        try {
          const last = JSON.parse(lines[lines.length - 1]);
          updated = last._ts || '';
        } catch { /* skip */ }
        // Find first user message for preview
        for (const line of lines) {
          try {
            const msg = JSON.parse(line);
            if (msg.role === 'user') {
              preview = msg.content.substring(0, 80);
              break;
            }
          } catch { /* skip */ }
        }
      }

      return {
        id,
        model,
        created,
        updated,
        messageCount: lines.length,
        preview,
      };
    });
  }

  /** Get the most recent session ID */
  static latest(): string | undefined {
    const sessions = SessionManager.list(1);
    return sessions[0]?.id;
  }
}
