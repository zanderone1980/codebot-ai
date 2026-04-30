/**
 * Google Drive Connector — list / search / read / get_file_info.
 *
 * Auth: Bearer OAuth token (Google Drive API v3). Env: GOOGLE_DRIVE_TOKEN.
 *
 * §8 Connector Contract (PR 18)
 * -----------------------------
 * Four actions, all migrated. NO mutating verbs in this connector — no
 * upload, no delete, no rename, no permission changes. Drive's write
 * surface is deliberately out of scope here; if and when we add it,
 * each verb gets its own preview / idempotency / redact declarations
 * the same way Gmail / Calendar / GitHub did.
 *
 *   list_files     — read   ['read-only', 'account-access', 'net-fetch']
 *   search_files   — read   ['read-only', 'account-access', 'net-fetch']
 *   read_file      — read   ['read-only', 'account-access', 'net-fetch']
 *   get_file_info  — read   ['read-only', 'account-access', 'net-fetch']
 *
 * Reauth detection (`isGoogleDriveAuthError`)
 * -------------------------------------------
 * Identical to `isGoogleCalendarAuthError` (PR 14) — same Google APIs,
 * same error envelope. Kept as a separate exported function (not a
 * shared `isGoogleApiAuthError`) so the audit reason field names the
 * connector that actually failed; consolidating later would only save
 * a few lines and lose precision in the audit log.
 *
 * `vaultKeyName: 'google_drive'` declared explicitly.
 */

import { Connector, ConnectorAction, ConnectorReauthError } from './base';

const TIMEOUT = 20_000;
const MAX_RESPONSE = 10_000;
const DRIVE_API = 'https://www.googleapis.com/drive/v3';

function truncate(text: string): string {
  return text.length <= MAX_RESPONSE ? text : text.substring(0, MAX_RESPONSE) + '\n... (truncated)';
}

// ─── Reauth classifier (pure, no network) ─────────────────────────────────

interface GoogleApiError {
  error?: {
    code?: number;
    status?: string;
    message?: string;
    errors?: Array<{ reason?: string; domain?: string; message?: string }>;
  };
}

const GOOGLE_AUTH_REASONS: ReadonlySet<string> = new Set([
  'authError',
  'invalidCredentials',
  'insufficientPermissions',
]);
const GOOGLE_NON_AUTH_403_REASONS: ReadonlySet<string> = new Set([
  'rateLimitExceeded',
  'userRateLimitExceeded',
  'quotaExceeded',
  'dailyLimitExceeded',
  'variableTermLimitExceeded',
  'requestThrottled',
]);

/**
 * Decide whether a Google Drive API response indicates a reauth-class
 * failure. Pure function — no I/O. Mirrors `isGoogleCalendarAuthError`:
 *   - 401 → always reauth
 *   - 403 with auth-class reason → reauth
 *   - 403 with rate/quota reason → NOT reauth (user retries, doesn't reconnect)
 *   - mixed auth + non-auth → conservatively NOT reauth
 *   - 403 with no recognizable reason → NOT reauth (fail closed)
 *   - anything else → NOT reauth
 */
export function isGoogleDriveAuthError(status: number, body: GoogleApiError | undefined): boolean {
  if (status === 401) return true;
  if (status !== 403) return false;
  const errs = body?.error?.errors ?? [];
  if (errs.some(e => e.reason && GOOGLE_NON_AUTH_403_REASONS.has(e.reason))) return false;
  if (errs.some(e => e.reason && GOOGLE_AUTH_REASONS.has(e.reason))) return true;
  return false;
}

// ─── HTTP wrapper ─────────────────────────────────────────────────────────

async function driveFetch(
  endpoint: string,
  token: string,
  method = 'GET',
  body?: unknown,
): Promise<{ status: number; data: Record<string, unknown> }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT);
  try {
    const res = await fetch(`${DRIVE_API}${endpoint}`, {
      method,
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: body ? JSON.stringify(body) : undefined,
      signal: controller.signal,
    });
    clearTimeout(timer);
    let data: Record<string, unknown> = {};
    if (res.status !== 204) {
      try { data = (await res.json()) as Record<string, unknown>; } catch { data = {}; }
    }
    if (isGoogleDriveAuthError(res.status, data as GoogleApiError)) {
      throw new ConnectorReauthError('google_drive', `Google Drive auth failed: HTTP ${res.status}`);
    }
    return { status: res.status, data };
  } catch (err: unknown) {
    clearTimeout(timer);
    throw err;
  }
}

