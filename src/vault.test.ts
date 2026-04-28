import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { makeTestVaultPath } from './test-vault-isolation';

describe('VaultManager', () => {
  let vaultPath: string;

  before(() => {
    process.env.CODEBOT_VAULT_KEY = 'test-vault-passphrase-123';
    vaultPath = makeTestVaultPath();
  });

  after(() => {
    try { fs.rmSync(path.dirname(vaultPath), { recursive: true, force: true }); } catch { /* best-effort */ }
    delete process.env.CODEBOT_VAULT_KEY;
  });

  it('starts with empty vault', async () => {
    const { VaultManager } = await import('./vault');
    const vault = new VaultManager({ vaultPath });
    assert.deepStrictEqual(vault.list(), []);
  });

  it('sets and gets a credential', async () => {
    const { VaultManager } = await import('./vault');
    const vault = new VaultManager({ vaultPath });
    vault.set('github', {
      type: 'api_key',
      value: 'ghp_test123',
      metadata: { provider: 'GitHub', created: new Date().toISOString() },
    });
    const cred = vault.get('github');
    assert.ok(cred);
    assert.strictEqual(cred!.name, 'github');
    assert.strictEqual(cred!.value, 'ghp_test123');
    assert.strictEqual(cred!.type, 'api_key');
  });

  it('list returns names only', async () => {
    const { VaultManager } = await import('./vault');
    const vault = new VaultManager({ vaultPath });
    vault.set('test-cred', {
      type: 'api_key',
      value: 'secret-value',
      metadata: { provider: 'Test', created: new Date().toISOString() },
    });
    const names = vault.list();
    assert.ok(names.includes('test-cred'));
    // Ensure values are NOT returned
    assert.ok(!names.includes('secret-value'));
  });

  it('has returns true for existing credential', async () => {
    const { VaultManager } = await import('./vault');
    const vault = new VaultManager({ vaultPath });
    vault.set('exists', {
      type: 'api_key',
      value: 'val',
      metadata: { provider: 'Test', created: new Date().toISOString() },
    });
    assert.ok(vault.has('exists'));
    assert.ok(!vault.has('nonexistent'));
  });

  it('delete removes a credential', async () => {
    const { VaultManager } = await import('./vault');
    const vault = new VaultManager({ vaultPath });
    vault.set('to-delete', {
      type: 'api_key',
      value: 'val',
      metadata: { provider: 'Test', created: new Date().toISOString() },
    });
    assert.ok(vault.has('to-delete'));
    const removed = vault.delete('to-delete');
    assert.ok(removed);
    assert.ok(!vault.has('to-delete'));
  });

  it('delete returns false for nonexistent credential', async () => {
    const { VaultManager } = await import('./vault');
    const vault = new VaultManager({ vaultPath });
    assert.strictEqual(vault.delete('nonexistent'), false);
  });

  it('overwrites existing credential with set', async () => {
    const { VaultManager } = await import('./vault');
    const vault = new VaultManager({ vaultPath });
    vault.set('overwrite', {
      type: 'api_key',
      value: 'old-value',
      metadata: { provider: 'Test', created: new Date().toISOString() },
    });
    vault.set('overwrite', {
      type: 'api_key',
      value: 'new-value',
      metadata: { provider: 'Test', created: new Date().toISOString() },
    });
    const cred = vault.get('overwrite');
    assert.strictEqual(cred!.value, 'new-value');
  });

  it('get returns undefined for nonexistent credential', async () => {
    const { VaultManager } = await import('./vault');
    const vault = new VaultManager({ vaultPath });
    assert.strictEqual(vault.get('nonexistent'), undefined);
  });
});

/**
 * Regression test for the test-suite-pollutes-real-vault bug.
 *
 * Pre-fix, every test that did `new VaultManager()` wrote to the
 * user's real `~/.codebot/vault.json`. This test proves the fix:
 * a VaultManager bound to the production path is not affected by
 * VaultManagers bound to isolated paths in the same process.
 *
 * The test does NOT use the user's real `codebotPath('vault.json')`
 * — it stages an isolated "production-like" path and an isolated
 * "test-like" path, both in tmpdir, and asserts the test path
 * cannot leak into the production path.
 */
describe('VaultManager isolation regression', () => {
  let prodVaultPath: string;
  let testVaultPath: string;
  const origKey = process.env.CODEBOT_VAULT_KEY;

  before(() => {
    prodVaultPath = makeTestVaultPath();
    testVaultPath = makeTestVaultPath();
  });

  after(() => {
    try { fs.rmSync(path.dirname(prodVaultPath), { recursive: true, force: true }); } catch { /* best-effort */ }
    try { fs.rmSync(path.dirname(testVaultPath), { recursive: true, force: true }); } catch { /* best-effort */ }
    if (origKey === undefined) delete process.env.CODEBOT_VAULT_KEY;
    else process.env.CODEBOT_VAULT_KEY = origKey;
  });

  it('a vault at an isolated path does not write to the production path', async () => {
    const { VaultManager } = await import('./vault');

    // Stage a "production" credential under the production-like path
    // with the production-like passphrase.
    process.env.CODEBOT_VAULT_KEY = 'prod-passphrase-do-not-leak';
    const prod = new VaultManager({ vaultPath: prodVaultPath });
    prod.set('prod-cred', {
      type: 'api_key',
      value: 'PROD-SECRET-VALUE',
      metadata: { provider: 'prod', created: new Date().toISOString() },
    });
    const prodSizeBefore = fs.statSync(prodVaultPath).size;
    const prodHashBefore = fs.readFileSync(prodVaultPath, 'utf-8');

    // Now simulate a test setup: different passphrase, isolated path.
    process.env.CODEBOT_VAULT_KEY = 'test-passphrase';
    const test = new VaultManager({ vaultPath: testVaultPath });
    test.set('test-cred', {
      type: 'api_key',
      value: 'test-only',
      metadata: { provider: 'test', created: new Date().toISOString() },
    });

    // Production file untouched.
    assert.strictEqual(fs.statSync(prodVaultPath).size, prodSizeBefore);
    assert.strictEqual(fs.readFileSync(prodVaultPath, 'utf-8'), prodHashBefore);

    // And the prod credential still decrypts under the prod
    // passphrase (this is the symptom we are guarding against —
    // pre-fix the prod file would have been re-encrypted with the
    // test passphrase and decrypt() would silently return empty).
    process.env.CODEBOT_VAULT_KEY = 'prod-passphrase-do-not-leak';
    const prodReopen = new VaultManager({ vaultPath: prodVaultPath });
    const cred = prodReopen.get('prod-cred');
    assert.ok(cred, 'prod credential should still be readable after isolated test runs');
    assert.strictEqual(cred!.value, 'PROD-SECRET-VALUE');
  });

  it('default-constructed VaultManager (no opts) hits codebotPath, not the test path', async () => {
    // Sanity: confirm the override is the only way isolated paths
    // get used. A no-arg construction must report the production
    // codebotPath in status() — if it ever drifts to a tempdir we
    // want the test to scream.
    const { VaultManager } = await import('./vault');
    const { codebotPath } = await import('./paths');
    const vault = new VaultManager();
    assert.strictEqual(vault.status().vaultPath, codebotPath('vault.json'));
  });
});

// Guard against a leftover sibling artifact: the original test had a
// dead VAULT_DIR/VAULT_FILE constant pair that misled readers into
// thinking the test was already isolated. Keep the import surface
// touched so `os` doesn't go unused if future maintainers extend it.
void os.tmpdir;
