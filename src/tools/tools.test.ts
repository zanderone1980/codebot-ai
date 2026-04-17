import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ToolRegistry } from './index';

const TOTAL_TOOLS = 36;

describe('ToolRegistry', () => {
  it(`registers all ${TOTAL_TOOLS} tools`, () => {
    const registry = new ToolRegistry();
    const tools = registry.all();
    assert.strictEqual(tools.length, TOTAL_TOOLS);
  });

  it('can get all tools by name', () => {
    const registry = new ToolRegistry();
    const names = [
      // Original 13
      'read_file',
      'write_file',
      'edit_file',
      'batch_edit',
      'execute',
      'glob',
      'grep',
      'find_symbol',
      'think',
      'memory',
      'web_fetch',
      'web_search',
      'browser',
      'routine',
      // v1.4.0 — 15 new
      'git',
      'code_analysis',
      'multi_search',
      'task_planner',
      'diff_viewer',
      'docker',
      'database',
      'test_runner',
      'http_client',
      'image_info',
      'ssh_remote',
      'notification',
      'pdf_extract',
      'package_manager',
      'code_review',
      // v2.5.0 — app connectors + graphics
      'app',
      'graphics',
      'deep_research',
      'skill_forge',
      'plugin_forge',
      'decompose_goal',
      'delegate',
    ];
    for (const name of names) {
      assert.ok(registry.get(name), `Tool "${name}" not found`);
    }
  });

  it('returns undefined for unknown tools', () => {
    const registry = new ToolRegistry();
    assert.strictEqual(registry.get('nonexistent'), undefined);
  });

  it('generates valid tool schemas', () => {
    const registry = new ToolRegistry();
    const schemas = registry.getSchemas();
    assert.strictEqual(schemas.length, TOTAL_TOOLS);
    for (const schema of schemas) {
      assert.strictEqual(schema.type, 'function');
      assert.ok(schema.function.name, 'schema missing name');
      assert.ok(schema.function.description, 'schema missing description');
      assert.ok(schema.function.parameters, 'schema missing parameters');
    }
  });

  it('all tools have correct permission levels', () => {
    const registry = new ToolRegistry();
    const auto = [
      'read_file',
      'glob',
      'grep',
      'find_symbol',
      'think',
      'memory',
      'routine',
      'code_analysis',
      'multi_search',
      'task_planner',
      'diff_viewer',
      'image_info',
      'pdf_extract',
      'code_review',
      'deep_research',
      'decompose_goal',
    ];
    const prompt = [
      'write_file',
      'edit_file',
      'batch_edit',
      'web_fetch',
      'browser',
      'web_search',
      'git',
      'docker',
      'database',
      'test_runner',
      'http_client',
      'notification',
      'package_manager',
      'app',
      'graphics',
      'execute',
      'delegate',
      'skill_forge',
      'plugin_forge',
    ];
    const alwaysAsk = ['ssh_remote'];

    for (const name of auto) {
      assert.strictEqual(registry.get(name)!.permission, 'auto', `${name} should be auto`);
    }
    for (const name of prompt) {
      assert.strictEqual(registry.get(name)!.permission, 'prompt', `${name} should be prompt`);
    }
    for (const name of alwaysAsk) {
      assert.strictEqual(registry.get(name)!.permission, 'always-ask', `${name} should be always-ask`);
    }
  });
});

describe('ReadFileTool', () => {
  const tmpDir = path.join(os.tmpdir(), 'codebot-test-' + Date.now());
  const testFile = path.join(tmpDir, 'test.txt');

  before(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(testFile, 'line1\nline2\nline3\nline4\nline5\n');
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('reads a file with line numbers', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('read_file')!;
    const result = await tool.execute({ path: testFile });
    assert.ok(result.includes('line1'));
    assert.ok(result.includes('line2'));
    assert.ok(/^\s*1\t/.test(result)); // Line number
  });

  it('supports offset and limit', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('read_file')!;
    const result = await tool.execute({ path: testFile, offset: 2, limit: 2 });
    assert.ok(result.includes('line2'));
    assert.ok(result.includes('line3'));
    assert.ok(!result.includes('line1'));
    assert.ok(!result.includes('line4'));
  });

  it('throws for nonexistent file', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('read_file')!;
    await assert.rejects(() => tool.execute({ path: '/nonexistent/file.txt' }));
  });
});

