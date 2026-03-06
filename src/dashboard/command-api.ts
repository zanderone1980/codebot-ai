/**
 * Command Center API — interactive endpoints for the dashboard.
 *
 * Provides: chat (SSE), terminal exec (SSE), quick actions, tool listing & execution.
 * Terminal + Quick Actions work standalone. Chat + Tool Runner need an Agent.
 */

import * as http from 'http';
import { spawn } from 'child_process';
import { DashboardServer } from './server';
import { Agent } from '../agent';
import { BLOCKED_PATTERNS, FILTERED_ENV_VARS } from '../tools/execute';

/** Quick-action definitions: AI prompt (agent) + shell command (standalone) */
const QUICK_ACTIONS: Record<string, { prompt: string; command: string }> = {
  'git-status':   { prompt: 'Run git status and show me the result briefly.',                      command: 'git status' },
  'run-tests':    { prompt: 'Run the project test suite and report a brief summary of results.',   command: 'npm test 2>&1 || true' },
  'health-check': { prompt: 'Check system health: run node --version, git --version, and df -h.',  command: 'echo "=== Node ===" && node --version && echo "=== Git ===" && git --version && echo "=== Disk ===" && df -h .' },
  'git-log':      { prompt: 'Run git log --oneline -10 and show me the output.',                   command: 'git log --oneline -10' },
  'git-diff':     { prompt: 'Run git diff --stat and show me the summary.',                        command: 'git diff --stat' },
};

/** Build a filtered env for child processes (strip secrets) */
function filteredEnv(): NodeJS.ProcessEnv {
  const env = { ...process.env };
  for (const key of FILTERED_ENV_VARS) {
    delete env[key];
  }
  return env;
}

/** Spawn a shell command and stream stdout/stderr as SSE events */
function execAndStream(
  res: http.ServerResponse,
  command: string,
  cwd?: string,
): void {
  DashboardServer.sseHeaders(res);

  let closed = false;
  const child = spawn('sh', ['-c', command], {
    cwd: cwd || process.cwd(),
    env: filteredEnv(),
  });

  res.on('close', () => {
    closed = true;
    if (!child.killed) child.kill('SIGTERM');
  });

  child.stdout.on('data', (data: Buffer) => {
    if (!closed) DashboardServer.sseSend(res, { type: 'stdout', text: data.toString() });
  });

  child.stderr.on('data', (data: Buffer) => {
    if (!closed) DashboardServer.sseSend(res, { type: 'stderr', text: data.toString() });
  });

  child.on('close', (code) => {
    if (!closed) {
      DashboardServer.sseSend(res, { type: 'exit', code: code ?? 0 });
      DashboardServer.sseClose(res);
    }
  });

  child.on('error', (err) => {
    if (!closed) {
      DashboardServer.sseSend(res, { type: 'stderr', text: err.message });
      DashboardServer.sseSend(res, { type: 'exit', code: 1 });
      DashboardServer.sseClose(res);
    }
  });

  const timer = setTimeout(() => {
    if (!child.killed) {
      child.kill('SIGTERM');
      if (!closed) {
        DashboardServer.sseSend(res, { type: 'stderr', text: '\n[Timed out after 30s]' });
        DashboardServer.sseSend(res, { type: 'exit', code: 124 });
        DashboardServer.sseClose(res);
      }
    }
  }, 30_000);

  child.on('close', () => clearTimeout(timer));
}

/**
 * Register command-center API routes on the dashboard server.
 * Terminal + Quick Actions work in standalone mode (no agent).
 * Chat + Tool Runner require an agent instance.
 */
