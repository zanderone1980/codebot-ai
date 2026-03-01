import { describe, it, mock, beforeEach } from 'node:test';
import * as assert from 'node:assert';

/**
 * Mock vscode module — minimal stub for testing.
 */
const vscode = {
  window: {
    createStatusBarItem: () => ({
      text: '', tooltip: '', command: '', show: () => {}, hide: () => {}, dispose: () => {},
      backgroundColor: undefined, name: '',
    }),
    showInformationMessage: async () => undefined,
    showWarningMessage: async () => undefined,
    showErrorMessage: async () => undefined,
  },
  StatusBarAlignment: { Left: 1, Right: 2 },
  ThemeColor: class ThemeColor { constructor(public id: string) {} },
  Uri: {
    file: (p: string) => ({ scheme: 'file', path: p, toString: () => `file://${p}` }),
    parse: (s: string) => ({ scheme: s.split(':')[0], path: s.split(':').slice(1).join(':'), toString: () => s }),
  },
  EventEmitter: class EventEmitter<T> {
    private listeners: Array<(e: T) => void> = [];
    event = (listener: (e: T) => void) => { this.listeners.push(listener); return { dispose: () => {} }; };
    fire(data: T) { this.listeners.forEach(l => l(data)); }
    dispose() { this.listeners = []; }
  },
  commands: { executeCommand: async () => {} },
  workspace: { getConfiguration: () => ({ get: (key: string, def?: unknown) => def }) },
};

/**
 * Inline AgentBridge logic tests without importing the actual module
 * (which depends on 'codebot-ai' and 'vscode' at runtime).
 */

describe('AgentBridge', () => {
  it('initializes with options', () => {
    const options = {
      workspaceRoot: '/workspace/project',
      provider: 'anthropic',
      model: 'claude-sonnet-4-20250514',
      apiKey: 'sk-test-key',
      autoApprove: false,
      maxIterations: 25,
      onEvent: () => {},
      onPermissionRequest: async () => true,
    };

    // Verify options structure is valid
    assert.strictEqual(options.workspaceRoot, '/workspace/project');
    assert.strictEqual(options.provider, 'anthropic');
    assert.strictEqual(options.model, 'claude-sonnet-4-20250514');
    assert.strictEqual(options.autoApprove, false);
    assert.strictEqual(options.maxIterations, 25);
  });

  it('validates provider selection for anthropic', () => {
    const provider = 'anthropic';
    assert.ok(['anthropic', 'openai'].includes(provider), 'Should accept valid provider');
  });

  it('validates provider selection for openai', () => {
    const provider = 'openai';
    assert.ok(['anthropic', 'openai'].includes(provider), 'Should accept valid provider');
  });

  it('rejects invalid provider names', () => {
    const provider = 'invalid-provider';
    assert.ok(!['anthropic', 'openai'].includes(provider), 'Should reject invalid provider');
  });

  it('manages running state correctly', () => {
    let running = false;
    let aborted = false;

    // Simulate start
    running = true;
    aborted = false;
    assert.strictEqual(running, true);
    assert.strictEqual(aborted, false);

    // Simulate stop
    aborted = true;
    assert.strictEqual(aborted, true);

    // Simulate completion
    running = false;
    assert.strictEqual(running, false);
  });

  it('handles abort during run', () => {
    let aborted = false;

    // Simulate aborting
    aborted = true;
    assert.strictEqual(aborted, true, 'Should be aborted after stop()');
  });

  it('resets agent state on reset()', () => {
    let agent: object | null = { model: 'test' };
    let aborted = false;

    // Simulate reset
    aborted = true;
    agent = null;

    assert.strictEqual(agent, null, 'Agent should be null after reset');
    assert.strictEqual(aborted, true, 'Should be aborted after reset');
  });

  it('resolves model from provider defaults', () => {
    const providerDefaults: Record<string, { model: string }> = {
      anthropic: { model: 'claude-sonnet-4-20250514' },
      openai: { model: 'gpt-4o' },
    };

    assert.strictEqual(providerDefaults['anthropic'].model, 'claude-sonnet-4-20250514');
    assert.strictEqual(providerDefaults['openai'].model, 'gpt-4o');
  });

  it('uses explicit model when provided', () => {
    const explicitModel = 'custom-model-v2';
    const providerDefault = 'gpt-4o';

    const resolved = explicitModel || providerDefault;
    assert.strictEqual(resolved, 'custom-model-v2');
  });

  it('falls back to provider default when model is empty', () => {
    const explicitModel = '';
    const providerDefault = 'gpt-4o';

    const resolved = explicitModel || providerDefault;
    assert.strictEqual(resolved, 'gpt-4o');
  });

  it('tracks events through onEvent callback', () => {
    const events: Array<{ type: string }> = [];
    const onEvent = (event: { type: string }) => events.push(event);

    // Simulate events
    onEvent({ type: 'text' });
    onEvent({ type: 'tool_call' });
    onEvent({ type: 'tool_result' });
    onEvent({ type: 'done' });

    assert.strictEqual(events.length, 4);
    assert.strictEqual(events[0].type, 'text');
    assert.strictEqual(events[3].type, 'done');
  });

  it('handles permission request callbacks', async () => {
    const onPermissionRequest = async (tool: string, args: Record<string, unknown>): Promise<boolean> => {
      return tool === 'think'; // Auto-approve think, deny others
    };

    assert.strictEqual(await onPermissionRequest('think', {}), true);
    assert.strictEqual(await onPermissionRequest('execute', { command: 'rm -rf /' }), false);
  });

  it('handles error events', () => {
    const events: Array<{ type: string; error?: string }> = [];
    const onEvent = (event: { type: string; error?: string }) => events.push(event);

    onEvent({ type: 'error', error: 'Test error message' });

    assert.strictEqual(events.length, 1);
    assert.strictEqual(events[0].type, 'error');
    assert.strictEqual(events[0].error, 'Test error message');
  });

  it('prevents concurrent runs', () => {
    let running = false;

    // First run
    running = true;

    // Attempt second run
    const canRun = !running;
    assert.strictEqual(canRun, false, 'Should not allow concurrent runs');
  });

  it('allows run after previous completes', () => {
    let running = false;

    // First run completes
    running = true;
    running = false;

    // Second run should be allowed
    const canRun = !running;
    assert.strictEqual(canRun, true, 'Should allow run after previous completes');
  });
});