describe('WriteFileTool', () => {
  // Use a directory under user home so path safety checks pass
  const tmpDir = path.join(os.homedir(), '.codebot', 'test-write-' + Date.now());

  before(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('creates a new file', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('write_file')!;
    const filePath = path.join(tmpDir, 'new.txt');
    const result = await tool.execute({ path: filePath, content: 'hello world' });
    assert.ok(result.includes('Created'));
    assert.strictEqual(fs.readFileSync(filePath, 'utf-8'), 'hello world');
  });

  it('overwrites existing file', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('write_file')!;
    const filePath = path.join(tmpDir, 'overwrite.txt');
    fs.writeFileSync(filePath, 'old content');
    const result = await tool.execute({ path: filePath, content: 'new content' });
    assert.ok(result.includes('Overwrote'));
    assert.strictEqual(fs.readFileSync(filePath, 'utf-8'), 'new content');
  });
});

describe('EditFileTool', () => {
  // Use a directory under user home so path safety checks pass
  const tmpDir = path.join(os.homedir(), '.codebot', 'test-edit-' + Date.now());

  before(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('replaces a unique string', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('edit_file')!;
    const filePath = path.join(tmpDir, 'edit.txt');
    fs.writeFileSync(filePath, 'hello world');
    await tool.execute({ path: filePath, old_string: 'hello', new_string: 'goodbye' });
    assert.strictEqual(fs.readFileSync(filePath, 'utf-8'), 'goodbye world');
  });

  it('throws if string not found', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('edit_file')!;
    const filePath = path.join(tmpDir, 'edit2.txt');
    fs.writeFileSync(filePath, 'hello world');
    await assert.rejects(() => tool.execute({ path: filePath, old_string: 'xyz', new_string: 'abc' }));
  });

  it('throws if string found multiple times', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('edit_file')!;
    const filePath = path.join(tmpDir, 'edit3.txt');
    fs.writeFileSync(filePath, 'aaa bbb aaa');
    await assert.rejects(() => tool.execute({ path: filePath, old_string: 'aaa', new_string: 'ccc' }));
  });
});

describe('GlobTool', () => {
  const tmpDir = path.join(os.tmpdir(), 'codebot-test-glob-' + Date.now());

  before(() => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'app.ts'), '');
    fs.writeFileSync(path.join(tmpDir, 'src', 'util.ts'), '');
    fs.writeFileSync(path.join(tmpDir, 'readme.md'), '');
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds files matching pattern', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('glob')!;
    const result = await tool.execute({ pattern: '**/*.ts', cwd: tmpDir });
    assert.ok(result.includes('app.ts'));
    assert.ok(result.includes('util.ts'));
    assert.ok(!result.includes('readme.md'));
  });
});

describe('GrepTool', () => {
  const tmpDir = path.join(os.tmpdir(), 'codebot-test-grep-' + Date.now());

  before(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'file.ts'), 'function hello() {\n  return "world";\n}\n');
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds matching lines', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('grep')!;
    const result = await tool.execute({ pattern: 'function', path: tmpDir });
    assert.ok(result.includes('function hello'));
  });

  it('returns no matches message', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('grep')!;
    const result = await tool.execute({ pattern: 'nonexistent_string_xyz', path: tmpDir });
    assert.ok(result.includes('No matches'));
  });
});

