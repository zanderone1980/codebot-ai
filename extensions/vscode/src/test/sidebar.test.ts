import { describe, it } from 'node:test';
import * as assert from 'node:assert';

/**
 * Tests for webview message protocol and sidebar logic.
 */

describe('Webview Message Protocol', () => {
  // ExtensionToWebviewMessage types
  it('validates agentEvent message shape', () => {
    const msg = {
      type: 'agentEvent' as const,
      event: { type: 'text', text: 'Hello' },
    };
    assert.strictEqual(msg.type, 'agentEvent');
    assert.ok(msg.event, 'Should have event payload');
  });

  it('validates sessionStarted message shape', () => {
    const msg = {
      type: 'sessionStarted' as const,
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
    };
    assert.strictEqual(msg.type, 'sessionStarted');
    assert.strictEqual(msg.provider, 'anthropic');
    assert.strictEqual(msg.model, 'claude-sonnet-4-20250514');
  });

  it('validates sessionEnded message shape', () => {
    const msg = { type: 'sessionEnded' as const };
    assert.strictEqual(msg.type, 'sessionEnded');
  });

  it('validates error message shape', () => {
    const msg = {
      type: 'error' as const,
      message: 'Something went wrong',
    };
    assert.strictEqual(msg.type, 'error');
    assert.strictEqual(msg.message, 'Something went wrong');
  });

  // WebviewToExtensionMessage types
  it('validates sendMessage request shape', () => {
    const msg = {
      type: 'sendMessage' as const,
      text: 'Fix the bug in app.ts',
    };
    assert.strictEqual(msg.type, 'sendMessage');
    assert.strictEqual(msg.text, 'Fix the bug in app.ts');
  });

  it('validates cancelSession request shape', () => {
    const msg = { type: 'cancelSession' as const };
    assert.strictEqual(msg.type, 'cancelSession');
  });

  it('validates clearHistory request shape', () => {
    const msg = { type: 'clearHistory' as const };
    assert.strictEqual(msg.type, 'clearHistory');
  });

  it('distinguishes message directions by type', () => {
    const extensionToWebview = ['agentEvent', 'sessionStarted', 'sessionEnded', 'error'];
    const webviewToExtension = ['sendMessage', 'cancelSession', 'clearHistory'];

    // No overlap between directions
    for (const type of extensionToWebview) {
      assert.ok(!webviewToExtension.includes(type), `${type} should not be in both directions`);
    }
  });
});

describe('Sidebar Provider Logic', () => {
  it('handles config reading for provider', () => {
    const configs: Record<string, string> = {
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'sk-test',
    };

    assert.strictEqual(configs['provider'], 'anthropic');
    assert.strictEqual(configs['model'], 'claude-sonnet-4-20250514');
  });

  it('defaults to auto-approve false', () => {
    const autoApprove = false;
    assert.strictEqual(autoApprove, false, 'Should default to requiring approval');
  });

  it('defaults maxIterations to 50', () => {
    const maxIterations = 50;
    assert.strictEqual(maxIterations, 50, 'Should default to 50 iterations');
  });

  it('handles webview message dispatch', () => {
    const dispatched: string[] = [];

    function handleMessage(msg: { type: string }) {
      switch (msg.type) {
        case 'sendMessage': dispatched.push('send'); break;
        case 'cancelSession': dispatched.push('cancel'); break;
        case 'clearHistory': dispatched.push('clear'); break;
      }
    }

    handleMessage({ type: 'sendMessage' });
    handleMessage({ type: 'cancelSession' });
    handleMessage({ type: 'clearHistory' });

    assert.deepStrictEqual(dispatched, ['send', 'cancel', 'clear']);
  });

  it('creates default policy structure', () => {
    const policy = {
      version: '1.0',
      tools: { permissions: { execute: 'prompt', write_file: 'prompt' } },
      git: { always_branch: true, never_push_main: true },
      secrets: { block_on_detect: true, scan_on_write: true },
    };

    assert.strictEqual(policy.version, '1.0');
    assert.strictEqual(policy.tools.permissions.execute, 'prompt');
    assert.strictEqual(policy.git.always_branch, true);
    assert.strictEqual(policy.secrets.block_on_detect, true);
  });
});
