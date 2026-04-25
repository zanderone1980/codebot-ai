import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DatabaseTool } from './database';

/**
 * DatabaseTool tests — validates SQL blocking patterns, input validation,
 * action routing, error messages, and (Row 8) argv-based exec + db-path
 * containment under projectRoot.
 *
 * Tests do NOT require sqlite3 or a real database; they test validation,
 * routing, argv shape, and containment.
 *
 * Row 8 fix (2026-04-24): pre-fix, every action used
 *   `execSync(\`sqlite3 "${dbPath}" "${command.replace(/"/g, '\\"')}"\`)`
 * Both `dbPath` and `sql` were placed inside double quotes — and bash
 * expands `$(...)`, backticks, and `${...}` INSIDE double quotes. The
 * `replace(/"/g, '\\"')` only escaped `"`, not the substitution
 * metacharacters. So `sql = 'SELECT 1; \`touch /tmp/pwned\`'` would
 * spawn `touch` LOCALLY before sqlite3 ever ran.
 */

describe('DatabaseTool — metadata', () => {
  const tool = new DatabaseTool();

  it('has correct tool name', () => {
    assert.strictEqual(tool.name, 'database');
  });

  it('has prompt permission level', () => {
    assert.strictEqual(tool.permission, 'prompt');
  });

  it('requires action and db parameters', () => {
    const required = tool.parameters.required as string[];
    assert.ok(required.includes('action'));
    assert.ok(required.includes('db'));
  });
});

describe('DatabaseTool — input validation', () => {
  let workDir: string;
  let tempDb: string;
  let tool: DatabaseTool;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row8-db-validation-'));
    tempDb = path.join(workDir, 'validation.db');
    fs.writeFileSync(tempDb, '', 'utf-8');
    tool = new DatabaseTool(workDir);
  });

  after(() => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns error when action is missing', async () => {
    const result = await tool.execute({ db: tempDb });
    assert.ok(result.includes('Error: action is required'));
  });

  it('returns error when db path is missing', async () => {
    const result = await tool.execute({ action: 'query' });
    assert.ok(result.includes('Error: db path is required'));
  });

  it('returns error for nonexistent database file (inside projectRoot)', async () => {
    const missing = path.join(workDir, 'nonexistent.db');
    const result = await tool.execute({ action: 'query', db: missing, sql: 'SELECT 1' });
    assert.ok(result.includes('Error: database not found'));
  });

  it('returns error for unknown action', async () => {
    const result = await tool.execute({ action: 'destroy', db: tempDb });
    assert.ok(result.includes('Error: unknown action'));
    assert.ok(result.includes('destroy'));
    assert.ok(result.includes('query, tables, schema, info'));
  });
});