describe('ExecuteTool', () => {
  it('blocks dangerous commands', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('execute')!;
    await assert.rejects(() => tool.execute({ command: 'rm -rf /' }));
    await assert.rejects(() => tool.execute({ command: 'rm -rf ~' }));
  });

  it('executes safe commands', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('execute')!;
    const result = await tool.execute({ command: 'echo hello' });
    assert.ok(result.includes('hello'));
  });
});

describe('ThinkTool', () => {
  it('returns acknowledgment', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('think')!;
    const result = await tool.execute({ thought: 'I need to consider the architecture.' });
    assert.strictEqual(result, 'Thought recorded.');
  });
});

// ============ v1.4.0 New Tool Tests ============

describe('GitTool', () => {
  it('returns error for unknown action', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('git')!;
    const result = await tool.execute({ action: 'rebase_force_push_destroy' });
    assert.ok(result.includes('Error: unknown action'));
  });

  it('blocks force push to main', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('git')!;
    const result = await tool.execute({ action: 'push', args: '--force main' });
    assert.ok(result.includes('blocked'));
  });

  it('runs git status successfully', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('git')!;
    const result = await tool.execute({ action: 'status' });
    assert.ok(result.includes('branch') || result.includes('On branch') || result.includes('nothing'));
  });
});

describe('CodeAnalysisTool', () => {
  const tmpDir = path.join(os.tmpdir(), 'codebot-test-analysis-' + Date.now());

  before(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'sample.ts'),
      'export class Foo {\n  bar(): string { return "hi"; }\n}\nfunction baz() {}\n',
    );
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('extracts symbols from a file', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('code_analysis')!;
    const result = await tool.execute({ action: 'symbols', path: path.join(tmpDir, 'sample.ts') });
    assert.ok(result.includes('class Foo'));
    assert.ok(result.includes('function baz'));
  });

  it('extracts imports', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('code_analysis')!;
    const tmpFile = path.join(tmpDir, 'imports.ts');
    fs.writeFileSync(tmpFile, "import { foo } from './foo';\nimport * as path from 'path';\n");
    const result = await tool.execute({ action: 'imports', path: tmpFile });
    assert.ok(result.includes('./foo'));
    assert.ok(result.includes('path'));
  });

  it('returns error for unknown action', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('code_analysis')!;
    const result = await tool.execute({ action: 'explode', path: tmpDir });
    assert.ok(result.includes('Error: unknown action'));
  });
});

describe('MultiSearchTool', () => {
  const tmpDir = path.join(os.tmpdir(), 'codebot-test-msearch-' + Date.now());

  before(() => {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'src', 'auth.ts'), 'export function authenticateUser() {}\n');
    fs.writeFileSync(path.join(tmpDir, 'src', 'db.ts'), 'export class DatabaseClient {}\n');
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds files by query', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('multi_search')!;
    const result = await tool.execute({ query: 'auth', path: tmpDir });
    assert.ok(result.includes('auth'));
  });

  it('returns no results for gibberish', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('multi_search')!;
    const result = await tool.execute({ query: 'xyzqwertyuiop99887766', path: tmpDir });
    assert.ok(result.includes('No results'));
  });
});

describe('TaskPlannerTool', () => {
  it('adds and lists tasks', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('task_planner')!;

    const addResult = await tool.execute({ action: 'add', title: 'Test task', priority: 'high' });
    assert.ok(addResult.includes('Added task'));

    const listResult = await tool.execute({ action: 'list' });
    assert.ok(listResult.includes('Test task'));
    assert.ok(listResult.includes('pending'));

    // Clean up
    await tool.execute({ action: 'clear' });
  });

  it('returns error for unknown action', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('task_planner')!;
    const result = await tool.execute({ action: 'explode' });
    assert.ok(result.includes('Error: unknown action'));
  });
});