export function registerCommandRoutes(
  server: DashboardServer,
  agent: Agent | null,
): void {
  let agentBusy = false;

  // ── GET /api/command/status ──
  server.route('GET', '/api/command/status', (_req, res) => {
    DashboardServer.json(res, {
      available: agent !== null,
      agentBusy,
    });
  });

  // ── GET /api/command/tools ──
  server.route('GET', '/api/command/tools', (_req, res) => {
    if (!agent) {
      DashboardServer.error(res, 503, 'Agent not available (standalone mode)');
      return;
    }
    const tools = agent.getToolRegistry().all().map(t => ({
      name: t.name,
      description: t.description,
      parameters: t.parameters,
      permission: t.permission,
    }));
    DashboardServer.json(res, { tools });
  });

  // ── POST /api/command/tool/run ──
  server.route('POST', '/api/command/tool/run', async (req, res) => {
    if (!agent) {
      DashboardServer.error(res, 503, 'Agent not available');
      return;
    }

    let body: { tool?: string; args?: Record<string, unknown> };
    try {
      body = (await DashboardServer.parseBody(req)) as typeof body;
    } catch {
      DashboardServer.error(res, 400, 'Invalid JSON body');
      return;
    }

    if (!body?.tool) {
      DashboardServer.error(res, 400, 'Missing "tool" field');
      return;
    }

    const tool = agent.getToolRegistry().get(body.tool);
    if (!tool) {
      DashboardServer.error(res, 404, `Tool "${body.tool}" not found`);
      return;
    }

    const startMs = Date.now();
    try {
      const result = await tool.execute(body.args || {});
      DashboardServer.json(res, {
        result,
        is_error: result.startsWith('Error:'),
        duration_ms: Date.now() - startMs,
      });
    } catch (err: unknown) {
      DashboardServer.json(res, {
        result: err instanceof Error ? err.message : String(err),
        is_error: true,
        duration_ms: Date.now() - startMs,
      });
    }
  });

  // ── POST /api/command/chat (agent only) ──
  server.route('POST', '/api/command/chat', async (req, res) => {
    if (!agent) {
      DashboardServer.error(res, 503, 'Agent not available');
      return;
    }

    let body: { message?: string };
    try {
      body = (await DashboardServer.parseBody(req)) as typeof body;
    } catch {
      DashboardServer.error(res, 400, 'Invalid JSON body');
      return;
    }

    if (!body?.message) {
      DashboardServer.error(res, 400, 'Missing "message" field');
      return;
    }

    if (agentBusy) {
      DashboardServer.error(res, 409, 'Agent is busy processing another request');
      return;
    }

    agentBusy = true;
    DashboardServer.sseHeaders(res);

    let closed = false;
    res.on('close', () => { closed = true; });

    try {
      for await (const event of agent.run(body.message)) {
        if (closed) break;
        DashboardServer.sseSend(res, event);
        if (event.type === 'done' || event.type === 'error') break;
      }
    } catch (err: unknown) {
      if (!closed) {
        DashboardServer.sseSend(res, {
          type: 'error',
          text: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      agentBusy = false;
      if (!closed) DashboardServer.sseClose(res);
    }
  });

  // ── POST /api/command/quick-action (works standalone via exec) ──
  server.route('POST', '/api/command/quick-action', async (req, res) => {
    let body: { action?: string };
    try {
      body = (await DashboardServer.parseBody(req)) as typeof body;
    } catch {
      DashboardServer.error(res, 400, 'Invalid JSON body');
      return;
    }

    const actionDef = QUICK_ACTIONS[body?.action || ''];
    if (!actionDef) {
      DashboardServer.error(res, 400, `Unknown action: "${body?.action}". Available: ${Object.keys(QUICK_ACTIONS).join(', ')}`);
      return;
    }

    // Agent mode: use AI
    if (agent) {
      if (agentBusy) {
        DashboardServer.error(res, 409, 'Agent is busy processing another request');
        return;
      }
      agentBusy = true;
      DashboardServer.sseHeaders(res);

      let closed = false;
      res.on('close', () => { closed = true; });

      try {
        for await (const event of agent.run(actionDef.prompt)) {
          if (closed) break;
          DashboardServer.sseSend(res, event);
          if (event.type === 'done' || event.type === 'error') break;
        }
      } catch (err: unknown) {
        if (!closed) {
          DashboardServer.sseSend(res, {
            type: 'error',
            text: err instanceof Error ? err.message : String(err),
          });
        }
      } finally {
        agentBusy = false;
        if (!closed) DashboardServer.sseClose(res);
      }
      return;
    }

    // Standalone mode: run shell command directly
    execAndStream(res, actionDef.command);
  });

  // ── POST /api/command/exec (always works) ──
  server.route('POST', '/api/command/exec', async (req, res) => {
    let body: { command?: string; cwd?: string };
    try {
      body = (await DashboardServer.parseBody(req)) as typeof body;
    } catch {
      DashboardServer.error(res, 400, 'Invalid JSON body');
      return;
    }

    if (!body?.command) {
      DashboardServer.error(res, 400, 'Missing "command" field');
      return;
    }

    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(body.command)) {
        DashboardServer.error(res, 403, 'Blocked: dangerous command pattern detected');
        return;
      }
    }

    execAndStream(res, body.command, body.cwd);
  });

  // ── POST /api/command/swarm ──
  server.route('POST', '/api/command/swarm', async (req, res) => {
    let body: { task?: string; providers?: string[]; strategy?: string };
    try {
      body = (await DashboardServer.parseBody(req)) as typeof body;
    } catch {
      DashboardServer.error(res, 400, 'Invalid JSON body');
      return;
    }

    if (!body?.task) {
      DashboardServer.error(res, 400, 'Missing "task" field');
      return;
    }

    if (!body?.providers || body.providers.length === 0) {
      DashboardServer.error(res, 400, 'Select at least one provider');
      return;
    }

    if (!agent) {
      DashboardServer.error(res, 503, 'Agent not available');
      return;
    }

    if (agentBusy) {
      DashboardServer.error(res, 409, 'Agent is busy processing another request');
      return;
    }

    agentBusy = true;
    DashboardServer.sseHeaders(res);

    let closed = false;
    res.on('close', () => { closed = true; });

    const strategy = body.strategy || 'auto';
    const providerList = body.providers.join(', ');

    // Use the delegate tool in swarm mode via the agent
    const swarmPrompt = `Use the delegate tool in swarm mode to accomplish this task. ` +
      `Strategy: ${strategy}. Providers: ${providerList}. Task: ${body.task}`;

    try {
      for await (const event of agent.run(swarmPrompt)) {
        if (closed) break;
        DashboardServer.sseSend(res, event);
        if (event.type === 'done' || event.type === 'error') break;
      }
    } catch (err: unknown) {
      if (!closed) {
        DashboardServer.sseSend(res, {
          type: 'error',
          text: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      agentBusy = false;
      if (!closed) DashboardServer.sseClose(res);
    }
  });

  // ── GET /api/command/history ──
  server.route('GET', '/api/command/history', (_req, res) => {
    if (!agent) {
      DashboardServer.json(res, { messages: [] });
      return;
    }
    const messages = agent.getMessages()
      .filter(m => m.role !== 'system')
      .slice(-100)
      .map(m => ({
        role: m.role,
        content: typeof m.content === 'string'
          ? m.content.substring(0, 5000)
          : String(m.content),
      }));
    DashboardServer.json(res, { messages });
  });
}
