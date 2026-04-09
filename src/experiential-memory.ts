/**
 * Experiential Memory — Persistent lesson store for CodeBot.
 *
 * Records what CodeBot tried, whether it worked, and what to do differently.
 * Injects relevant lessons into the LLM prompt before every task.
 * Storage: SQLite at ~/.codebot/lessons.db.
 *
 * Core principle: "Don't make the same mistake twice."
 */

import * as fs from 'fs';
import * as crypto from 'crypto';
import { codebotPath } from './paths';

// Import better-sqlite3 — available via @ai-operations/ops-storage dependency
let Database: any;
try {
  Database = require('better-sqlite3');
} catch {
  // SQLite not available — experiential memory will be disabled
  Database = null;
}

export interface Lesson {
  id: string;
  timestamp: string;
  project: string;
  scope: 'global' | 'project';
  toolName: string;
  taskDescription: string;
  approach: string;
  errorMessage: string;
  outcome: 'success' | 'failure';
  lesson: string;
  avoidance: string;
  tags: string;
  confidence: number;
  accessCount: number;
  lastAccessed: string;
  decayScore: number;
  challenged: boolean;
  supersededBy: string | null;
}

export interface LessonQuery {
  toolName?: string;
  errorPattern?: string;
  taskContext?: string;
  limit?: number;
  outcomeFilter?: 'success' | 'failure';
  project?: string;
}

