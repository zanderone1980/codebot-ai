import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PluginForgeTool } from './plugin-forge';
import { isPluginSafe } from '../plugins';

describe('isPluginSafe', () => {
  it('allows safe code', () => {
    assert.strictEqual(isPluginSafe('const x = 1 + 2; return String(x);'), null);
  });

  it('blocks child_process', () => {
    const result = isPluginSafe('const cp = require("child_process")');
    assert.ok(result !== null && result.includes('child_process'), 'should block child_process');
  });

  it('blocks eval', () => {
    const result = isPluginSafe('eval("dangerous")');
    assert.ok(result !== null && result.includes('eval'), 'should block eval');
  });

  it('blocks fs access', () => {
    const result = isPluginSafe('const fs = require("fs")');
    assert.ok(result !== null && result.includes('fs'), 'should block fs');
  });

  it('blocks network access', () => {
    const result = isPluginSafe('const net = require("net")');
    assert.ok(result !== null && result.includes('net'), 'should block net');
  });

  it('blocks process.exit', () => {
    const result = isPluginSafe('process.exit(1)');
    assert.ok(result !== null && result.includes('process.exit'), 'should block process.exit');
  });

  it('blocks spawn', () => {
    const result = isPluginSafe('spawn("rm", ["-rf", "/"])');
    assert.ok(result !== null && result.includes('spawn'), 'should block spawn');
  });
});

describe('PluginForgeTool', () => {
  let tmpDir: string;
  let forge: PluginForgeTool;
  const origEnv = process.env.CODEBOT_HOME;

  before(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'plugin-forge-'));
    process.env.CODEBOT_HOME = tmpDir;
    forge = new PluginForgeTool();
  });

  after(() => {
    if (origEnv) process.env.CODEBOT_HOME = origEnv;
    else delete process.env.CODEBOT_HOME;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  describe('create', () => {
    it('creates plugin in staging', async () => {
      const result = await forge.execute({
        action: 'create',
        name: 'hello',
        description: 'Says hello',
        code: 'return "Hello, " + (args.name || "world");',
        parameters: { type: 'object', properties: { name: { type: 'string' } }, required: [] },
      });

      assert.ok(result.includes('created in staging'), 'should confirm staging creation');
      assert.ok(fs.existsSync(path.join(tmpDir, 'plugins', 'staging', 'hello.js')), 'staging file should exist');
    });

    it('blocks dangerous code', async () => {
      const result = await forge.execute({
        action: 'create',
        name: 'evil',
        code: 'const cp = require("child_process"); cp.execSync("rm -rf /");',
      });
      assert.ok(result.includes('BLOCKED'), 'should block dangerous code');
    });

    it('rejects empty name', async () => {
      const result = await forge.execute({ action: 'create', name: '', code: 'return 1' });
      assert.ok(result.includes('required'), 'should reject empty name');
    });

    it('rejects invalid name chars', async () => {
      const result = await forge.execute({ action: 'create', name: 'bad name!', code: 'return 1' });
      assert.ok(result.includes('must contain only'), 'should reject invalid chars');
    });

    it('generates manifest with hash', async () => {
      await forge.execute({ action: 'create', name: 'hashed', code: 'return 42;' });
      const manifest = JSON.parse(
        fs.readFileSync(path.join(tmpDir, 'plugins', 'staging', 'plugin.json'), 'utf-8'),
      );
      assert.match(manifest.hash, /^sha256:[a-f0-9]{64}$/);
    });
  });

  describe('list', () => {
    it('lists active and staging plugins', async () => {
      const result = await forge.execute({ action: 'list' });
      assert.ok(result.includes('hello') || result.includes('hashed'), 'should list created plugins');
    });
  });

  describe('validate', () => {
    it('passes valid plugin', async () => {
      await forge.execute({ action: 'create', name: 'valid_check', code: 'return "ok";' });
      const result = await forge.execute({ action: 'validate', name: 'valid_check' });
      assert.ok(result.includes('passed all safety checks'), 'should pass validation');
    });

    it('fails non-existent plugin', async () => {
      const result = await forge.execute({ action: 'validate', name: 'nonexistent' });
      assert.ok(result.includes('not found'), 'should report not found');
    });
  });

  describe('promote', () => {
    it('moves plugin from staging to active', async () => {
      await forge.execute({ action: 'create', name: 'promote_me', code: 'return "promoted";' });
      const result = await forge.execute({ action: 'promote', name: 'promote_me' });
      assert.ok(result.includes('promoted'), 'should confirm promotion');
      assert.ok(fs.existsSync(path.join(tmpDir, 'plugins', 'promote_me.js')), 'active file should exist');
      assert.ok(!fs.existsSync(path.join(tmpDir, 'plugins', 'staging', 'promote_me.js')), 'staging file should be removed');
    });
  });

  describe('remove', () => {
    it('removes plugin from staging', async () => {
      await forge.execute({ action: 'create', name: 'remove_me', code: 'return 1;' });
      const result = await forge.execute({ action: 'remove', name: 'remove_me' });
      assert.ok(result.includes('removed'), 'should confirm removal');
    });

    it('reports not found for missing plugin', async () => {
      const result = await forge.execute({ action: 'remove', name: 'ghost' });
      assert.ok(result.includes('not found'), 'should report not found');
    });
  });
});
