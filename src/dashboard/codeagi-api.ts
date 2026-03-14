/**
 * CodeAGI Dashboard API — Bridges CodeAGI (Python) into CodeBot's dashboard.
 * Shells out to `python3 -m codeagi` and streams results as SSE.
 * Zero external dependencies.
 */

import { DashboardServer } from './server';
import { spawn, execSync } from 'child_process';
import * as path from 'path';

const CODEAGI_ROOT = path.join(process.env.HOME || '~', 'ClaudeWork', 'CodeAGI');
const CODEAGI_WORKSPACE = path.join(process.env.HOME || '~', 'CodeAGI', 'workspace');
const CODEAGI_RUNTIME = path.join(process.env.HOME || '~', 'CodeAGI', 'runtime');

/** Run a codeagi CLI command and return JSON output */
function codeagiExec(args: string[]): any {
  try {
    const result = execSync(
      `cd ${CODEAGI_ROOT} && python3 -m codeagi ${args.join(' ')}`,
      { timeout: 30_000, encoding: 'utf-8', env: { ...process.env, PYTHONPATH: CODEAGI_ROOT } }
    );
    try { return JSON.parse(result.trim()); }
    catch { return { raw: result.trim() }; }
  } catch (err: unknown) {
    const msg = err instanceof Error ? (err as any).stderr || err.message : String(err);
    return { error: msg };
  }
}

