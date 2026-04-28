import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import { ConnectorRegistry } from './registry';
import { Connector, ConnectorAction } from './base';
import { VaultManager } from '../vault';
import { makeTestVaultPath } from '../test-vault-isolation';

/** Minimal mock connector for testing */
function mockConnector(name: string, envKey?: string, requiredEnvKeys?: string[]): Connector {
  const actions: ConnectorAction[] = [
    {
      name: 'test_action',
      description: 'A test action',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'test result',
    },
  ];
  return {
    name,
    displayName: name.charAt(0).toUpperCase() + name.slice(1),
    description: `Mock ${name} connector`,
    authType: 'api_key',
    envKey,
    requiredEnvKeys,
    actions,
    validate: async () => true,
  };
}

describe('ConnectorRegistry', () => {
  before(() => {
    process.env.CODEBOT_VAULT_KEY = 'test-key-registry';
  });

  after(() => {
    delete process.env.CODEBOT_VAULT_KEY;
  });

  it('registers and retrieves connectors', () => {
    const vault = new VaultManager({ vaultPath: makeTestVaultPath() });
    const registry = new ConnectorRegistry(vault);
    const connector = mockConnector('test', 'TEST_TOKEN');
    registry.register(connector);
    assert.ok(registry.get('test'));
    assert.strictEqual(registry.get('test')!.name, 'test');
  });

  it('all returns all registered connectors', () => {
    const vault = new VaultManager({ vaultPath: makeTestVaultPath() });
    const registry = new ConnectorRegistry(vault);
    registry.register(mockConnector('a'));
    registry.register(mockConnector('b'));
    registry.register(mockConnector('c'));
    assert.strictEqual(registry.all().length, 3);
  });

  it('isConnected detects env var credentials', () => {
    const vault = new VaultManager({ vaultPath: makeTestVaultPath() });
    const registry = new ConnectorRegistry(vault);
    process.env.MOCK_TOKEN = 'test-token';
    registry.register(mockConnector('envtest', 'MOCK_TOKEN'));
    assert.ok(registry.isConnected('envtest'));
    delete process.env.MOCK_TOKEN;
  });

  it('getConnected filters to connected only', () => {
    const vault = new VaultManager({ vaultPath: makeTestVaultPath() });
    const registry = new ConnectorRegistry(vault);
    process.env.CONNECTED_TOKEN = 'yes';
    registry.register(mockConnector('connected', 'CONNECTED_TOKEN'));
    registry.register(mockConnector('disconnected', 'NO_SUCH_VAR'));
    const connected = registry.getConnected();
    assert.strictEqual(connected.length, 1);
    assert.strictEqual(connected[0].name, 'connected');
    delete process.env.CONNECTED_TOKEN;
  });

  it('getCredential prefers vault over env', () => {
    const vault = new VaultManager({ vaultPath: makeTestVaultPath() });
    const registry = new ConnectorRegistry(vault);
    process.env.PREF_TOKEN = 'env-value';
    vault.set('preftest', {
      type: 'api_key',
      value: 'vault-value',
      metadata: { provider: 'Test', created: new Date().toISOString() },
    });
    registry.register(mockConnector('preftest', 'PREF_TOKEN'));
    assert.strictEqual(registry.getCredential('preftest'), 'vault-value');
    delete process.env.PREF_TOKEN;
  });

  it('returns null credential for unregistered connector', () => {
    const vault = new VaultManager({ vaultPath: makeTestVaultPath() });
    const registry = new ConnectorRegistry(vault);
    assert.strictEqual(registry.getCredential('nonexistent'), null);
  });
});
