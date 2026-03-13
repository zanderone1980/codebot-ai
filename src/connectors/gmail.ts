/**
 * Gmail Connector — Send, read, search, and draft emails via Gmail API.
 *
 * Auth: Gmail App Password (GMAIL_APP_PASSWORD) + GMAIL_ADDRESS env vars.
 * Uses SMTP for sending, IMAP-style REST calls for reading.
 * Falls back to nodemailer-free raw SMTP via net sockets.
 *
 * For simplicity, this uses the Gmail API with an app password or OAuth token.
 * Set GMAIL_ADDRESS and GMAIL_APP_PASSWORD (or a Gmail API OAuth token).
 */

import { Connector, ConnectorAction } from './base';

const TIMEOUT = 20_000;
const MAX_RESPONSE = 10_000;
const GMAIL_API = 'https://gmail.googleapis.com/gmail/v1/users/me';

function truncate(text: string): string {
  return text.length <= MAX_RESPONSE ? text : text.substring(0, MAX_RESPONSE) + '\n... (truncated)';
}

function parseCredential(cred: string): { email: string; token: string } {
  // Credential can be JSON { email, token } or just a token (with GMAIL_ADDRESS env)
  try {
    const parsed = JSON.parse(cred);
    return { email: parsed.email || parsed.GMAIL_ADDRESS || '', token: parsed.token || parsed.GMAIL_APP_PASSWORD || '' };
  } catch {
    return { email: process.env.GMAIL_ADDRESS || '', token: cred };
  }
}

