/**
 * Google Drive Connector — List, search, read, upload files.
 *
 * Auth: Google Drive OAuth token (GOOGLE_DRIVE_TOKEN).
 * Uses the Google Drive REST API v3.
 */

import { Connector, ConnectorAction } from './base';

const TIMEOUT = 20_000;
const MAX_RESPONSE = 10_000;
const DRIVE_API = 'https://www.googleapis.com/drive/v3';

function truncate(text: string): string {
  return text.length <= MAX_RESPONSE ? text : text.substring(0, MAX_RESPONSE) + '\n... (truncated)';
}

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
    const data = await res.json() as Record<string, unknown>;
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

  let line = `  ${isFolder ? '📁' : '📄'} ${name}`;
  if (size) line += ` (${size})`;
  line += `\n    ID: ${id}`;
  if (modified) line += `\n    Modified: ${modified}`;
  if (!isFolder && mimeType) line += `\n    Type: ${mimeType}`;
  return line;
}

export class GoogleDriveConnector implements Connector {
  name = 'google_drive';
  displayName = 'Google Drive';
  description = 'List, search, and read files from Google Drive.';
  authType: Connector['authType'] = 'api_key';
  envKey = 'GOOGLE_DRIVE_TOKEN';

  actions: ConnectorAction[] = [
    {
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
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
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
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'read_file',
      description: 'Read the text content of a file from Google Drive (supports Google Docs, text files, etc.)',
      parameters: {
        type: 'object',
        properties: {
          file_id: { type: 'string', description: 'File ID to read' },
        },
        required: ['file_id'],
      },
      execute: async (args, cred) => {
        const fileId = args.file_id as string;
        if (!fileId) return 'Error: file_id is required';

        try {
          // First get file metadata
          const { status: metaStatus, data: meta } = await driveFetch(
            `/files/${fileId}?fields=name,mimeType,size`,
            cred,
          );
          if (metaStatus !== 200) return `Error: Drive API ${metaStatus}: ${JSON.stringify(meta).substring(0, 200)}`;

          const mimeType = meta.mimeType as string;
          const name = meta.name as string;

          // Google Docs need to be exported
          let exportUrl: string;
          if (mimeType === 'application/vnd.google-apps.document') {
            exportUrl = `${DRIVE_API}/files/${fileId}/export?mimeType=text/plain`;
          } else if (mimeType === 'application/vnd.google-apps.spreadsheet') {
            exportUrl = `${DRIVE_API}/files/${fileId}/export?mimeType=text/csv`;
          } else if (mimeType === 'application/vnd.google-apps.presentation') {
            exportUrl = `${DRIVE_API}/files/${fileId}/export?mimeType=text/plain`;
          } else {
            // Regular file — download content
            exportUrl = `${DRIVE_API}/files/${fileId}?alt=media`;
          }

          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), TIMEOUT);
          const res = await fetch(exportUrl, {
            headers: { 'Authorization': `Bearer ${cred}` },
            signal: controller.signal,
          });
          clearTimeout(timer);

          if (!res.ok) return `Error: Drive API ${res.status} reading file "${name}"`;

          const text = await res.text();
          return truncate(`File: ${name}\nType: ${mimeType}\n\n${text}`);
        } catch (err: unknown) {
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
    {
      name: 'get_file_info',
      description: 'Get metadata about a file (name, size, sharing, etc.)',
      parameters: {
        type: 'object',
        properties: {
          file_id: { type: 'string', description: 'File ID' },
        },
        required: ['file_id'],
      },
      execute: async (args, cred) => {
        const fileId = args.file_id as string;
        if (!fileId) return 'Error: file_id is required';

        try {
          const { status, data } = await driveFetch(
            `/files/${fileId}?fields=id,name,mimeType,size,modifiedTime,createdTime,owners,shared,webViewLink`,
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
          return `Error: ${err instanceof Error ? err.message : String(err)}`;
        }
      },
    },
  ];

  async validate(credential: string): Promise<boolean> {
    try {
      const { status } = await driveFetch('/about?fields=user', credential);
      return status === 200;
    } catch {
      return false;
    }
  }
}
