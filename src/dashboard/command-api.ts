/**
 * Command Center API — interactive endpoints for the dashboard.
 *
 * Provides: chat (SSE), terminal exec (SSE), quick actions, tool listing & execution.
 * Terminal + Quick Actions work standalone. Chat + Tool Runner need an Agent.
 */

import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';
import { codebotPath } from '../paths';
import { spawn } from 'child_process';
import { DashboardServer } from './server';
import { Agent } from '../agent';
import { SessionManager } from '../history';
import { BLOCKED_PATTERNS, FILTERED_ENV_VARS } from '../tools/execute';
import { PROVIDER_DEFAULTS } from '../providers/registry';
import { AnthropicProvider } from '../providers/anthropic';
import { OpenAIProvider } from '../providers/openai';
import { LLMProvider, Message } from '../types';
import { getProactiveEngine } from '../proactive';
import { loadWorkflows, getWorkflow, resolveWorkflowPrompt, WORKFLOW_CATEGORIES } from '../workflows';

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
        closed = true;
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
  const messageQueue: Array<{ message: string; mode?: 'simple' | 'detailed'; resolve: (v: unknown) => void }> = [];
  const statusClients: Set<http.ServerResponse> = new Set();

  /** Broadcast agent status to all SSE clients */
  function broadcastStatus(status: 'idle' | 'working' | 'done' | 'queued', extra?: Record<string, unknown>) {
    const data = { status, queueLength: messageQueue.length, ...extra };
    for (const client of statusClients) {
      if (client.writableEnded || client.destroyed) { statusClients.delete(client); continue; }
      try { DashboardServer.sseSend(client, data); } catch { statusClients.delete(client); }
    }
  }

  /** Process next queued message */
  async function processQueue() {
    if (agentBusy || messageQueue.length === 0 || !agent) return;
    const next = messageQueue.shift()!;
    broadcastStatus('working', { message: next.message });
    agentBusy = true;
    try {
      let result = '';
      for await (const event of agent.run(next.message)) {
        if (event.type === 'text') result += (event as any).text || '';
        if (event.type === 'tool_call') {
          const tc = (event as any).toolCall;
          broadcastStatus('working', { tool: tc?.name, action: tc?.args?.action || tc?.args?.command, message: next.message });
        }
        if (event.type === 'tool_result') {
          const tr = (event as any).toolResult;
          broadcastStatus('working', { toolDone: tr?.name, success: !tr?.is_error, message: next.message });
        }
        if (event.type === 'done' || event.type === 'error') break;
      }
      next.resolve({ result });
    } catch (err: unknown) {
      next.resolve({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      agentBusy = false;
      broadcastStatus(messageQueue.length > 0 ? 'queued' : 'idle');
      // Process next in queue
      if (messageQueue.length > 0) setTimeout(processQueue, 100);
    }
  }

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
        is_error: typeof result === 'string' && result.startsWith('Error:'),
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

  // ── GET /api/command/agent-status (SSE) ──
  server.route('GET', '/api/command/agent-status', (_req, res) => {
    DashboardServer.sseHeaders(res);
    statusClients.add(res);
    DashboardServer.sseSend(res, { status: agentBusy ? 'working' : 'idle', queueLength: messageQueue.length });
    // Heartbeat keeps Safari/proxy connections alive
    const hb = setInterval(() => {
      if (res.writableEnded || res.destroyed) { clearInterval(hb); statusClients.delete(res); return; }
      try { res.write(': heartbeat\n\n'); } catch { clearInterval(hb); statusClients.delete(res); }
    }, 15_000);
    res.on('close', () => { clearInterval(hb); statusClients.delete(res); });
  });


  // ── POST /api/command/chat/reset — start a new conversation ──
  server.route('POST', '/api/command/chat/reset', async (_req, res) => {
    if (!agent) {
      DashboardServer.error(res, 503, 'Agent not available');
      return;
    }
    agent.resetConversation();
    DashboardServer.json(res, { reset: true });
  });

  // ── POST /api/command/chat (agent only) ──
  server.route('POST', '/api/command/chat', async (req, res) => {
    if (!agent) {
      DashboardServer.error(res, 503, 'Agent not available');
      return;
    }

    let body: { message?: string; mode?: 'simple' | 'detailed'; images?: Array<{ data: string; mediaType: string }> };
    try {
      body = (await DashboardServer.parseBody(req)) as typeof body;
    } catch {
      DashboardServer.error(res, 400, 'Invalid JSON body');
      return;
    }

    if (!body?.message && (!body?.images || body.images.length === 0)) {
      DashboardServer.error(res, 400, 'Missing "message" field');
      return;
    }

    if (agentBusy) {
      // Queue the message instead of rejecting
      const queuePromise = new Promise((resolve) => {
        messageQueue.push({ message: body.message!, mode: body.mode, resolve });
      });
      broadcastStatus('queued', { position: messageQueue.length });
      DashboardServer.json(res, {
        queued: true,
        position: messageQueue.length,
        message: 'Message queued — agent will process it next',
      });
      // finally block's setTimeout already calls processQueue when agent finishes
      queuePromise.catch(() => {});
      return;
    }

    // Simple mode: prepend plain-language instruction for non-technical users
    let userMessage = body.message || '';
    if (body.mode === 'simple') {
      userMessage = '[Respond in plain, simple language suitable for someone who is not a programmer. Be concise and friendly. Focus on results, not technical details.]\n\n' + userMessage;
    }

    agentBusy = true;
    broadcastStatus('working', { message: body.message });
    DashboardServer.sseHeaders(res);

    let closed = false;
    res.on('close', () => { closed = true; });

    // Heartbeat keeps connection alive through proxies/Safari
    const heartbeat = setInterval(() => {
      if (closed || res.writableEnded || res.destroyed) { clearInterval(heartbeat); return; }
      try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); closed = true; }
    }, 15_000);

    try {
      // Pass images through to agent if provided
      const chatImages = body.images?.map((img: { data: string; mediaType: string }) => ({
        data: img.data,
        mediaType: img.mediaType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
      }));
      for await (const event of agent.run(userMessage, chatImages)) {
        if (closed || res.writableEnded || res.destroyed) break;
        DashboardServer.sseSend(res, event);
        if (event.type === 'done' || event.type === 'error') break;
      }
    } catch (err: unknown) {
      if (!closed && !res.writableEnded && !res.destroyed) {
        DashboardServer.sseSend(res, {
          type: 'error',
          text: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      clearInterval(heartbeat);
      closed = true;
      agentBusy = false;
      broadcastStatus(messageQueue.length > 0 ? 'queued' : 'idle');
      if (!res.writableEnded && !res.destroyed) {
        res.write('data: [DONE]\n\n');
        DashboardServer.sseClose(res);
      }
      // Process any queued messages
      if (messageQueue.length > 0) setTimeout(processQueue, 100);
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

      // Heartbeat keeps connection alive through proxies/Safari
      const qaHeartbeat = setInterval(() => {
        if (closed || res.writableEnded || res.destroyed) { clearInterval(qaHeartbeat); return; }
        try { res.write(': heartbeat\n\n'); } catch { clearInterval(qaHeartbeat); closed = true; }
      }, 15_000);

      try {
        for await (const event of agent.run(actionDef.prompt)) {
          if (closed || res.writableEnded || res.destroyed) break;
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
        clearInterval(qaHeartbeat);
        agentBusy = false;
        broadcastStatus(messageQueue.length > 0 ? 'queued' : 'idle');
        if (!closed) {
          res.write('data: [DONE]\n\n');
          DashboardServer.sseClose(res);
        }
        if (messageQueue.length > 0) setTimeout(processQueue, 100);
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


  // ── GET /api/notifications ──
  server.route('GET', '/api/notifications', (_req, res) => {
    const engine = getProactiveEngine();
    if (!engine) { DashboardServer.json(res, { notifications: [], unreadCount: 0 }); return; }
    DashboardServer.json(res, {
      notifications: engine.getAll(),
      unreadCount: engine.getUnreadCount(),
    });
  });

  // ── POST /api/notifications/dismiss-all ──
  server.route('POST', '/api/notifications/dismiss-all', (_req, res) => {
    const engine = getProactiveEngine();
    if (!engine) { DashboardServer.json(res, { dismissed: 0 }); return; }
    const count = engine.dismissAll();
    DashboardServer.json(res, { dismissed: count });
  });

  // ── POST /api/notifications/:id/:action ──
  server.route('POST', '/api/notifications/:id/:action', (_req, res, params) => {
    const engine = getProactiveEngine();
    if (!engine) { DashboardServer.error(res, 503, 'Notification engine not available'); return; }
    if (params.action === 'dismiss') {
      const ok = engine.dismiss(params.id);
      DashboardServer.json(res, { dismissed: ok });
    } else if (params.action === 'read') {
      const ok = engine.markRead(params.id);
      DashboardServer.json(res, { read: ok });
    } else {
      DashboardServer.error(res, 400, 'Unknown action. Use /dismiss or /read');
    }
  });

  // ── GET /api/notifications/stream (SSE) ──
  server.route('GET', '/api/notifications/stream', (_req, res) => {
    DashboardServer.sseHeaders(res);
    const engine = getProactiveEngine();
    if (!engine) { DashboardServer.sseSend(res, { type: 'init', unreadCount: 0 }); DashboardServer.sseClose(res); return; }

    const listener = (notification: unknown) => {
      if (res.writable) {
        DashboardServer.sseSend(res, { type: 'notification', notification });
      }
    };

    engine.onNotification(listener);

    res.on('close', () => {
      engine.removeListener(listener);
    });

    // Heartbeat keeps connections alive
    const nhb = setInterval(() => {
      if (res.writableEnded || res.destroyed) { clearInterval(nhb); return; }
      try { res.write(': heartbeat\n\n'); } catch { clearInterval(nhb); }
    }, 30_000);
    res.on('close', () => clearInterval(nhb));

    // Send initial unread count
    DashboardServer.sseSend(res, {
      type: 'init',
      unreadCount: engine.getUnreadCount(),
    });
  });

  // ── GET /api/workflows ──
  server.route('GET', '/api/workflows', (_req, res) => {
    const workflows = loadWorkflows();
    DashboardServer.json(res, {
      workflows: workflows.map(w => ({
        name: w.name,
        description: w.description,
        category: w.category,
        icon: w.icon,
        color: w.color,
        inputFields: w.inputFields,
      })),
      categories: WORKFLOW_CATEGORIES,
    });
  });

  // ── GET /api/workflows/:name ──
  server.route('GET', '/api/workflows/:name', (_req, res, params) => {
    const workflow = getWorkflow(params.name);
    if (!workflow) {
      DashboardServer.error(res, 404, 'Workflow "' + params.name + '" not found');
      return;
    }
    DashboardServer.json(res, { workflow });
  });

  // ── POST /api/workflows/:name/run (SSE stream) ──
  server.route('POST', '/api/workflows/:name/run', async (req, res, params) => {
    if (!agent) {
      DashboardServer.error(res, 503, 'Agent not available');
      return;
    }

    const workflow = getWorkflow(params.name);
    if (!workflow) {
      DashboardServer.error(res, 404, 'Workflow "' + params.name + '" not found');
      return;
    }

    let body: Record<string, string>;
    try {
      body = (await DashboardServer.parseBody(req)) as Record<string, string>;
    } catch {
      DashboardServer.error(res, 400, 'Invalid JSON body');
      return;
    }

    if (agentBusy) {
      DashboardServer.error(res, 409, 'Agent is busy processing another request');
      return;
    }

    const prompt = resolveWorkflowPrompt(workflow, body || {});

    agentBusy = true;
    DashboardServer.sseHeaders(res);

    let closed = false;
    res.on('close', () => { closed = true; });

    // Heartbeat keeps connection alive through proxies/Safari
    const wfHeartbeat = setInterval(() => {
      if (closed || res.writableEnded || res.destroyed) { clearInterval(wfHeartbeat); return; }
      try { res.write(': heartbeat\n\n'); } catch { clearInterval(wfHeartbeat); closed = true; }
    }, 15_000);

    try {
      for await (const event of agent.run(prompt)) {
        if (closed) break;
        DashboardServer.sseSend(res, event);
        if (event.type === 'done' || event.type === 'error') break;
      }
    } catch (err) {
      if (!closed) {
        DashboardServer.sseSend(res, {
          type: 'error',
          text: err instanceof Error ? err.message : String(err),
        });
      }
    } finally {
      clearInterval(wfHeartbeat);
      agentBusy = false;
      broadcastStatus(messageQueue.length > 0 ? 'queued' : 'idle');
      if (!closed) {
        res.write('data: [DONE]\n\n');
        DashboardServer.sseClose(res);
      }
      if (messageQueue.length > 0) setTimeout(processQueue, 100);
    }
  });

  // ── POST /api/command/resume ──
  server.route('POST', '/api/command/resume', async (req, res) => {
    if (!agent) {
      DashboardServer.error(res, 503, 'Agent not available');
      return;
    }
    if (agentBusy) {
      DashboardServer.error(res, 409, 'Agent is busy');
      return;
    }

    let body: { sessionId?: string };
    try {
      body = (await DashboardServer.parseBody(req)) as typeof body;
    } catch {
      DashboardServer.error(res, 400, 'Invalid JSON body');
      return;
    }

    if (!body?.sessionId) {
      DashboardServer.error(res, 400, 'Missing "sessionId" field');
      return;
    }

    const sm = new SessionManager('resume', body.sessionId);
    const messages = sm.load();

    if (messages.length === 0) {
      DashboardServer.error(res, 404, 'Session not found or empty');
      return;
    }

    agent.loadMessages(messages);

    DashboardServer.json(res, {
      sessionId: body.sessionId,
      messageCount: messages.length,
      resumed: true,
    });
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
