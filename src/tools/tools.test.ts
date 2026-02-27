import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ToolRegistry } from './index';

describe('ToolRegistry', () => {
  it('registers all 11 tools', () => {
    const registry = new ToolRegistry();
    const tools = registry.all();
    assert.strictEqual(tools.length, 11);
  });

  it('can get tools by name', () => {
    const registry = new ToolRegistry();
    const names = ['read_file', 'write_file', 'edit_file', 'batch_edit', 'execute', 'glob', 'grep', 'think', 'memory', 'web_fetch', 'browser'];
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
    assert.strictEqual(schemas.length, 11);
    for (const schema of schemas) {
      assert.strictEqual(schema.type, 'function');
      assert.ok(schema.function.name, 'schema missing name');
      assert.ok(schema.function.description, 'schema missing description');
      assert.ok(schema.function.parameters, 'schema missing parameters');
    }
  });

  it('all tools have correct permission levels', () => {
    const registry = new ToolRegistry();
    const auto = ['read_file', 'glob', 'grep', 'think', 'memory'];
    const prompt = ['write_file', 'edit_file', 'batch_edit', 'web_fetch', 'browser'];
    const alwaysAsk = ['execute'];

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
  const tmpDir = path.join(os.tmpdir(), 'codebot-test-write-' + Date.now());

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
  const tmpDir = path.join(os.tmpdir(), 'codebot-test-edit-' + Date.now());

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
    // This should NOT be able to write outside the memory directory
    const result = await tool.execute({
      action: 'read',
      file: '../../../etc/passwd',
    });
    // Should try to read "passwd.md" not traverse up
    assert.ok(result.includes('passwd') || result.includes('no file'));
    assert.ok(!result.includes('root:')); // Should NOT read /etc/passwd
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