describe('DatabaseTool — SQL blocking (destructive queries)', () => {
  let workDir: string;
  let tempDbPath: string;
  let tool: DatabaseTool;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row8-db-blocking-'));
    tempDbPath = path.join(workDir, 'blocking.db');
    fs.writeFileSync(tempDbPath, '', 'utf-8');
    tool = new DatabaseTool(workDir);
  });

  after(() => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('blocks DROP TABLE statements', async () => {
    const result = await tool.execute({
      action: 'query', db: tempDbPath, sql: 'DROP TABLE users;',
    });
    assert.ok(result.includes('Error: destructive SQL blocked'));
    assert.ok(result.includes('DROP'));
  });

  it('blocks DROP DATABASE statements', async () => {
    const result = await tool.execute({
      action: 'query', db: tempDbPath, sql: 'DROP DATABASE production;',
    });
    assert.ok(result.includes('Error: destructive SQL blocked'));
  });

  it('blocks DELETE FROM statements', async () => {
    const result = await tool.execute({
      action: 'query', db: tempDbPath, sql: 'DELETE FROM users WHERE id > 0;',
    });
    assert.ok(result.includes('Error: destructive SQL blocked'));
    assert.ok(result.includes('DELETE'));
  });

  it('blocks TRUNCATE statements', async () => {
    const result = await tool.execute({
      action: 'query', db: tempDbPath, sql: 'TRUNCATE TABLE sessions;',
    });
    assert.ok(result.includes('Error: destructive SQL blocked'));
    assert.ok(result.includes('TRUNCATE'));
  });

  it('blocks ALTER TABLE ... DROP statements', async () => {
    const result = await tool.execute({
      action: 'query', db: tempDbPath, sql: 'ALTER TABLE users DROP COLUMN email;',
    });
    assert.ok(result.includes('Error: destructive SQL blocked'));
  });

  it('blocks case-insensitive variations of destructive SQL', async () => {
    const result = await tool.execute({
      action: 'query', db: tempDbPath, sql: 'drop table users;',
    });
    assert.ok(result.includes('Error: destructive SQL blocked'));
  });

  it('blocks mixed case destructive SQL', async () => {
    const result = await tool.execute({
      action: 'query', db: tempDbPath, sql: 'Delete From users WHERE 1=1;',
    });
    assert.ok(result.includes('Error: destructive SQL blocked'));
  });

  it('does not block SELECT statements (safe query passes validation)', async () => {
    const result = await tool.execute({
      action: 'query', db: tempDbPath, sql: 'SELECT * FROM users;',
    });
    assert.ok(!result.includes('destructive SQL blocked'));
  });

  it('does not block SELECT with subqueries', async () => {
    const result = await tool.execute({
      action: 'query', db: tempDbPath,
      sql: 'SELECT count(*) FROM (SELECT id FROM users WHERE active=1);',
    });
    assert.ok(!result.includes('destructive SQL blocked'));
  });

  it('returns error when sql is missing for query action', async () => {
    const result = await tool.execute({ action: 'query', db: tempDbPath });
    assert.ok(result.includes('Error: sql is required for query'));
  });
});