/** List files in workspace directory */
function listWorkspace(subdir?: string): any {
  const dir = subdir ? path.join(CODEAGI_WORKSPACE, subdir) : CODEAGI_WORKSPACE;
  try {
    const fs = require('fs');
    if (!fs.existsSync(dir)) return { files: [], error: 'Directory not found' };
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    return {
      path: subdir || '/',
      files: entries.map((e: any) => ({
        name: e.name,
        type: e.isDirectory() ? 'directory' : 'file',
        size: e.isFile() ? fs.statSync(path.join(dir, e.name)).size : undefined,
      }))
    };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Read a workspace file */
function readWorkspaceFile(filePath: string): any {
  const full = path.join(CODEAGI_WORKSPACE, filePath);
  try {
    const fs = require('fs');
    if (!fs.existsSync(full)) return { error: 'File not found' };
    const stat = fs.statSync(full);
    if (stat.size > 100_000) return { error: 'File too large (>100KB)', size: stat.size };
    return { path: filePath, content: fs.readFileSync(full, 'utf-8'), size: stat.size };
  } catch (err: unknown) {
    return { error: err instanceof Error ? err.message : String(err) };
  }
}

/** Load runtime state files (missions, tasks, reflections, etc.) */
function loadRuntimeState(collection: string): any {
  const fs = require('fs');
  const stateFile = path.join(CODEAGI_RUNTIME, 'state', `${collection}.json`);
  const queueFile = path.join(CODEAGI_RUNTIME, 'queue', `${collection}.json`);
  const logFile = path.join(CODEAGI_RUNTIME, 'logs', `${collection}.json`);
  
  for (const f of [stateFile, queueFile, logFile]) {
    if (fs.existsSync(f)) {
      try { return JSON.parse(fs.readFileSync(f, 'utf-8')); }
      catch { continue; }
    }
  }
  return [];
}

/** Load long-term memory files */
function loadLongTermMemory(type: string): any {
  const fs = require('fs');
  const ltRoot = process.env.CODEAGI_LONG_TERM_ROOT || path.join(process.env.HOME || '~', 'CodeAGI', 'long_term');
  const paths: Record<string, string> = {
    reflections: path.join(ltRoot, 'memory', 'consolidation', 'reflections.json'),
    semantic: path.join(ltRoot, 'memory', 'semantic', 'facts.json'),
    procedures: path.join(ltRoot, 'memory', 'procedural', 'skills.json'),
    episodic: path.join(ltRoot, 'memory', 'episodic', 'events.jsonl'),
  };
  const filePath = paths[type];
  if (!filePath) return { error: `Unknown memory type: ${type}` };
  if (!fs.existsSync(filePath)) return [];
  try {
    if (filePath.endsWith('.jsonl')) {
      const lines = fs.readFileSync(filePath, 'utf-8').trim().split('\n');
      return lines.slice(-50).map((l: string) => { try { return JSON.parse(l); } catch { return l; } });
    }
    return JSON.parse(fs.readFileSync(filePath, 'utf-8'));
  } catch { return []; }
}

export function registerCodeAGIRoutes(server: DashboardServer): void {

  // ── GET /api/codeagi/status ──
  server.route('GET', '/api/codeagi/status', (_req, res) => {
    const result = codeagiExec(['status']);
    DashboardServer.json(res, result);
  });

  // ── GET /api/codeagi/missions ──
  server.route('GET', '/api/codeagi/missions', (_req, res) => {
    const missions = loadRuntimeState('missions');
    const tasks = loadRuntimeState('tasks');
    DashboardServer.json(res, { missions, tasks });
  });

  // ── POST /api/codeagi/missions ── Create a new mission
  server.route('POST', '/api/codeagi/missions', async (req, res) => {
    let body: any;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch { DashboardServer.error(res, 400, 'Invalid JSON'); return; }
    
    if (!body.description) { DashboardServer.error(res, 400, 'Missing description'); return; }
    const priority = body.priority || 50;
    const result = codeagiExec(['mission', 'create', JSON.stringify(body.description), '--priority', String(priority)]);
    DashboardServer.json(res, result);
  });

  // ── POST /api/codeagi/tasks ── Create a task for a mission
  server.route('POST', '/api/codeagi/tasks', async (req, res) => {
    let body: any;
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      body = JSON.parse(Buffer.concat(chunks).toString());
    } catch { DashboardServer.error(res, 400, 'Invalid JSON'); return; }

    if (!body.mission_id || !body.description) {
      DashboardServer.error(res, 400, 'Missing mission_id or description');
      return;
    }
    const args = ['task', 'create', body.mission_id, JSON.stringify(body.description)];
    if (body.action_kind) args.push('--action-kind', body.action_kind);
    if (body.path) args.push('--path', body.path);
    if (body.content) args.push('--content', JSON.stringify(body.content));
    if (body.command) args.push('--command', body.command);
    const result = codeagiExec(args);
    DashboardServer.json(res, result);
  });

  // ── POST /api/codeagi/run ── Run a cycle (SSE stream)
  server.route('POST', '/api/codeagi/run', async (req, res) => {
    let body: any = {};
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      if (chunks.length) body = JSON.parse(Buffer.concat(chunks).toString());
    } catch { /* empty body is ok */ }

    const maxCycles = body.max_cycles || 1;
    DashboardServer.sseHeaders(res);
    let closed = false;
    res.on('close', () => { closed = true; });

    DashboardServer.sseSend(res, { type: 'status', text: `Starting CodeAGI run (max_cycles: ${maxCycles})...` });

    const proc = spawn('python3', ['-m', 'codeagi', 'run', '--max-cycles', String(maxCycles)], {
      cwd: CODEAGI_ROOT,
      env: { ...process.env, PYTHONPATH: CODEAGI_ROOT, PYTHONUNBUFFERED: '1' },
    });

    let outputBuffer = '';

    proc.stdout.on('data', (data: Buffer) => {
      if (closed) return;
      outputBuffer += data.toString();
      const lines = outputBuffer.split('\n');
      outputBuffer = lines.pop() || '';
      for (const line of lines) {
        if (!line.trim()) continue;
        // Try to parse as JSON (codeagi outputs JSON)
        try {
          const parsed = JSON.parse(line);
          DashboardServer.sseSend(res, { type: 'cycle_data', data: parsed });
        } catch {
          DashboardServer.sseSend(res, { type: 'text', text: line });
        }
      }
    });

    proc.stderr.on('data', (data: Buffer) => {
      if (closed) return;
      const text = data.toString();
      // Filter out Python warnings, keep real errors
      if (!text.includes('DeprecationWarning') && !text.includes('FutureWarning')) {
        DashboardServer.sseSend(res, { type: 'log', text: text.trim() });
      }
    });

    proc.on('close', (code: number | null) => {
      if (closed) return;
      DashboardServer.sseSend(res, {
        type: 'complete',
        text: code === 0 ? 'Cycle completed successfully' : `Cycle exited with code ${code}`,
        exitCode: code,
      });
      DashboardServer.sseClose(res);
    });

    proc.on('error', (err: Error) => {
      if (closed) return;
      DashboardServer.sseSend(res, { type: 'error', text: err.message });
      DashboardServer.sseClose(res);
    });

    // 5 minute timeout for run
    setTimeout(() => {
      if (!closed) {
        proc.kill('SIGTERM');
        DashboardServer.sseSend(res, { type: 'error', text: 'Run timed out after 5 minutes' });
        DashboardServer.sseClose(res);
      }
    }, 300_000);
  });

  // ── GET /api/codeagi/workspace ── List workspace files
  server.route('GET', '/api/codeagi/workspace', (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const subdir = url.searchParams.get('path') || undefined;
    DashboardServer.json(res, listWorkspace(subdir));
  });

  // ── GET /api/codeagi/workspace/file ── Read workspace file
  server.route('GET', '/api/codeagi/workspace/file', (req, res) => {
    const url = new URL(req.url || '/', `http://${req.headers.host}`);
    const filePath = url.searchParams.get('path');
    if (!filePath) { DashboardServer.error(res, 400, 'Missing path parameter'); return; }
    DashboardServer.json(res, readWorkspaceFile(filePath));
  });

  // ── GET /api/codeagi/memory/:type ── Load memory (reflections, semantic, procedures, episodic)
  server.route('GET', '/api/codeagi/memory/:type', (req, res, params) => {
    DashboardServer.json(res, loadLongTermMemory(params.type));
  });

  // ── GET /api/codeagi/traces ── Load cycle traces
  server.route('GET', '/api/codeagi/traces', (_req, res) => {
    DashboardServer.json(res, loadRuntimeState('cycle_traces'));
  });
}