describe('DiffViewerTool', () => {
  const tmpDir = path.join(os.tmpdir(), 'codebot-test-diff-' + Date.now());

  before(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(path.join(tmpDir, 'a.txt'), 'line1\nline2\nline3\n');
    fs.writeFileSync(path.join(tmpDir, 'b.txt'), 'line1\nchanged\nline3\n');
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('diffs two files', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('diff_viewer')!;
    const result = await tool.execute({
      action: 'files',
      file_a: path.join(tmpDir, 'a.txt'),
      file_b: path.join(tmpDir, 'b.txt'),
    });
    assert.ok(result.includes('line2'));
    assert.ok(result.includes('changed'));
    assert.ok(result.includes('differ'));
  });

  it('reports identical files', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('diff_viewer')!;
    const result = await tool.execute({
      action: 'files',
      file_a: path.join(tmpDir, 'a.txt'),
      file_b: path.join(tmpDir, 'a.txt'),
    });
    assert.ok(result.includes('identical'));
  });
});

describe('DatabaseTool', () => {
  const tmpDb = path.join(os.tmpdir(), `codebot-test-${Date.now()}.db`);

  before(() => {
    // Create an empty file to pass existence check
    fs.writeFileSync(tmpDb, '');
  });

  after(() => {
    try {
      fs.unlinkSync(tmpDb);
    } catch {
      /* ok */
    }
  });

  it('blocks destructive SQL', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('database')!;
    const result = await tool.execute({ action: 'query', db: tmpDb, sql: 'DROP TABLE users' });
    assert.ok(result.includes('blocked'), `Expected "blocked" in: ${result}`);
  });

  it('blocks DELETE FROM', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('database')!;
    const result = await tool.execute({ action: 'query', db: tmpDb, sql: 'DELETE FROM users WHERE id=1' });
    assert.ok(result.includes('blocked'), `Expected "blocked" in: ${result}`);
  });

  it('returns error for missing db', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('database')!;
    const result = await tool.execute({ action: 'tables', db: '/nonexistent/db.sqlite' });
    assert.ok(result.includes('Error: database not found'));
  });
});

describe('TestRunnerTool', () => {
  it('detects framework in current project', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('test_runner')!;
    const result = await tool.execute({ action: 'detect' });
    assert.ok(result.includes('node:test') || result.includes('npm test') || result.includes('Detected'));
  });

  it('returns error for unknown action', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('test_runner')!;
    const result = await tool.execute({ action: 'destroy' });
    assert.ok(result.includes('Error: unknown action'));
  });
});

describe('HttpClientTool', () => {
  it('blocks localhost requests', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('http_client')!;
    const result = await tool.execute({ url: 'http://localhost:8080/admin' });
    assert.ok(result.includes('blocked'));
  });

  it('blocks private IP requests', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('http_client')!;
    const result = await tool.execute({ url: 'http://10.0.0.1/internal' });
    assert.ok(result.includes('blocked'));
  });

  it('returns error for invalid URL', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('http_client')!;
    const result = await tool.execute({ url: 'not-a-url' });
    assert.ok(result.includes('Error: invalid URL'));
  });
});

describe('ImageInfoTool', () => {
  it('returns error for missing file', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('image_info')!;
    const result = await tool.execute({ path: '/nonexistent/image.png' });
    assert.ok(result.includes('Error: file not found'));
  });

  it('reads a PNG file header', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('image_info')!;
    // Create a minimal PNG
    const tmpFile = path.join(os.tmpdir(), `test-${Date.now()}.png`);
    const pngHeader = Buffer.from([
      0x89,
      0x50,
      0x4e,
      0x47,
      0x0d,
      0x0a,
      0x1a,
      0x0a, // PNG signature
      0x00,
      0x00,
      0x00,
      0x0d,
      0x49,
      0x48,
      0x44,
      0x52, // IHDR chunk
      0x00,
      0x00,
      0x00,
      0x10, // width: 16
      0x00,
      0x00,
      0x00,
      0x08, // height: 8
      0x08,
      0x02,
      0x00,
      0x00,
      0x00,
    ]);
    fs.writeFileSync(tmpFile, pngHeader);
    const result = await tool.execute({ path: tmpFile });
    assert.ok(result.includes('PNG'));
    assert.ok(result.includes('16'));
    assert.ok(result.includes('8'));
    fs.unlinkSync(tmpFile);
  });
});

