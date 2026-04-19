import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { ToolRegistry } from './index';

/**
 * Tool-gating tests for Vault Mode. These lock in the READ-ONLY +
 * OFFLINE-BY-DEFAULT contract: the promise "CodeBot in Vault Mode
 * cannot make network calls or write files unless you explicitly
 * opt in" is only true if the tools literally aren't in the registry.
 *
 * Breaking any of these means the Vault Mode privacy/read-only claim
 * is broken — the agent could still invoke the tool.
 */
describe('ToolRegistry — Vault Mode gating', () => {
  it('default (no vault mode): all tools registered', () => {
    const r = new ToolRegistry();
    const names = r.all().map(t => t.name);
    assert.ok(names.includes('read_file'));
    assert.ok(names.includes('write_file'));
    assert.ok(names.includes('edit_file'));
    assert.ok(names.includes('execute'));
    assert.ok(names.includes('web_fetch'));
    assert.ok(names.includes('http_client'));
    assert.ok(names.includes('grep'));
    // Baseline: ~36 tools registered total
    assert.ok(names.length > 20, `expected >20 tools, got ${names.length}`);
  });

  it('vault mode default: core read tools only, no write, no network, no shell', () => {
    const r = new ToolRegistry(undefined, undefined, {
      vaultMode: { vaultPath: '/tmp/vault', writable: false, networkAllowed: false },
    });
    const names = new Set(r.all().map(t => t.name));

    // Allowed — core read/search
    for (const allowed of ['read_file', 'glob', 'grep', 'find_symbol', 'think', 'memory']) {
      assert.ok(names.has(allowed), `expected ${allowed} registered in vault mode`);
    }

    // Disallowed — write
    for (const blocked of ['write_file', 'edit_file', 'batch_edit']) {
      assert.ok(!names.has(blocked), `${blocked} must NOT be in vault mode (read-only default)`);
    }

    // Disallowed — network
    for (const blocked of ['web_fetch', 'web_search', 'http_client', 'browser', 'deep_research']) {
      assert.ok(!names.has(blocked), `${blocked} must NOT be in vault mode (network off default)`);
    }

    // Disallowed — shell / infra
    for (const blocked of ['execute', 'docker', 'ssh_remote', 'git', 'test_runner', 'package_manager']) {
      assert.ok(!names.has(blocked), `${blocked} must NOT be in vault mode`);
    }
  });

  it('vault + writable: write tools re-enabled, network still blocked', () => {
    const r = new ToolRegistry(undefined, undefined, {
      vaultMode: { vaultPath: '/tmp/vault', writable: true, networkAllowed: false },
    });
    const names = new Set(r.all().map(t => t.name));
    assert.ok(names.has('write_file'));
    assert.ok(names.has('edit_file'));
    assert.ok(names.has('batch_edit'));
    // Network still off
    assert.ok(!names.has('web_fetch'));
    assert.ok(!names.has('http_client'));
  });

  it('vault + network: network tools re-enabled, write still blocked', () => {
    const r = new ToolRegistry(undefined, undefined, {
      vaultMode: { vaultPath: '/tmp/vault', writable: false, networkAllowed: true },
    });
    const names = new Set(r.all().map(t => t.name));
    assert.ok(names.has('web_fetch'));
    assert.ok(names.has('http_client'));
    assert.ok(names.has('web_search'));
    // Write still off
    assert.ok(!names.has('write_file'));
    assert.ok(!names.has('edit_file'));
  });

  it('vault + writable + network: both re-enabled; shell still blocked', () => {
    const r = new ToolRegistry(undefined, undefined, {
      vaultMode: { vaultPath: '/tmp/vault', writable: true, networkAllowed: true },
    });
    const names = new Set(r.all().map(t => t.name));
    assert.ok(names.has('write_file'));
    assert.ok(names.has('web_fetch'));
    // Shell/infra still blocked — vault mode is never a shell environment
    assert.ok(!names.has('execute'));
    assert.ok(!names.has('docker'));
    assert.ok(!names.has('ssh_remote'));
  });

  it('vault mode tool count is small (bounded surface area)', () => {
    const r = new ToolRegistry(undefined, undefined, {
      vaultMode: { vaultPath: '/tmp/vault', writable: false, networkAllowed: false },
    });
    const count = r.all().length;
    // We want a tight surface: 6-12 tools max in default vault mode.
    // Most LLM free tiers can't handle the full 36-tool schema anyway.
    assert.ok(count >= 5 && count <= 15, `vault mode should expose 5-15 tools, got ${count}`);
  });
});