async function gmailFetch(
  endpoint: string,
  token: string,
  method = 'GET',
  body?: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);

  try {
    const headers: Record<string, string> = {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    };

    const res = await fetch(`${GMAIL_API}${endpoint}`, {
      method,
      headers,
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    clearTimeout(timer);
    const data = await res.json() as Record<string, unknown>;
    return { status: res.status, data };
  } catch (err: unknown) {
    clearTimeout(timer);
    throw err;
  }
}

function base64Encode(str: string): string {
  return Buffer.from(str).toString('base64url');
}

function base64Decode(str: string): string {
  return Buffer.from(str, 'base64').toString('utf-8');
}

export class GmailConnector implements Connector {
  name = 'gmail';
  displayName = 'Gmail';
  description = 'Send, read, search, and draft emails via Gmail. Requires a Gmail API OAuth token or App Password.';
  authType: Connector['authType'] = 'api_key';
  envKey = 'GMAIL_APP_PASSWORD';
  requiredEnvKeys = ['GMAIL_ADDRESS', 'GMAIL_APP_PASSWORD'];

  actions: ConnectorAction[] = [
    {
      name: 'list_emails',
      description: 'List recent emails from your inbox',
      parameters: {
        type: 'object',
        properties: {
          count: { type: 'number', description: 'Number of emails to list (default 10, max 50)' },
          label: { type: 'string', description: 'Label to filter by (default INBOX). Options: INBOX, SENT, DRAFT, STARRED, UNREAD' },
        },
      },
      execute: async (args, cred) => {
        const { token } = parseCredential(cred);
        const count = Math.min((args.count as number) || 10, 50);
        const label = (args.label as string) || 'INBOX';

        try {
          const { status, data } = await gmailFetch(
            `/messages?maxResults=${count}&labelIds=${encodeURIComponent(label)}`,
            token,
          );
          if (status !== 200) return `Error: Gmail API ${status}: ${JSON.stringify(data).substring(0, 200)}`;

          const messages = (data.messages as Array<{ id: string }>) || [];
          if (!messages.length) return `No emails found in ${label}.`;

          // Fetch headers for each message
          const results: string[] = [];
          for (const msg of messages.slice(0, count)) {
            try {
              const { data: detail } = await gmailFetch(`/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, token);
              const headers = (detail.payload as { headers: Array<{ name: string; value: string }> })?.headers || [];
              const from = headers.find(h => h.name === 'From')?.value || '?';
              const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
              const date = headers.find(h => h.name === 'Date')?.value || '';
              const snippet = (detail.snippet as string) || '';
              results.push(`  [${msg.id.substring(0, 8)}] ${from}\n    Subject: ${subject}\n    Date: ${date}\n    ${snippet.substring(0, 80)}`);
            } catch { results.push(`  [${msg.id.substring(0, 8)}] (failed to load)`); }
          }

          return truncate(`Emails in ${label} (${messages.length} total):\n\n${results.join('\n\n')}`);
        } catch (err: unknown) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'read_email',
      description: 'Read the full content of a specific email by its ID',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'string', description: 'Email message ID' },
        },
        required: ['id'],
      },
      execute: async (args, cred) => {
        const { token } = parseCredential(cred);
        const id = args.id as string;
        if (!id) return 'Error: id is required';

        try {
          const { status, data } = await gmailFetch(`/messages/${id}?format=full`, token);
          if (status !== 200) return `Error: Gmail API ${status}: ${JSON.stringify(data).substring(0, 200)}`;

          const headers = (data.payload as { headers: Array<{ name: string; value: string }> })?.headers || [];
          const from = headers.find(h => h.name === 'From')?.value || '?';
          const to = headers.find(h => h.name === 'To')?.value || '?';
          const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
          const date = headers.find(h => h.name === 'Date')?.value || '';

          // Extract body text
          let body = '';
          const payload = data.payload as Record<string, unknown>;
          if (payload?.body && (payload.body as Record<string, unknown>).data) {
            body = base64Decode((payload.body as Record<string, string>).data);
          } else if (payload?.parts) {
            const parts = payload.parts as Array<{ mimeType: string; body: { data: string } }>;
            const textPart = parts.find(p => p.mimeType === 'text/plain') || parts[0];
            if (textPart?.body?.data) {
              body = base64Decode(textPart.body.data);
            }
          }

          return truncate(`From: ${from}\nTo: ${to}\nSubject: ${subject}\nDate: ${date}\n\n${body || '(no body)'}`);
        } catch (err: unknown) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'send_email',
      description: 'Send an email via Gmail',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient email address' },
          subject: { type: 'string', description: 'Email subject' },
          body: { type: 'string', description: 'Email body (plain text)' },
          cc: { type: 'string', description: 'CC recipients (comma-separated)' },
        },
        required: ['to', 'subject', 'body'],
      },
      execute: async (args, cred) => {
        const { email, token } = parseCredential(cred);
        const to = args.to as string;
        const subject = args.subject as string;
        const body = args.body as string;
        if (!to || !subject || !body) return 'Error: to, subject, and body are required';

        try {
          // Build RFC 2822 email
          let rawEmail = `From: ${email}\r\nTo: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n`;
          if (args.cc) rawEmail += `Cc: ${args.cc}\r\n`;
          rawEmail += `\r\n${body}`;

          const encodedMessage = base64Encode(rawEmail);

          const { status, data } = await gmailFetch('/messages/send', token, 'POST', {
            raw: encodedMessage,
          });

          if (status === 200 || status === 201) {
            return `Email sent to ${to}. Subject: "${subject}". Message ID: ${(data.id as string) || 'unknown'}`;
          }
          return `Error: Gmail API ${status}: ${JSON.stringify(data).substring(0, 200)}`;
        } catch (err: unknown) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'search_emails',
      description: 'Search emails using Gmail search syntax',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: 'Gmail search query (e.g., "from:user@example.com subject:invoice")' },
          count: { type: 'number', description: 'Max results (default 10, max 50)' },
        },
        required: ['query'],
      },
      execute: async (args, cred) => {
        const { token } = parseCredential(cred);
        const query = args.query as string;
        const count = Math.min((args.count as number) || 10, 50);
        if (!query) return 'Error: query is required';

        try {
          const { status, data } = await gmailFetch(
            `/messages?q=${encodeURIComponent(query)}&maxResults=${count}`,
            token,
          );
          if (status !== 200) return `Error: Gmail API ${status}: ${JSON.stringify(data).substring(0, 200)}`;

          const messages = (data.messages as Array<{ id: string }>) || [];
          if (!messages.length) return `No emails found for query: "${query}"`;

          const results: string[] = [];
          for (const msg of messages.slice(0, count)) {
            try {
              const { data: detail } = await gmailFetch(`/messages/${msg.id}?format=metadata&metadataHeaders=From&metadataHeaders=Subject&metadataHeaders=Date`, token);
              const headers = (detail.payload as { headers: Array<{ name: string; value: string }> })?.headers || [];
              const from = headers.find(h => h.name === 'From')?.value || '?';
              const subject = headers.find(h => h.name === 'Subject')?.value || '(no subject)';
              results.push(`  [${msg.id.substring(0, 8)}] ${from} — ${subject}`);
            } catch { results.push(`  [${msg.id.substring(0, 8)}] (failed to load)`); }
          }

          return truncate(`Search results for "${query}" (${messages.length} matches):\n\n${results.join('\n')}`);
        } catch (err: unknown) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'create_draft',
      description: 'Create an email draft (does not send)',
      parameters: {
        type: 'object',
        properties: {
          to: { type: 'string', description: 'Recipient email address' },
          subject: { type: 'string', description: 'Email subject' },
          body: { type: 'string', description: 'Email body (plain text)' },
        },
        required: ['to', 'subject', 'body'],
      },
      execute: async (args, cred) => {
        const { email, token } = parseCredential(cred);
        const to = args.to as string;
        const subject = args.subject as string;
        const body = args.body as string;
        if (!to || !subject || !body) return 'Error: to, subject, and body are required';

        try {
          const rawEmail = `From: ${email}\r\nTo: ${to}\r\nSubject: ${subject}\r\nContent-Type: text/plain; charset=utf-8\r\n\r\n${body}`;
          const encodedMessage = base64Encode(rawEmail);

          const { status, data } = await gmailFetch('/drafts', token, 'POST', {
            message: { raw: encodedMessage },
          });

          if (status === 200 || status === 201) {
            return `Draft created. To: ${to}, Subject: "${subject}". Draft ID: ${(data.id as string) || 'unknown'}`;
          }
          return `Error: Gmail API ${status}: ${JSON.stringify(data).substring(0, 200)}`;
        } catch (err: unknown) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
  ];

  async validate(credential: string): Promise<boolean> {
    const { token } = parseCredential(credential);
    if (!token) return false;
    try {
      const { status } = await gmailFetch('/profile', token);
      return status === 200;
    } catch {
      return false;
    }
  }
}