describe('CodeReviewTool', () => {
  const tmpDir = path.join(os.tmpdir(), 'codebot-test-review-' + Date.now());

  before(() => {
    fs.mkdirSync(tmpDir, { recursive: true });
    fs.writeFileSync(
      path.join(tmpDir, 'bad.ts'),
      'eval("danger");\nconst secret = "abc123456789";\n// TODO fix this\n',
    );
  });

  after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('finds security issues', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('code_review')!;
    const result = await tool.execute({ action: 'security', path: path.join(tmpDir, 'bad.ts'), severity: 'info' });
    assert.ok(result.includes('eval'));
    assert.ok(result.includes('issue'));
  });

  it('returns error for unknown action', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('code_review')!;
    const result = await tool.execute({ action: 'destroy', path: tmpDir });
    assert.ok(result.includes('Error: unknown action'));
  });
});

describe('PackageManagerTool', () => {
  it('detects package manager', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('package_manager')!;
    const result = await tool.execute({ action: 'detect' });
    assert.ok(
      result.includes('npm') || result.includes('yarn') || result.includes('pnpm') || result.includes('Detected'),
    );
  });

  it('returns error for unknown action', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('package_manager')!;
    const result = await tool.execute({ action: 'explode' });
    assert.ok(result.includes('Error: unknown action'));
  });
});

describe('SshRemoteTool', () => {
  it('blocks injection in host', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('ssh_remote')!;
    const result = await tool.execute({ action: 'exec', host: 'user@host; rm -rf /', command: 'ls' });
    assert.ok(result.includes('invalid characters'));
  });

  it('returns error for missing host', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('ssh_remote')!;
    const result = await tool.execute({ action: 'exec' });
    assert.ok(result.includes('Error: host is required'));
  });
});

describe('NotificationTool', () => {
  it('returns error for invalid URL', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('notification')!;
    const result = await tool.execute({ action: 'webhook', url: 'not-a-url', message: 'test' });
    assert.ok(result.includes('Error: invalid URL'));
  });

  it('returns error for unknown action', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('notification')!;
    const result = await tool.execute({ action: 'telegram', url: 'https://example.com', message: 'test' });
    assert.ok(result.includes('Error: unknown action'));
  });
});

describe('DockerTool', () => {
  it('blocks --privileged flag', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('docker')!;
    const result = await tool.execute({ action: 'run', args: '--privileged ubuntu' });
    assert.ok(result.includes('blocked'));
  });

  it('returns error for unknown action', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('docker')!;
    const result = await tool.execute({ action: 'nuke' });
    assert.ok(result.includes('Error: unknown action'));
  });
});

// ============ Security Tests ============

describe('GrepTool — security', () => {
  it('handles invalid regex gracefully', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('grep')!;
    const result = await tool.execute({ pattern: '[invalid(' });
    assert.ok(result.includes('Error: invalid regex pattern'));
  });

  it('handles nonexistent path gracefully', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('grep')!;
    const result = await tool.execute({ pattern: 'test', path: '/nonexistent/path/xyz' });
    assert.ok(result.includes('Error: path not found'));
  });

  it('returns error when pattern is missing', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('grep')!;
    const result = await tool.execute({});
    assert.ok(result.includes('Error: pattern is required'));
  });
});

