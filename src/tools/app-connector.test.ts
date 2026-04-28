import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import { AppConnectorTool } from './app-connector';
import { ConnectorRegistry } from '../connectors/registry';
import { VaultManager } from '../vault';
import { Connector, ConnectorAction } from '../connectors/base';
import { makeTestVaultPath } from '../test-vault-isolation';

/** Minimal mock connector */
function mockConnector(name: string, envKey?: string): Connector {
  const actions: ConnectorAction[] = [
    {
      name: 'test_action',
      description: 'A test action',
      parameters: { type: 'object', properties: { msg: { type: 'string' } } },
      execute: async (args) => `Executed ${name}.test_action: ${args.msg || 'ok'}`,
    },
  ];
  return {
    name,
    displayName: name.charAt(0).toUpperCase() + name.slice(1),
    description: `Mock ${name}`,
    authType: 'api_key',
    envKey,
    actions,
    validate: async (cred) => cred === 'valid-token',
  };
}

describe('AppConnectorTool', () => {
  before(() => {
    process.env.CODEBOT_VAULT_KEY = 'test-key-app';
  });

  after(() => {
    delete process.env.CODEBOT_VAULT_KEY;
  });

  it('has correct tool metadata', () => {
    const vault = new VaultManager({ vaultPath: makeTestVaultPath() });
    const registry = new ConnectorRegistry(vault);
    const tool = new AppConnectorTool(vault, registry);
    assert.strictEqual(tool.name, 'app');
    assert.strictEqual(tool.permission, 'prompt');
    assert.ok(tool.description.includes('GitHub'));
  });

  it('list action returns all connectors', async () => {
    const vault = new VaultManager({ vaultPath: makeTestVaultPath() });
    const registry = new ConnectorRegistry(vault);
    registry.register(mockConnector('mock1'));
    registry.register(mockConnector('mock2'));
    const tool = new AppConnectorTool(vault, registry);
    const result = await tool.execute({ action: 'list' });
    assert.ok(result.includes('Mock1'));
    assert.ok(result.includes('Mock2'));
    assert.ok(result.includes('test_action'));
  });

  it('connect saves to vault on valid token', async () => {
    const vault = new VaultManager({ vaultPath: makeTestVaultPath() });
    const registry = new ConnectorRegistry(vault);
    registry.register(mockConnector('testapp'));
    const tool = new AppConnectorTool(vault, registry);
    const result = await tool.execute({ action: 'connect', app: 'testapp', credential: 'valid-token' });
    assert.ok(result.includes('connected successfully'));
    assert.ok(vault.has('testapp'));
  });

  it('connect rejects invalid token', async () => {
    const vault = new VaultManager({ vaultPath: makeTestVaultPath() });
    const registry = new ConnectorRegistry(vault);
    registry.register(mockConnector('badapp'));
    const tool = new AppConnectorTool(vault, registry);
    const result = await tool.execute({ action: 'connect', app: 'badapp', credential: 'bad-token' });
    assert.ok(result.includes('Error:'));
    assert.ok(!vault.has('badapp'));
  });

  it('dispatches connector action via dot notation', async () => {
    const vault = new VaultManager({ vaultPath: makeTestVaultPath() });
    const registry = new ConnectorRegistry(vault);
    process.env.DISPATCH_TOKEN = 'valid-token';
    registry.register(mockConnector('dispatch', 'DISPATCH_TOKEN'));
    const tool = new AppConnectorTool(vault, registry);
    const result = await tool.execute({ action: 'dispatch.test_action', msg: 'hello' });
    assert.ok(result.includes('Executed dispatch.test_action: hello'));
    delete process.env.DISPATCH_TOKEN;
  });

  it('returns error for unknown connector', async () => {
    const vault = new VaultManager({ vaultPath: makeTestVaultPath() });
    const registry = new ConnectorRegistry(vault);
    const tool = new AppConnectorTool(vault, registry);
    const result = await tool.execute({ action: 'nonexistent.action' });
    assert.ok(result.includes('Error:'));
    assert.ok(result.includes('unknown app'));
  });

  // ── PR 11: per-action capability resolution ─────────────────────
  // The app tool's static `capabilities` field is the union over every
  // possible action — that over-gates pure reads. effectiveCapabilities
  // narrows to the action being invoked so the agent gate scores the
  // real call rather than the worst case.
  describe('effectiveCapabilities (PR 11)', () => {
    function readOnlyConnector(name: string): Connector {
      const action: ConnectorAction = {
        name: 'list_things',
        description: 'List things',
        parameters: { type: 'object', properties: {} },
        capabilities: ['read-only', 'account-access', 'net-fetch'],
        execute: async () => 'ok',
      };
      const writeAction: ConnectorAction = {
        name: 'send_thing',
        description: 'Send a thing',
        parameters: { type: 'object', properties: {} },
        capabilities: ['account-access', 'net-fetch', 'send-on-behalf'],
        execute: async () => 'ok',
      };
      return {
        name,
        displayName: name,
        description: `Mock ${name}`,
        authType: 'api_key',
        actions: [action, writeAction],
        validate: async () => true,
      };
    }

    it('returns the read action labels for a read action', () => {
      const vault = new VaultManager({ vaultPath: makeTestVaultPath() });
      const registry = new ConnectorRegistry(vault);
      registry.register(readOnlyConnector('myapp'));
      const tool = new AppConnectorTool(vault, registry);
      const labels = tool.effectiveCapabilities({ action: 'myapp.list_things' });
      assert.deepStrictEqual(
        (labels || []).slice().sort(),
        ['account-access', 'net-fetch', 'read-only'],
      );
      assert.ok(!(labels || []).includes('send-on-behalf'),
        'read action must NOT carry send-on-behalf from the tool union');
    });

    it('returns the write action labels for a write action', () => {
      const vault = new VaultManager({ vaultPath: makeTestVaultPath() });
      const registry = new ConnectorRegistry(vault);
      registry.register(readOnlyConnector('myapp'));
      const tool = new AppConnectorTool(vault, registry);
      const labels = tool.effectiveCapabilities({ action: 'myapp.send_thing' });
      assert.ok((labels || []).includes('send-on-behalf'),
        'write action must carry its real send-on-behalf label');
    });

    it('returns [] for the meta action "list" (purely local)', () => {
      const vault = new VaultManager({ vaultPath: makeTestVaultPath() });
      const registry = new ConnectorRegistry(vault);
      const tool = new AppConnectorTool(vault, registry);
      const labels = tool.effectiveCapabilities({ action: 'list' });
      assert.deepStrictEqual(labels, []);
    });

    it('returns [write-fs] for "connect" / "disconnect"', () => {
      const vault = new VaultManager({ vaultPath: makeTestVaultPath() });
      const registry = new ConnectorRegistry(vault);
      const tool = new AppConnectorTool(vault, registry);
      assert.deepStrictEqual(
        tool.effectiveCapabilities({ action: 'connect' }),
        ['write-fs'],
      );
      assert.deepStrictEqual(
        tool.effectiveCapabilities({ action: 'disconnect' }),
        ['write-fs'],
      );
    });

    it('returns undefined for unknown app — caller falls back to tool union', () => {
      const vault = new VaultManager({ vaultPath: makeTestVaultPath() });
      const registry = new ConnectorRegistry(vault);
      const tool = new AppConnectorTool(vault, registry);
      const labels = tool.effectiveCapabilities({ action: 'nope.whatever' });
      assert.strictEqual(labels, undefined);
    });

    it('returns undefined for unknown action on a known connector', () => {
      const vault = new VaultManager({ vaultPath: makeTestVaultPath() });
      const registry = new ConnectorRegistry(vault);
      registry.register(readOnlyConnector('myapp'));
      const tool = new AppConnectorTool(vault, registry);
      const labels = tool.effectiveCapabilities({ action: 'myapp.nope' });
      assert.strictEqual(labels, undefined);
    });
  });
});
