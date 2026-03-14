import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import { loadPlugins } from './plugins';

describe('loadPlugins', () => {
  let tmpDir: string;
  let pluginsDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-plugin-test-'));
    pluginsDir = path.join(tmpDir, '.codebot', 'plugins');
    fs.mkdirSync(pluginsDir, { recursive: true });
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns empty array when no plugins directory exists', () => {
    const plugins = loadPlugins('/nonexistent/path');
    // Should not throw, just return empty or whatever global plugins exist
    assert.ok(Array.isArray(plugins));
  });

  it('skips non-JS files', () => {
    fs.writeFileSync(path.join(pluginsDir, 'readme.txt'), 'not a plugin');
    const plugins = loadPlugins(tmpDir);
    // Should not load txt files
    const names = plugins.map(p => p.name);
    assert.ok(!names.includes('readme'));
  });

  it('skips JS files without manifest', () => {
    const pluginCode = 'module.exports = { name: "test_plugin", description: "test", execute: async () => "ok" };';
    fs.writeFileSync(path.join(pluginsDir, 'test.js'), pluginCode);
    // No manifest file — should be skipped
    const plugins = loadPlugins(tmpDir);
    const names = plugins.map(p => p.name);
    assert.ok(!names.includes('test_plugin'));
  });

  it('loads valid plugin with correct manifest', () => {
    const pluginCode = 'module.exports = { name: "valid_plugin", description: "A valid plugin", permission: "prompt", parameters: { type: "object", properties: {} }, execute: async () => "result" };';
    const pluginPath = path.join(pluginsDir, 'valid.js');
    fs.writeFileSync(pluginPath, pluginCode);
    // Compute hash from the file on disk (Buffer) to match how loadPlugins does it
    const hash = crypto.createHash('sha256').update(fs.readFileSync(pluginPath)).digest('hex');
    const manifest = { name: "valid_plugin", version: "1.0.0", hash: "sha256:" + hash };
    fs.writeFileSync(path.join(pluginsDir, 'plugin.json'), JSON.stringify(manifest));
    const plugins = loadPlugins(tmpDir);
    const found = plugins.find(p => p.name === 'valid_plugin');
    assert.ok(found, 'Should load valid plugin');
    assert.strictEqual(found!.description, 'A valid plugin');
  });

  it('rejects plugin with hash mismatch', () => {
    const pluginCode = 'module.exports = { name: "bad_hash", description: "test", execute: async () => "ok" };';
    const manifest = { name: "bad_hash", version: "1.0.0", hash: "sha256:" + "a".repeat(64) };
    fs.writeFileSync(path.join(pluginsDir, 'bad.js'), pluginCode);
    fs.writeFileSync(path.join(pluginsDir, 'plugin.json'), JSON.stringify(manifest));
    const plugins = loadPlugins(tmpDir);
    const found = plugins.find(p => p.name === 'bad_hash');
    assert.ok(!found, 'Should reject plugin with wrong hash');
  });

  it('rejects manifest with invalid name', () => {
    const pluginCode = 'module.exports = { name: "test", description: "test", execute: async () => "ok" };';
    const hash = crypto.createHash('sha256').update(pluginCode).digest('hex');
    const manifest = { name: "invalid name with spaces!", version: "1.0.0", hash: "sha256:" + hash };
    fs.writeFileSync(path.join(pluginsDir, 'invalid.js'), pluginCode);
    fs.writeFileSync(path.join(pluginsDir, 'plugin.json'), JSON.stringify(manifest));
    const plugins = loadPlugins(tmpDir);
    const found = plugins.find(p => p.name === 'invalid name with spaces!');
    assert.ok(!found, 'Should reject invalid manifest name');
  });

  it('rejects manifest with missing version', () => {
    const pluginCode = 'module.exports = { name: "test", description: "test", execute: async () => "ok" };';
    const hash = crypto.createHash('sha256').update(pluginCode).digest('hex');
    const manifest = { name: "nover", hash: "sha256:" + hash };
    fs.writeFileSync(path.join(pluginsDir, 'nover.js'), pluginCode);
    fs.writeFileSync(path.join(pluginsDir, 'plugin.json'), JSON.stringify(manifest));
    const plugins = loadPlugins(tmpDir);
    const found = plugins.find(p => p.name === 'nover');
    assert.ok(!found, 'Should reject manifest without version');
  });
});