describe('WebFetchTool — SSRF protection', () => {
  it('blocks file:// protocol', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('web_fetch')!;
    const result = await tool.execute({ url: 'file:///etc/passwd' });
    assert.ok(result.includes('Blocked protocol'));
  });

  it('blocks ftp:// protocol', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('web_fetch')!;
    const result = await tool.execute({ url: 'ftp://evil.com/file' });
    assert.ok(result.includes('Blocked protocol'));
  });

  it('blocks localhost', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('web_fetch')!;
    const result = await tool.execute({ url: 'http://localhost/admin' });
    assert.ok(result.includes('Blocked'));
  });

  it('blocks 127.0.0.1', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('web_fetch')!;
    const result = await tool.execute({ url: 'http://127.0.0.1:8080' });
    assert.ok(result.includes('Blocked'));
  });

  it('blocks cloud metadata endpoint', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('web_fetch')!;
    const result = await tool.execute({ url: 'http://169.254.169.254/latest/meta-data/' });
    assert.ok(result.includes('Blocked'));
  });

  it('blocks private IP 10.x.x.x', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('web_fetch')!;
    const result = await tool.execute({ url: 'http://10.0.0.1/internal' });
    assert.ok(result.includes('Blocked'));
  });

  it('blocks private IP 192.168.x.x', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('web_fetch')!;
    const result = await tool.execute({ url: 'http://192.168.1.1/admin' });
    assert.ok(result.includes('Blocked'));
  });

  it('blocks private IP 172.16.x.x', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('web_fetch')!;
    const result = await tool.execute({ url: 'http://172.16.0.1/internal' });
    assert.ok(result.includes('Blocked'));
  });

  it('returns error for invalid URL', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('web_fetch')!;
    const result = await tool.execute({ url: 'not-a-url' });
    assert.ok(result.includes('Invalid URL'));
  });

  it('returns error when url is missing', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('web_fetch')!;
    const result = await tool.execute({});
    assert.ok(result.includes('Error: url is required'));
  });
});

describe('MemoryTool — path traversal protection', () => {
  it('strips path traversal from file names', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('memory')!;
    const result = await tool.execute({
      action: 'read',
      file: '../../../etc/passwd',
    });
    assert.ok(result.includes('passwd') || result.includes('no file'));
    assert.ok(!result.includes('root:'));
  });

  it('strips path traversal with nested ../', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('memory')!;
    const result = await tool.execute({
      action: 'read',
      file: '../../config.json',
    });
    assert.ok(result.includes('config.json') || result.includes('no file'));
  });

  it('writes project topic files under the provided project root', async () => {
    const os = await import('os');
    const path = await import('path');
    const fs = await import('fs');

    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'memory-tool-project-'));
    try {
      const registry = new ToolRegistry(projectRoot);
      const tool = registry.get('memory')!;
      const result = await tool.execute({
        action: 'write',
        scope: 'project',
        file: 'preferences',
        content: 'Prefer concise summaries',
      });

      assert.ok(result.includes('preferences.md'));
      const savedPath = path.join(projectRoot, '.codebot', 'memory', 'preferences.md');
      assert.ok(fs.existsSync(savedPath), 'memory file should be written inside the project root');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

describe('Input validation — missing required args', () => {
  it('read_file: returns error for missing path', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('read_file')!;
    const result = await tool.execute({});
    assert.ok(result.includes('Error: path is required'));
  });

  it('write_file: returns error for missing path', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('write_file')!;
    const result = await tool.execute({ content: 'test' });
    assert.ok(result.includes('Error: path is required'));
  });

  it('write_file: returns error for missing content', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('write_file')!;
    const result = await tool.execute({ path: '/tmp/test.txt' });
    assert.ok(result.includes('Error: content is required'));
  });

  it('edit_file: returns error for missing path', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('edit_file')!;
    const result = await tool.execute({ old_string: 'a', new_string: 'b' });
    assert.ok(result.includes('Error: path is required'));
  });

  it('edit_file: returns error for missing old_string', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('edit_file')!;
    const result = await tool.execute({ path: '/tmp/test.txt', new_string: 'b' });
    assert.ok(result.includes('Error: old_string is required'));
  });

  it('execute: returns error for missing command', async () => {
    const registry = new ToolRegistry();
    const tool = registry.get('execute')!;
    const result = await tool.execute({});
    assert.ok(result.includes('Error: command is required'));
  });
});