describe('DatabaseTool — tables action on nonexistent db', () => {
  it('returns error for tables action on missing db (inside projectRoot)', async () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row8-db-tables-'));
    try {
      const tool = new DatabaseTool(workDir);
      const missing = path.join(workDir, 'no-such-db.db');
      const result = await tool.execute({ action: 'tables', db: missing });
      assert.ok(result.includes('Error: database not found'));
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

/**
 * Row 8 — argv shape via buildSqlitePlan(). Pure seam; no sqlite3 needed.
 * Pinning these is what keeps a future refactor from sliding back into
 * `execSync(string)` and the double-quote interpolation trap.
 */
describe('DatabaseTool — argv shape (Row 8: via buildSqlitePlan)', () => {
  let workDir: string;
  let tempDb: string;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row8-db-argv-'));
    tempDb = path.join(workDir, 'argv.db');
    fs.writeFileSync(tempDb, '', 'utf-8');
  });

  after(() => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('query: db and sql each become discrete argv elements (no shell interpolation)', () => {
    const tool = new DatabaseTool(workDir);
    const sql = 'SELECT 1; `touch /tmp/should-not-happen`';
    const plan = tool.buildSqlitePlan({ action: 'query', db: tempDb, sql });
    assert.ok(!('error' in plan));
    if ('error' in plan) return;
    assert.strictEqual(plan.command, 'sqlite3');
    assert.strictEqual(plan.argv[0], path.resolve(workDir, 'argv.db'));
    assert.strictEqual(plan.argv[1], sql,
      'sql must be its own argv element, with backtick literal');
    assert.ok(!plan.argv.some(a => a.includes('"') && a.includes('sqlite3')),
      'no element should resemble a pre-quoted shell fragment');
  });

  it('tables: argv is [db, ".tables"]', () => {
    const tool = new DatabaseTool(workDir);
    const plan = tool.buildSqlitePlan({ action: 'tables', db: tempDb });
    assert.ok(!('error' in plan));
    if ('error' in plan) return;
    assert.deepStrictEqual(plan.argv, [path.resolve(workDir, 'argv.db'), '.tables']);
  });

  it('schema with table: identifier validated, joined into one argv element', () => {
    const tool = new DatabaseTool(workDir);
    const plan = tool.buildSqlitePlan({ action: 'schema', db: tempDb, table: 'users' });
    assert.ok(!('error' in plan));
    if ('error' in plan) return;
    assert.deepStrictEqual(plan.argv, [path.resolve(workDir, 'argv.db'), '.schema users']);
  });

  it('schema rejects malicious table name (defense-in-depth)', () => {
    const tool = new DatabaseTool(workDir);
    const plan = tool.buildSqlitePlan({
      action: 'schema', db: tempDb, table: 'users; DROP TABLE x',
    });
    assert.ok('error' in plan);
    if ('error' in plan) assert.match(plan.error, /invalid table name/);
  });

  it('argv element 0 is always the resolved-absolute db path', () => {
    const tool = new DatabaseTool(workDir);
    const plan = tool.buildSqlitePlan({ action: 'tables', db: 'argv.db' /* relative */ });
    assert.ok(!('error' in plan));
    if ('error' in plan) return;
    assert.strictEqual(plan.argv[0], path.resolve(workDir, 'argv.db'),
      'relative db must be resolved against projectRoot');
  });
});

/**
 * Row 8 — db-path containment under projectRoot.
 */
describe('DatabaseTool — db-path containment (Row 8)', () => {
  it('rejects db path outside projectRoot (absolute escape)', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row8-db-contain-'));
    try {
      const tool = new DatabaseTool(workDir);
      const escapeTarget = process.platform === 'win32' ? 'C:\\Windows\\System32\\drivers\\etc\\hosts' : '/etc/passwd';
      const plan = tool.buildSqlitePlan({ action: 'tables', db: escapeTarget });
      assert.ok('error' in plan);
      if ('error' in plan) assert.match(plan.error, /db path escapes project root/);
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('rejects db path with parent traversal', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row8-db-contain-'));
    try {
      const tool = new DatabaseTool(workDir);
      const plan = tool.buildSqlitePlan({ action: 'tables', db: '../../../etc/passwd' });
      assert.ok('error' in plan);
      if ('error' in plan) assert.match(plan.error, /db path escapes project root/);
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });

  it('rejects sibling-prefix db path (not true containment)', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row8-db-contain-'));
    try {
      const sibling = workDir + '-evil/foo.db';
      const tool = new DatabaseTool(workDir);
      const plan = tool.buildSqlitePlan({ action: 'tables', db: sibling });
      assert.ok('error' in plan, 'sibling-prefix must be rejected');
    } finally {
      try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});

/**
 * Row 8 — real-exec canary. sqlite3 may or may not be installed on the
 * test host; we don't care. The point is whether a LOCAL shell was
 * spawned and interpreted the metacharacters BEFORE sqlite3 fired. If
 * a future refactor reverts to `execSync(string)`, the marker appears.
 */
describe('DatabaseTool — local-shell injection canary (real exec)', () => {
  let workDir: string;
  let originalCwd: string;

  before(() => {
    originalCwd = process.cwd();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row8-db-canary-'));
    process.chdir(workDir);
    fs.writeFileSync(path.join(workDir, 'real.db'), '');
  });

  after(() => {
    process.chdir(originalCwd);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('backticks in sql do not run a local shell', async () => {
    const marker = path.join(workDir, 'PWNED_SQL_BACKTICK');
    const tool = new DatabaseTool(workDir);
    const sql = `SELECT 1; \`node -e "require('fs').writeFileSync('${marker.replace(/\\/g, '\\\\')}','pwned')"\``;
    await tool.execute({ action: 'query', db: 'real.db', sql });
    assert.strictEqual(fs.existsSync(marker), false,
      `LOCAL SHELL INJECTION REGRESSION via sql backticks: ${marker} was created. Tool reverted to execSync(string).`);
  });

  it('$(...) in sql does not run a local shell', async () => {
    const marker = path.join(workDir, 'PWNED_SQL_DOLLAR');
    const tool = new DatabaseTool(workDir);
    const sql = `SELECT 1; $(node -e "require('fs').writeFileSync('${marker.replace(/\\/g, '\\\\')}','pwned')")`;
    await tool.execute({ action: 'query', db: 'real.db', sql });
    assert.strictEqual(fs.existsSync(marker), false,
      `LOCAL SHELL INJECTION REGRESSION via sql $(...): ${marker} was created.`);
  });
});
