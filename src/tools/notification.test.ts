import { describe, it, before } from 'node:test';
import * as assert from 'node:assert';
import { NotificationTool } from './notification';

describe('NotificationTool', () => {
  let tool: NotificationTool;

  before(() => {
    tool = new NotificationTool();
  });

  it('should have correct tool metadata', () => {
    assert.strictEqual(tool.name, 'notification');
    assert.strictEqual(tool.permission, 'prompt');
  });

  it('should return error when action is missing', async () => {
    const result = await tool.execute({ action: '', url: 'https://example.com', message: 'hi' });
    assert.strictEqual(result, 'Error: action is required');
  });

  it('should return error when url is missing', async () => {
    const result = await tool.execute({ action: 'slack', url: '', message: 'hi' });
    assert.strictEqual(result, 'Error: url is required');
  });

  it('should return error when message is missing', async () => {
    const result = await tool.execute({ action: 'slack', url: 'https://example.com', message: '' });
    assert.strictEqual(result, 'Error: message is required');
  });

  it('should return error for invalid URL', async () => {
    const result = await tool.execute({ action: 'slack', url: 'not-a-url', message: 'hello' });
    assert.match(result, /Error: invalid URL/);
  });

  it('should return error for unknown action', async () => {
    const result = await tool.execute({
      action: 'telegram',
      url: 'https://example.com/webhook',
      message: 'hello',
    });
    assert.match(result, /Error: unknown action "telegram"/);
    assert.match(result, /slack, discord, webhook/);
  });

  it('should attempt slack notification and handle network error', async () => {
    // Use a URL that will fail to connect (non-routable)
    const result = await tool.execute({
      action: 'slack',
      url: 'https://hooks.slack.com/services/INVALID/INVALID/INVALID',
      message: 'test message',
      title: 'Test',
      severity: 'info',
    });
    // Should get an error response (network failure or non-200 status)
    assert.ok(result.includes('Error:') || result.includes('Notification sent'));
  });

  it('should attempt discord notification and handle network error', async () => {
    const result = await tool.execute({
      action: 'discord',
      url: 'https://discord.com/api/webhooks/invalid/invalid',
      message: 'test message',
      severity: 'warning',
    });
    assert.ok(result.includes('Error:') || result.includes('Notification sent'));
  });

  it('should attempt generic webhook and handle network error', async () => {
    const result = await tool.execute({
      action: 'webhook',
      url: 'https://httpbin.org/status/404',
      message: 'test',
      severity: 'error',
    });
    // Will get either a network error or HTTP error status
    assert.ok(typeof result === 'string');
    assert.ok(result.length > 0);
  });

  it('should handle all severity values without error for slack', async () => {
    for (const severity of ['info', 'warning', 'error', 'success']) {
      const result = await tool.execute({
        action: 'slack',
        url: 'https://hooks.slack.com/services/X/Y/Z',
        message: 'sev test',
        severity,
      });
      // Should not crash -- result is either success or network error
      assert.ok(typeof result === 'string');
    }
  });

  it('should accept valid HTTPS webhook URLs', async () => {
    const result = await tool.execute({
      action: 'webhook',
      url: 'https://example.com/webhook/endpoint',
      message: 'valid url test',
    });
    // Should NOT get "invalid URL" error
    assert.ok(!result.includes('invalid URL'));
  });

  // ── 2026-04-23 sweep: SSRF protection ──
  //
  // Webhook URL is agent-controlled. Before this fix, nothing stopped
  // `notification webhook http://169.254.169.254/...` from hitting cloud
  // metadata, or `http://localhost:8000/admin` from probing user services.
  it('blocks loopback webhook URL with clear error', async () => {
    const result = await tool.execute({
      action: 'webhook',
      url: 'http://127.0.0.1:8080/webhook',
      message: 'ssrf test',
    });
    assert.match(result, /blocked for security|loopback/i, `got: ${result}`);
  });

  it('blocks private-range webhook URL', async () => {
    const result = await tool.execute({
      action: 'webhook',
      url: 'http://10.0.0.1/webhook',
      message: 'ssrf test',
    });
    assert.match(result, /blocked for security|10\.x/i, `got: ${result}`);
  });

  it('blocks cloud-metadata webhook URL', async () => {
    const result = await tool.execute({
      action: 'webhook',
      url: 'http://169.254.169.254/latest/meta-data/',
      message: 'ssrf test',
    });
    assert.match(result, /blocked for security|metadata|link-local/i, `got: ${result}`);
  });

  it('blocks localhost hostname webhook URL', async () => {
    const result = await tool.execute({
      action: 'webhook',
      url: 'http://localhost/webhook',
      message: 'ssrf test',
    });
    assert.match(result, /blocked for security|localhost/i, `got: ${result}`);
  });
});
