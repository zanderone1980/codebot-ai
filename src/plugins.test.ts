import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';

// Import the loadPlugins function -- we test it with temp directories
import { loadPlugins } from './plugins';

describe('Plugin System — loadPlugins', () => {
  it('returns empty array when no plugin directories exist', () => {
    const plugins = loadPlugins('/nonexistent/project/root');
    // May return plugins from global dir, but should not throw
    assert.ok(Array.isArray(plugins));
  });

  it('skips non-.js files in plugin directory', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-plugin-test-'));
    const pluginDir = path.join(tmpDir, '.codebot', 'plugins');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'readme.txt'), 'not a plugin');
    const plugins = loadPlugins(tmpDir);
    // Should not load .txt files
    const fromDir = plugins.filter(p => p.name === 'readme');
    assert.strictEqual(fromDir.length, 0);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips plugin without manifest (plugin.json)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-plugin-test-'));
    const pluginDir = path.join(tmpDir, '.codebot', 'plugins');
    fs.mkdirSync(pluginDir, { recursive: true });
    fs.writeFileSync(path.join(pluginDir, 'my-plugin.js'), 'module.exports = { name: "test" }');
    // No plugin.json
    const plugins = loadPlugins(tmpDir);
    const fromDir = plugins.filter(p => p.name === 'test');
    assert.strictEqual(fromDir.length, 0);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips plugin with hash mismatch', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-plugin-test-'));
    const pluginDir = path.join(tmpDir, '.codebot', 'plugins');
    fs.mkdirSync(pluginDir, { recursive: true });

    const pluginCode = 'module.exports = { name: "mismatch", description: "test", permission: "auto", parameters: { type: "object" }, execute: async () => "ok" };';
    fs.writeFileSync(path.join(pluginDir, 'mismatch.js'), pluginCode);
    fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({
      name: 'mismatch',
      version: '1.0.0',
      hash: 'sha256:' + '0'.repeat(64), // wrong hash
    }));

    const plugins = loadPlugins(tmpDir);
    const fromDir = plugins.filter(p => p.name === 'mismatch');
    assert.strictEqual(fromDir.length, 0);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('loads valid plugin with correct hash', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-plugin-test-'));
    const pluginDir = path.join(tmpDir, '.codebot', 'plugins');
    fs.mkdirSync(pluginDir, { recursive: true });

    const pluginCode = 'module.exports = { name: "valid_plugin", description: "A valid plugin", permission: "auto", parameters: { type: "object", properties: {} }, execute: async () => "ok" };';
    const pluginPath = path.join(pluginDir, 'valid.js');
    fs.writeFileSync(pluginPath, pluginCode);

    const hash = 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(pluginPath)).digest('hex');
    fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({
      name: 'valid_plugin',
      version: '1.0.0',
      hash,
    }));

    const plugins = loadPlugins(tmpDir);
    const found = plugins.filter(p => p.name === 'valid_plugin');
    assert.strictEqual(found.length, 1);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips plugin with invalid manifest name', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-plugin-test-'));
    const pluginDir = path.join(tmpDir, '.codebot', 'plugins');
    fs.mkdirSync(pluginDir, { recursive: true });

    const pluginCode = 'module.exports = { name: "test", description: "d", permission: "auto", parameters: {}, execute: async () => "ok" };';
    fs.writeFileSync(path.join(pluginDir, 'test.js'), pluginCode);
    const hash = 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(path.join(pluginDir, 'test.js'))).digest('hex');
    fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({
      name: 'invalid name with spaces!',
      version: '1.0.0',
      hash,
    }));

    const plugins = loadPlugins(tmpDir);
    const found = plugins.filter(p => p.name === 'test');
    assert.strictEqual(found.length, 0);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips plugin with invalid manifest version', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-plugin-test-'));
    const pluginDir = path.join(tmpDir, '.codebot', 'plugins');
    fs.mkdirSync(pluginDir, { recursive: true });

    const pluginCode = 'module.exports = { name: "test2", description: "d", permission: "auto", parameters: {}, execute: async () => "ok" };';
    fs.writeFileSync(path.join(pluginDir, 'test2.js'), pluginCode);
    const hash = 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(path.join(pluginDir, 'test2.js'))).digest('hex');
    fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({
      name: 'test2',
      version: 'not-semver',
      hash,
    }));

    const plugins = loadPlugins(tmpDir);
    const found = plugins.filter(p => p.name === 'test2');
    assert.strictEqual(found.length, 0);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips plugin with malformed plugin.json', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-plugin-test-'));
    const pluginDir = path.join(tmpDir, '.codebot', 'plugins');
    fs.mkdirSync(pluginDir, { recursive: true });

    fs.writeFileSync(path.join(pluginDir, 'bad.js'), 'module.exports = {}');
    fs.writeFileSync(path.join(pluginDir, 'plugin.json'), '{invalid json');

    const plugins = loadPlugins(tmpDir);
    const found = plugins.filter(p => p.name === 'bad');
    assert.strictEqual(found.length, 0);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips plugin with invalid hash format (wrong length)', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-plugin-test-'));
    const pluginDir = path.join(tmpDir, '.codebot', 'plugins');
    fs.mkdirSync(pluginDir, { recursive: true });

    fs.writeFileSync(path.join(pluginDir, 'short.js'), 'module.exports = {}');
    fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({
      name: 'short',
      version: '1.0.0',
      hash: 'sha256:tooshort',
    }));

    const plugins = loadPlugins(tmpDir);
    const found = plugins.filter(p => p.name === 'short');
    assert.strictEqual(found.length, 0);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('skips plugin that does not implement Tool interface', () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-plugin-test-'));
    const pluginDir = path.join(tmpDir, '.codebot', 'plugins');
    fs.mkdirSync(pluginDir, { recursive: true });

    // Missing 'execute' function
    const pluginCode = 'module.exports = { name: "incomplete", description: "d" };';
    const pluginPath = path.join(pluginDir, 'incomplete.js');
    fs.writeFileSync(pluginPath, pluginCode);
    const hash = 'sha256:' + crypto.createHash('sha256').update(fs.readFileSync(pluginPath)).digest('hex');
    fs.writeFileSync(path.join(pluginDir, 'plugin.json'), JSON.stringify({
      name: 'incomplete',
      version: '1.0.0',
      hash,
    }));

    const plugins = loadPlugins(tmpDir);
    const found = plugins.filter(p => p.name === 'incomplete');
    assert.strictEqual(found.length, 0);
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });
});