function formatFile(file: Record<string, unknown>): string {
  const name = (file.name as string) || '?';
  const id = (file.id as string) || '';
  const mimeType = (file.mimeType as string) || '';
  const size = file.size ? `${Math.round(Number(file.size) / 1024)}KB` : '';
  const modified = (file.modifiedTime as string) || '';
  const isFolder = mimeType === 'application/vnd.google-apps.folder';

  let line = `  ${isFolder ? '\u{1F4C1}' : '\u{1F4C4}'} ${name}`;
  if (size) line += ` (${size})`;
  line += `\n    ID: ${id}`;
  if (modified) line += `\n    Modified: ${modified}`;
  if (!isFolder && mimeType) line += `\n    Type: ${mimeType}`;
  return line;
}

// ─── Action definitions ───────────────────────────────────────────────────

const listFiles: ConnectorAction = {
  name: 'list_files',
  description: 'List files and folders in Google Drive',
  parameters: {
    type: 'object',
    properties: {
      folder_id: { type: 'string', description: 'Folder ID to list (default: root)' },
      count: { type: 'number', description: 'Max files to return (default 20, max 100)' },
      type: { type: 'string', description: 'Filter by type: "files", "folders", or "all" (default: all)' },
    },
  },
  capabilities: ['read-only', 'account-access', 'net-fetch'],
  execute: async (args, cred) => {
    const folderId = (args.folder_id as string) || 'root';
    const count = Math.min((args.count as number) || 20, 100);
    const typeFilter = (args.type as string) || 'all';

    let query = `'${folderId}' in parents and trashed = false`;
    if (typeFilter === 'files') query += ` and mimeType != 'application/vnd.google-apps.folder'`;
    if (typeFilter === 'folders') query += ` and mimeType = 'application/vnd.google-apps.folder'`;

    try {
      const { status, data } = await driveFetch(
        `/files?q=${encodeURIComponent(query)}&pageSize=${count}&fields=files(id,name,mimeType,size,modifiedTime)&orderBy=modifiedTime desc`,
        cred,
      );
      if (status !== 200) return `Error: Drive API ${status}: ${JSON.stringify(data).substring(0, 200)}`;
      const files = (data.files as Array<Record<string, unknown>>) || [];
      if (!files.length) return 'No files found in this location.';
      return truncate(`Files (${files.length}):\n\n${files.map(formatFile).join('\n\n')}`);
    } catch (err: unknown) {
      if (err instanceof ConnectorReauthError) throw err;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

const searchFiles: ConnectorAction = {
  name: 'search_files',
  description: 'Search for files across Google Drive',
  parameters: {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query (file name or content)' },
      count: { type: 'number', description: 'Max results (default 20, max 100)' },
    },
    required: ['query'],
  },
  capabilities: ['read-only', 'account-access', 'net-fetch'],
  execute: async (args, cred) => {
    const query = args.query as string;
    const count = Math.min((args.count as number) || 20, 100);
    if (!query) return 'Error: query is required';

    try {
      const driveQuery = `fullText contains '${query.replace(/'/g, "\\'")}' and trashed = false`;
      const { status, data } = await driveFetch(
        `/files?q=${encodeURIComponent(driveQuery)}&pageSize=${count}&fields=files(id,name,mimeType,size,modifiedTime)&orderBy=modifiedTime desc`,
        cred,
      );
      if (status !== 200) return `Error: Drive API ${status}: ${JSON.stringify(data).substring(0, 200)}`;
      const files = (data.files as Array<Record<string, unknown>>) || [];
      if (!files.length) return `No files found for "${query}".`;
      return truncate(`Search results for "${query}" (${files.length}):\n\n${files.map(formatFile).join('\n\n')}`);
    } catch (err: unknown) {
      if (err instanceof ConnectorReauthError) throw err;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

const readFile: ConnectorAction = {
  name: 'read_file',
  description: 'Read the text content of a file from Google Drive (supports Google Docs, text files, etc.)',
  parameters: {
    type: 'object',
    properties: {
      file_id: { type: 'string', description: 'File ID to read' },
    },
    required: ['file_id'],
  },
  capabilities: ['read-only', 'account-access', 'net-fetch'],
  execute: async (args, cred) => {
    const fileId = args.file_id as string;
    if (!fileId) return 'Error: file_id is required';

    try {
      const { status: metaStatus, data: meta } = await driveFetch(
        `/files/${encodeURIComponent(fileId)}?fields=name,mimeType,size`,
        cred,
      );
      if (metaStatus !== 200) return `Error: Drive API ${metaStatus}: ${JSON.stringify(meta).substring(0, 200)}`;

      const mimeType = meta.mimeType as string;
      const name = meta.name as string;

      let exportUrl: string;
      if (mimeType === 'application/vnd.google-apps.document') {
        exportUrl = `${DRIVE_API}/files/${encodeURIComponent(fileId)}/export?mimeType=text/plain`;
      } else if (mimeType === 'application/vnd.google-apps.spreadsheet') {
        exportUrl = `${DRIVE_API}/files/${encodeURIComponent(fileId)}/export?mimeType=text/csv`;
      } else if (mimeType === 'application/vnd.google-apps.presentation') {
        exportUrl = `${DRIVE_API}/files/${encodeURIComponent(fileId)}/export?mimeType=text/plain`;
      } else {
        exportUrl = `${DRIVE_API}/files/${encodeURIComponent(fileId)}?alt=media`;
      }

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), TIMEOUT);
      const res = await fetch(exportUrl, {
        headers: { 'Authorization': `Bearer ${cred}` },
        signal: controller.signal,
      });
      clearTimeout(timer);

      if (isGoogleDriveAuthError(res.status, undefined)) {
        // Body may not be JSON for the export endpoint on auth failures;
        // we already know the status is auth-class so throw directly.
        throw new ConnectorReauthError('google_drive', `Google Drive auth failed reading "${name}": HTTP ${res.status}`);
      }
      if (!res.ok) return `Error: Drive API ${res.status} reading file "${name}"`;

      const text = await res.text();
      return truncate(`File: ${name}\nType: ${mimeType}\n\n${text}`);
    } catch (err: unknown) {
      if (err instanceof ConnectorReauthError) throw err;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

const getFileInfo: ConnectorAction = {
  name: 'get_file_info',
  description: 'Get metadata about a file (name, size, sharing, etc.)',
  parameters: {
    type: 'object',
    properties: {
      file_id: { type: 'string', description: 'File ID' },
    },
    required: ['file_id'],
  },
  capabilities: ['read-only', 'account-access', 'net-fetch'],
  execute: async (args, cred) => {
    const fileId = args.file_id as string;
    if (!fileId) return 'Error: file_id is required';

    try {
      const { status, data } = await driveFetch(
        `/files/${encodeURIComponent(fileId)}?fields=id,name,mimeType,size,modifiedTime,createdTime,owners,shared,webViewLink`,
        cred,
      );
      if (status !== 200) return `Error: Drive API ${status}: ${JSON.stringify(data).substring(0, 200)}`;

      const owners = (data.owners as Array<{ displayName: string; emailAddress: string }>) || [];
      const ownerStr = owners.map(o => `${o.displayName} <${o.emailAddress}>`).join(', ');
      const size = data.size ? `${Math.round(Number(data.size) / 1024)}KB` : 'N/A';

      return [
        `File: ${data.name}`,
        `ID: ${data.id}`,
        `Type: ${data.mimeType}`,
        `Size: ${size}`,
        `Created: ${data.createdTime}`,
        `Modified: ${data.modifiedTime}`,
        `Owner: ${ownerStr || 'unknown'}`,
        `Shared: ${data.shared ? 'Yes' : 'No'}`,
        data.webViewLink ? `Link: ${data.webViewLink}` : '',
      ].filter(Boolean).join('\n');
    } catch (err: unknown) {
      if (err instanceof ConnectorReauthError) throw err;
      return `Error: ${err instanceof Error ? err.message : String(err)}`;
    }
  },
};

// ─── Connector ────────────────────────────────────────────────────────────

export class GoogleDriveConnector implements Connector {
  name = 'google_drive';
  displayName = 'Google Drive';
  description = 'List, search, and read files from Google Drive.';
  authType: Connector['authType'] = 'api_key';
  envKey = 'GOOGLE_DRIVE_TOKEN';
  vaultKeyName = 'google_drive';

  actions: ConnectorAction[] = [listFiles, searchFiles, readFile, getFileInfo];

  async validate(credential: string): Promise<boolean> {
    try {
      const { status } = await driveFetch('/about?fields=user', credential);
      return status === 200;
    } catch {
      return false;
    }
  }
}
