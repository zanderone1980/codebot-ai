/**
 * SQLite tool — query / list tables / show schema / db info.
 *
 * Row 8 fix (2026-04-24):
 * Pre-fix every action used `execSync` with a hand-built shell line:
 *
 *   execSync(`sqlite3 "${dbPath}" "${command.replace(/"/g, '\\"')}"`)
 *
 * Both `dbPath` and `command` (which carries agent-supplied SQL or
 * dot-meta commands) were placed inside double quotes. Bash expands
 * `$(...)`, backticks, and `${...}` INSIDE double quotes — and the
 * `replace(/"/g, '\\"')` only escapes double quotes, not the
 * substitution metacharacters. So:
 *
 *   sql = 'SELECT 1; `touch /tmp/pwned`'
 *   →  sqlite3 "real.db" "SELECT 1; `touch /tmp/pwned`"
 *   →  bash expands the backtick LOCALLY before sqlite3 ever sees it.
 *
 * `BLOCKED_SQL` was a regex against DROP/DELETE/TRUNCATE — it did not
 * even attempt to catch shell metacharacters.
 *
 * What this file now does:
 *   - `execFileSync('sqlite3', argv)`. No local shell.
 *   - `db` path contained under the agent's `projectRoot` (Issue #17
 *     pattern). Pre-fix the agent could pass `db: '/etc/foo.db'`.
 *   - `BLOCKED_SQL` kept as defense-in-depth on SQL semantics. With
 *     argv it doesn't carry security weight against shell injection
 *     anymore (the shell is gone), but the destructive-statement
 *     intent is still useful.
 *   - `buildSqlitePlan()` is a pure seam returning `{command, argv} |
 *     {error}` so tests pin the argv contract.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Tool } from '../types';

const BLOCKED_SQL = [
  /\bDROP\s+(TABLE|DATABASE|INDEX|VIEW)\b/i,
  /\bDELETE\s+FROM\b/i,
  /\bTRUNCATE\b/i,
  /\bALTER\s+TABLE\s+.*\bDROP\b/i,
];

/**
 * Decide whether `target` is contained within `root`.
 * Sibling-prefix safe via path.relative.
 */
function isContained(root: string, target: string): boolean {
  const absRoot = path.resolve(root);
  const absTarget = path.resolve(target);
  if (absRoot === absTarget) return true;
  const rel = path.relative(absRoot, absTarget);
  if (!rel) return true;
  if (rel.startsWith('..')) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

export type SqlitePlan =
  | { command: 'sqlite3'; argv: string[] }
  | { error: string };

export class DatabaseTool implements Tool {
  name = 'database';
  description = 'Query SQLite databases. Actions: query, tables, schema, info. Blocks DROP/DELETE/TRUNCATE for safety.';
  permission: Tool['permission'] = 'prompt';
  /**
   * Containment root. Issue #17 pattern: plumbed from `Agent.projectRoot`
   * via `ToolRegistry`, falls back to `process.cwd()` for back-compat.
   */
  private readonly projectRoot: string;
  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot || process.cwd();
  }
  parameters = {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Action: query, tables, schema, info' },
      db: { type: 'string', description: 'Path to SQLite database file (must be inside projectRoot)' },
      sql: { type: 'string', description: 'SQL query to execute (for "query" action)' },
      table: { type: 'string', description: 'Table name (for "schema" action)' },
    },
    required: ['action', 'db'],
  };

  /**
   * Pure seam: build the (command, argv) pair without executing.
   */
  public buildSqlitePlan(args: Record<string, unknown>): SqlitePlan {
    const action = args.action;
    const dbArg = args.db;
    if (typeof action !== 'string' || action.length === 0) return { error: 'Error: action is required' };
    if (typeof dbArg !== 'string' || dbArg.length === 0) return { error: 'Error: db path is required' };

    const dbResolved = path.resolve(this.projectRoot, dbArg);
    if (!isContained(this.projectRoot, dbResolved)) {
      return { error: `Error: db path escapes project root (${dbResolved} not under ${this.projectRoot})` };
    }

    switch (action) {
      case 'query': {
        const sql = args.sql;
        if (typeof sql !== 'string' || sql.length === 0) return { error: 'Error: sql is required for query' };
        for (const pattern of BLOCKED_SQL) {
          if (pattern.test(sql)) {
            return { error: `Error: destructive SQL blocked for safety. Pattern matched: ${pattern.source}` };
          }
        }
        // sqlite3 <db> <statement> — both as their own argv elements.
        // Metacharacters inside `sql` stay literal: they reach sqlite3's
        // SQL parser, not bash.
        return { command: 'sqlite3', argv: [dbResolved, sql] };
      }
      case 'tables':
        return { command: 'sqlite3', argv: [dbResolved, '.tables'] };
      case 'schema': {
        const table = args.table;
        if (typeof table === 'string' && table.length > 0) {
          // Identifier validation kept as defense-in-depth — sqlite3's
          // .schema parser will reject odd input anyway, but a strict
          // SQL identifier is a clean policy-level rule.
          if (!/^[a-zA-Z_]\w*$/.test(table)) {
            return { error: 'Error: invalid table name' };
          }
          return { command: 'sqlite3', argv: [dbResolved, `.schema ${table}`] };
        }
        return { command: 'sqlite3', argv: [dbResolved, '.schema'] };
      }
      case 'info':
        return { command: 'sqlite3', argv: [dbResolved, "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name;"] };
      default:
        return { error: `Error: unknown action "${action}". Use: query, tables, schema, info` };
    }
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const plan = this.buildSqlitePlan(args);
    if ('error' in plan) return plan.error;

    // Existence check on the resolved db path. sqlite3 will create a file
    // if it doesn't exist, which we don't want for read-style actions.
    // The `info` action also wants stat() data, so we resolve once here.
    const dbResolved = plan.argv[0];
    if (!fs.existsSync(dbResolved)) {
      return `Error: database not found: ${dbResolved}`;
    }

    if ((args.action as string) === 'info') {
      const stat = fs.statSync(dbResolved);
      const sizeMB = (stat.size / (1024 * 1024)).toFixed(2);
      const tables = this.runPlan(plan);
      return `Database: ${dbResolved}\nSize: ${sizeMB} MB\nModified: ${stat.mtime.toISOString()}\n\nTables:\n${tables}`;
    }

    return this.runPlan(plan);
  }

  private runPlan(plan: { command: 'sqlite3'; argv: string[] }): string {
    try {
      const output = execFileSync(plan.command, plan.argv, {
        timeout: 15_000,
        maxBuffer: 1024 * 1024,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return output.trim() || '(no results)';
    } catch (err: unknown) {
      const e = err as { code?: string; stderr?: string };
      if (e.code === 'ENOENT') {
        return 'Error: sqlite3 is not installed. Install it with: brew install sqlite (macOS) or apt install sqlite3 (Linux)';
      }
      const msg = (e.stderr || '').trim();
      return `Error: ${msg || 'query failed'}`;
    }
  }
}