export interface LessonStats {
  totalLessons: number;
  failureLessons: number;
  successLessons: number;
  challengedLessons: number;
  averageConfidence: number;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS lessons (
  id TEXT PRIMARY KEY,
  timestamp TEXT NOT NULL,
  project TEXT NOT NULL DEFAULT '',
  scope TEXT NOT NULL DEFAULT 'global',
  toolName TEXT NOT NULL,
  taskDescription TEXT NOT NULL DEFAULT '',
  approach TEXT NOT NULL DEFAULT '',
  errorMessage TEXT NOT NULL DEFAULT '',
  outcome TEXT NOT NULL,
  lesson TEXT NOT NULL,
  avoidance TEXT NOT NULL DEFAULT '',
  tags TEXT NOT NULL DEFAULT '',
  confidence REAL NOT NULL DEFAULT 0.6,
  accessCount INTEGER NOT NULL DEFAULT 0,
  lastAccessed TEXT NOT NULL DEFAULT '',
  decayScore REAL NOT NULL DEFAULT 1.0,
  challenged INTEGER NOT NULL DEFAULT 0,
  supersededBy TEXT DEFAULT NULL
);

CREATE INDEX IF NOT EXISTS idx_lessons_tool ON lessons(toolName);
CREATE INDEX IF NOT EXISTS idx_lessons_outcome ON lessons(outcome);
CREATE INDEX IF NOT EXISTS idx_lessons_confidence ON lessons(confidence);
CREATE INDEX IF NOT EXISTS idx_lessons_project ON lessons(project);
`;

const FTS_SCHEMA = `
CREATE VIRTUAL TABLE IF NOT EXISTS lessons_fts USING fts5(
  id UNINDEXED,
  lesson,
  errorMessage,
  taskDescription,
  tags,
  content=lessons,
  content_rowid=rowid
);
`;

const FTS_TRIGGERS = `
CREATE TRIGGER IF NOT EXISTS lessons_ai AFTER INSERT ON lessons BEGIN
  INSERT INTO lessons_fts(rowid, id, lesson, errorMessage, taskDescription, tags)
  VALUES (new.rowid, new.id, new.lesson, new.errorMessage, new.taskDescription, new.tags);
END;

CREATE TRIGGER IF NOT EXISTS lessons_ad AFTER DELETE ON lessons BEGIN
  INSERT INTO lessons_fts(lessons_fts, rowid, id, lesson, errorMessage, taskDescription, tags)
  VALUES ('delete', old.rowid, old.id, old.lesson, old.errorMessage, old.taskDescription, old.tags);
END;

CREATE TRIGGER IF NOT EXISTS lessons_au AFTER UPDATE ON lessons BEGIN
  INSERT INTO lessons_fts(lessons_fts, rowid, id, lesson, errorMessage, taskDescription, tags)
  VALUES ('delete', old.rowid, old.id, old.lesson, old.errorMessage, old.taskDescription, old.tags);
  INSERT INTO lessons_fts(rowid, id, lesson, errorMessage, taskDescription, tags)
  VALUES (new.rowid, new.id, new.lesson, new.errorMessage, new.taskDescription, new.tags);
END;
`;

const MAX_LESSONS = 10_000;
const MAX_PROMPT_LESSONS = 5;
const MAX_PROMPT_BYTES = 2048;
const DECAY_LAMBDA = 0.05; // half-life ~14 days
const MIN_CONFIDENCE_FOR_PROMPT = 0.2;
const PRUNE_DECAY_THRESHOLD = 0.1;
const PRUNE_ACCESS_THRESHOLD = 2;
const PRUNE_AGE_DAYS = 30;

export class ExperientialMemory {
  private db: any;
  private _active = false;

  get isActive(): boolean { return this._active; }

  constructor(dbPath?: string) {
    if (!Database) return;

    try {
      const dir = codebotPath('');
      fs.mkdirSync(dir, { recursive: true });
      const path = dbPath || codebotPath('lessons.db');
      this.db = new Database(path);
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.db.exec(SCHEMA);
      // FTS5 may not be available in all SQLite builds
      try {
        this.db.exec(FTS_SCHEMA);
        this.db.exec(FTS_TRIGGERS);
      } catch {
        // FTS5 not available — full-text search disabled, exact match still works
      }
      this._active = true;
    } catch {
      this._active = false;
    }
  }

  /** Store a new lesson */
  recordLesson(lesson: Partial<Lesson> & Pick<Lesson, 'toolName' | 'outcome' | 'lesson'>): string | null {
    if (!this._active) return null;

    const id = lesson.id || crypto.randomUUID();
    const now = new Date().toISOString();

    try {
      // Check for supersession: same tool + same error pattern → supersede old lesson
      if (lesson.outcome === 'failure' && lesson.errorMessage) {
        const existing = this.db.prepare(
          `SELECT id FROM lessons WHERE toolName = ? AND errorMessage = ? AND outcome = 'failure' AND supersededBy IS NULL AND challenged = 0 ORDER BY timestamp DESC LIMIT 1`
        ).get(lesson.toolName, lesson.errorMessage);

        if (existing) {
          this.db.prepare('UPDATE lessons SET supersededBy = ? WHERE id = ?').run(id, existing.id);
        }
      }

      this.db.prepare(`
        INSERT INTO lessons (id, timestamp, project, scope, toolName, taskDescription, approach, errorMessage, outcome, lesson, avoidance, tags, confidence, accessCount, lastAccessed, decayScore, challenged, supersededBy)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).run(
        id,
        lesson.timestamp || now,
        lesson.project || '',
        lesson.scope || 'global',
        lesson.toolName,
        lesson.taskDescription || '',
        lesson.approach || '',
        lesson.errorMessage || '',
        lesson.outcome,
        lesson.lesson,
        lesson.avoidance || '',
        lesson.tags || '',
        lesson.confidence ?? 0.6,
        0,
        now,
        1.0,
        0,
        null,
      );

      // Enforce max lessons cap
      const count = this.db.prepare('SELECT COUNT(*) as cnt FROM lessons').get().cnt;
      if (count > MAX_LESSONS) {
        this.db.prepare(`
          DELETE FROM lessons WHERE id IN (
            SELECT id FROM lessons ORDER BY decayScore ASC, accessCount ASC LIMIT ?
          )
        `).run(count - MAX_LESSONS);
      }

      return id;
    } catch {
      return null;
    }
  }

  /** Find relevant lessons */
  queryLessons(query: LessonQuery): Lesson[] {
    if (!this._active) return [];

    try {
      const limit = query.limit || MAX_PROMPT_LESSONS;
      const conditions: string[] = ['supersededBy IS NULL', `confidence >= ${MIN_CONFIDENCE_FOR_PROMPT}`];
      const params: any[] = [];

      if (query.outcomeFilter) {
        conditions.push('outcome = ?');
        params.push(query.outcomeFilter);
      }

      if (query.toolName) {
        conditions.push('toolName = ?');
        params.push(query.toolName);
      }

      if (query.project) {
        conditions.push("(project = ? OR scope = 'global')");
        params.push(query.project);
      }

      // Try FTS5 search first if taskContext provided
      if (query.taskContext) {
        try {
          const ftsQuery = query.taskContext
            .replace(/[^\w\s]/g, ' ')
            .split(/\s+/)
            .filter(w => w.length > 2)
            .slice(0, 5)
            .join(' OR ');

          if (ftsQuery) {
            const ftsResults = this.db.prepare(`
              SELECT l.* FROM lessons l
              JOIN lessons_fts f ON l.id = f.id
              WHERE lessons_fts MATCH ? AND ${conditions.join(' AND ')}
              ORDER BY l.confidence DESC, l.accessCount DESC
              LIMIT ?
            `).all(ftsQuery, ...params, limit);

            if (ftsResults.length > 0) {
              this.markAccessed(ftsResults.map((r: any) => r.id));
              return ftsResults.map(this.rowToLesson);
            }
          }
        } catch {
          // FTS5 not available or query failed — fall through to exact match
        }
      }

      // Fallback: exact match on tool name + error pattern
      if (query.errorPattern) {
        conditions.push('errorMessage LIKE ?');
        params.push(`%${query.errorPattern}%`);
      }

      params.push(limit);
      const results = this.db.prepare(`
        SELECT * FROM lessons WHERE ${conditions.join(' AND ')}
        ORDER BY confidence DESC, accessCount DESC
        LIMIT ?
      `).all(...params);

      if (results.length > 0) {
        this.markAccessed(results.map((r: any) => r.id));
      }
      return results.map(this.rowToLesson);
    } catch {
      return [];
    }
  }

  /** Format top lessons for system prompt injection */
  buildPromptBlock(context: { currentTask?: string; recentTools?: string[] }): string {
    if (!this._active) return '';

    try {
      // Get failure lessons
      const failures = this.queryLessons({
        taskContext: context.currentTask,
        outcomeFilter: 'failure',
        limit: 3,
      });

      // Get success lessons
      const successes = this.queryLessons({
        taskContext: context.currentTask,
        outcomeFilter: 'success',
        limit: 2,
      });

      if (failures.length === 0 && successes.length === 0) return '';

      const parts: string[] = ['--- Lessons from Experience ---'];

      if (failures.length > 0) {
        parts.push('## Past Failures to Avoid');
        for (const f of failures) {
          const conf = Math.round(f.confidence * 100);
          const line = `- [${f.toolName}] ${f.lesson}${f.avoidance ? ' Avoid: ' + f.avoidance : ''} (confidence: ${conf}%, seen ${f.accessCount + 1}x)`;
          parts.push(line);
        }
      }

      if (successes.length > 0) {
        parts.push('## Approaches That Worked');
        for (const s of successes) {
          const conf = Math.round(s.confidence * 100);
          const line = `- [${s.toolName}] ${s.lesson} (confidence: ${conf}%, seen ${s.accessCount + 1}x)`;
          parts.push(line);
        }
      }

      const block = parts.join('\n');
      // Enforce size budget
      if (Buffer.byteLength(block, 'utf-8') > MAX_PROMPT_BYTES) {
        return block.substring(0, MAX_PROMPT_BYTES - 50) + '\n[truncated]';
      }
      return block;
    } catch {
      return '';
    }
  }

  /** Flag a lesson as potentially wrong */
  challengeLesson(id: string, reason: string): boolean {
    if (!this._active) return false;
    try {
      this.db.prepare(`
        UPDATE lessons SET challenged = 1, confidence = confidence * 0.5 WHERE id = ?
      `).run(id);
      return true;
    } catch {
      return false;
    }
  }

  /** Increase confidence when a lesson was retrieved and the outcome was good */
  reinforceLesson(id: string): void {
    if (!this._active) return;
    try {
      this.db.prepare(`
        UPDATE lessons SET confidence = MIN(1.0, confidence + 0.05) WHERE id = ?
      `).run(id);
    } catch {}
  }

  /** Decrease confidence when a lesson was retrieved but didn't help */
  weakenLesson(id: string): void {
    if (!this._active) return;
    try {
      this.db.prepare(`
        UPDATE lessons SET confidence = MAX(0.0, confidence - 0.1) WHERE id = ?
      `).run(id);
    } catch {}
  }

  /** Decay scores, merge similar lessons, prune old ones */
  decayAndConsolidate(): void {
    if (!this._active) return;

    try {
      const now = Date.now();

      // Decay all lessons based on time since last access
      const lessons = this.db.prepare('SELECT id, lastAccessed, decayScore FROM lessons').all();
      const updateDecay = this.db.prepare('UPDATE lessons SET decayScore = ? WHERE id = ?');

      const decayBatch = this.db.transaction(() => {
        for (const l of lessons) {
          const lastAccess = new Date(l.lastAccessed).getTime();
          const daysSince = (now - lastAccess) / (1000 * 60 * 60 * 24);
          const newDecay = Math.exp(-DECAY_LAMBDA * daysSince);
          updateDecay.run(newDecay, l.id);
        }
      });
      decayBatch();

      // Prune: low decay + low access + old
      const cutoffDate = new Date(now - PRUNE_AGE_DAYS * 24 * 60 * 60 * 1000).toISOString();
      this.db.prepare(`
        DELETE FROM lessons
        WHERE decayScore < ? AND accessCount < ? AND timestamp < ?
      `).run(PRUNE_DECAY_THRESHOLD, PRUNE_ACCESS_THRESHOLD, cutoffDate);
    } catch {}
  }

  /** Summary stats for debugging */
  getLessonStats(): LessonStats {
    if (!this._active) {
      return { totalLessons: 0, failureLessons: 0, successLessons: 0, challengedLessons: 0, averageConfidence: 0 };
    }

    try {
      const total = this.db.prepare('SELECT COUNT(*) as cnt FROM lessons').get().cnt;
      const failures = this.db.prepare("SELECT COUNT(*) as cnt FROM lessons WHERE outcome = 'failure'").get().cnt;
      const successes = this.db.prepare("SELECT COUNT(*) as cnt FROM lessons WHERE outcome = 'success'").get().cnt;
      const challenged = this.db.prepare('SELECT COUNT(*) as cnt FROM lessons WHERE challenged = 1').get().cnt;
      const avgConf = this.db.prepare('SELECT AVG(confidence) as avg FROM lessons').get().avg || 0;

      return {
        totalLessons: total,
        failureLessons: failures,
        successLessons: successes,
        challengedLessons: challenged,
        averageConfidence: Math.round(avgConf * 100) / 100,
      };
    } catch {
      return { totalLessons: 0, failureLessons: 0, successLessons: 0, challengedLessons: 0, averageConfidence: 0 };
    }
  }

  /** Close the database connection */
  close(): void {
    if (this.db) {
      try { this.db.close(); } catch {}
    }
  }

  private markAccessed(ids: string[]): void {
    const now = new Date().toISOString();
    const stmt = this.db.prepare('UPDATE lessons SET accessCount = accessCount + 1, lastAccessed = ? WHERE id = ?');
    const batch = this.db.transaction(() => {
      for (const id of ids) stmt.run(now, id);
    });
    batch();
  }

  private rowToLesson(row: any): Lesson {
    return {
      ...row,
      challenged: !!row.challenged,
      supersededBy: row.supersededBy || null,
    };
  }
}
