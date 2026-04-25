import { Tool, CapabilityLabel } from '../types';

export class NotificationTool implements Tool {
  name = 'notification';
  description = 'Send notifications via webhook (Slack, Discord, or generic). Actions: slack, discord, webhook.';
  permission: Tool['permission'] = 'prompt';
  capabilities: CapabilityLabel[] = ['net-fetch', 'send-on-behalf'];
  parameters = {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Action: slack, discord, webhook' },
      url: { type: 'string', description: 'Webhook URL' },
      message: { type: 'string', description: 'Message text' },
      title: { type: 'string', description: 'Optional title/subject' },
      severity: { type: 'string', description: 'Severity: info, warning, error, success (affects color)' },
    },
    required: ['action', 'url', 'message'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = args.action as string;
    const url = args.url as string;
    const message = args.message as string;

    if (!action) return 'Error: action is required';
    if (!url) return 'Error: url is required';
    if (!message) return 'Error: message is required';

    // Validate URL
    try { new URL(url); } catch { return `Error: invalid URL: ${url}`; }

    const title = (args.title as string) || '';
    const severity = (args.severity as string) || 'info';

    switch (action) {
      case 'slack': return this.sendSlack(url, message, title, severity);
      case 'discord': return this.sendDiscord(url, message, title, severity);
      case 'webhook': return this.sendGeneric(url, message, title, severity);
      default: return `Error: unknown action "${action}". Use: slack, discord, webhook`;
    }
  }

  private async sendSlack(url: string, message: string, title: string, severity: string): Promise<string> {
    const colors: Record<string, string> = { info: '#2196F3', warning: '#FF9800', error: '#F44336', success: '#4CAF50' };
    const payload = {
      attachments: [{
        color: colors[severity] || colors.info,
        title: title || undefined,
        text: message,
        ts: Math.floor(Date.now() / 1000),
      }],
    };
    return this.post(url, payload);
  }

  private async sendDiscord(url: string, message: string, title: string, severity: string): Promise<string> {
    const colors: Record<string, number> = { info: 0x2196F3, warning: 0xFF9800, error: 0xF44336, success: 0x4CAF50 };
    const payload = {
      embeds: [{
        title: title || undefined,
        description: message,
        color: colors[severity] || colors.info,
        timestamp: new Date().toISOString(),
      }],
    };
    return this.post(url, payload);
  }

  private async sendGeneric(url: string, message: string, title: string, severity: string): Promise<string> {
    const payload = { title, message, severity, timestamp: new Date().toISOString() };
    return this.post(url, payload);
  }

  private async post(url: string, payload: Record<string, unknown>): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 15_000);

    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (res.ok) return `Notification sent (${res.status}).`;
      const body = await res.text().catch(() => '');
      return `Error: webhook returned ${res.status} ${res.statusText}${body ? `: ${body.substring(0, 200)}` : ''}`;
    } catch (err: unknown) {
      clearTimeout(timer);
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
