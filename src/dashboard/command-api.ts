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
import { SessionManager } from '../history';
import { BLOCKED_PATTERNS, FILTERED_ENV_VARS } from '../tools/execute';
import { AuditLogger } from '../audit';
import { PROVIDER_DEFAULTS } from '../providers/registry';
import { Config } from '../types';
import { loadConfig, pickProviderKey, normalizeProviderBaseUrl } from '../setup';
import { createProvider } from '../cli/config';
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
  // Dashboard-local audit logger used for /api/command/exec when no agent
  // is available (standalone mode). When an agent IS available we reuse its
  // session-scoped logger so dashboard exec entries sit in the same
  // hash-chained stream as agent tool calls — one trail per session.
  const standaloneAuditor = new AuditLogger();
  let agentBusy = false;
  // Each queue entry owns its own pending HTTP response. When its turn comes,
  // processQueue() invokes run() which streams the agent output back on that
  // response. Previously we stored a dangling Promise.resolve and the output
  // was silently discarded — the UI sat on "Message queued" forever.
  const messageQueue: Array<{ run: () => Promise<void>; cancelled: boolean }> = [];
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
    // Skip cancelled entries (client disconnected while queued)
    while (messageQueue.length > 0 && messageQueue[0].cancelled) messageQueue.shift();
    if (messageQueue.length === 0) {
      broadcastStatus('idle');
      return;
    }
    const next = messageQueue.shift()!;
    try {
      await next.run();
    } catch {
      // run() handles its own errors; nothing more to do here
    }
    // run() sets agentBusy back to false and chains setTimeout(processQueue)
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
  //
  // 2026-04-23 hardening (external-review response):
  //   This endpoint used to call `tool.execute(body.args || {})` directly,
  //   bypassing the ENTIRE safety pipeline — no arg validation, no
  //   capability check (fs_write / shell_commands / net_access), no risk
  //   score, no CORD constitutional check, no audit entry. The agent's
  //   own run() went through every one of those before executing the
  //   same tool. That's the exact gap we sell against.
  //
  //   Now the endpoint calls `agent.evaluateToolCall()` — the shared
  //   pipeline method used by run() — and audits both attempt and
  //   outcome with action='dashboard_tool_run_*' so dashboard-initiated
  //   calls are distinguishable from agent-initiated ones in the audit
  //   trail.
  server.route('POST', '/api/command/tool/run', async (req, res) => {
    if (!agent) {
      DashboardServer.error(res, 503, 'Agent not available');
      return;
    }

    let body: { tool?: string; args?: Record<string, unknown> };
    try {
      body = (await DashboardServer.parseBody(req)) as typeof body;
    } catch (err: any) {
      DashboardServer.error(res, 400, err.message || 'Invalid JSON body');
      return;
    }

    if (!body?.tool) {
      DashboardServer.error(res, 400, 'Missing "tool" field');
      return;
    }

    const toolName = body.tool;
    const args = body.args || {};
    const auditor = agent.getAuditLogger();

    // Safety pipeline: arg validation → capability → risk → CORD.
    // Audit actions are constrained to the AuditLogger union
    // ('error' | 'execute' | 'deny' | 'security_block' | 'policy_block' |
    // 'capability_block' | 'constitutional_block'); dashboard-initiated
    // calls are distinguished by tool='dashboard_tool_run' + args.tool.
    const verdict = agent.evaluateToolCall(toolName, args);
    if (!verdict.allowed) {
      const auditAction: 'deny' | 'capability_block' | 'constitutional_block' =
        verdict.category === 'capability_block' ? 'capability_block' :
        verdict.category === 'constitutional_block' ? 'constitutional_block' :
        'deny';
      auditor.log({
        tool: 'dashboard_tool_run',
        action: auditAction,
        args: { tool: toolName, args },
        reason: verdict.reason,
      });
      const status =
        verdict.category === 'unknown_tool' ? 404 :
        verdict.category === 'invalid_args' ? 400 :
        403;
      DashboardServer.error(res, status, verdict.reason || 'Tool call denied');
      return;
    }

    // Execute via the registry (same path the autonomous executor takes).
    const tool = agent.getToolRegistry().get(toolName)!; // evaluateToolCall already verified
    const startMs = Date.now();
    auditor.log({
      tool: 'dashboard_tool_run',
      action: 'execute',
      args: { tool: toolName, args, risk: verdict.risk },
    });
    try {
      const result = await tool.execute(args);
      const isError = typeof result === 'string' && result.startsWith('Error:');
      if (isError) {
        auditor.log({
          tool: 'dashboard_tool_run',
          action: 'error',
          args: { tool: toolName, args },
          result: 'error',
          reason: result.slice(0, 500),
        });
      }
      DashboardServer.json(res, {
        result,
        is_error: isError,
        duration_ms: Date.now() - startMs,
        risk: verdict.risk,
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      auditor.log({
        tool: 'dashboard_tool_run',
        action: 'error',
        args: { tool: toolName, args },
        result: 'error',
        reason: msg,
      });
      DashboardServer.json(res, {
        result: msg,
        is_error: true,
        duration_ms: Date.now() - startMs,
        risk: verdict.risk,
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
  //
  // Also reloads the provider from ~/.codebot/config.json so that a model
  // change from the dashboard dropdown takes effect immediately.  Without
  // this, the agent keeps using the provider it was created with at startup
  // (e.g. OpenAI chat-completions) even after the user selects gpt-5.4,
  // which lives on the Responses API. The old code only cleared conversation
  // history — the wrong provider was still firing.
  server.route('POST', '/api/command/chat/reset', async (_req, res) => {
    if (!agent) {
      DashboardServer.error(res, 503, 'Agent not available');
      return;
    }
    try {
      const saved = normalizeProviderBaseUrl(loadConfig());
      const model = saved.model || 'qwen2.5-coder:32b';
      const providerName = saved.provider || 'local';
      const apiKey = pickProviderKey(saved, providerName);
      let baseUrl = saved.baseUrl || '';
      if (!baseUrl) {
        const defaults = PROVIDER_DEFAULTS[providerName];
        if (defaults) baseUrl = defaults.baseUrl;
      }
      const cfg: Config = {
        model,
        provider: providerName,
        baseUrl,
        apiKey,
        maxIterations: 50,
        autoApprove: false,
      };
      const newProvider = createProvider(cfg);
      agent.setProvider(newProvider, model, providerName);
    } catch {
      // Provider reload failed — fall back to clearing history only.
      agent.resetConversation();
    }
    DashboardServer.json(res, { reset: true });
  });

  // ── GET  /api/command/vault — current vault-mode state ──
  // ── POST /api/command/vault — enable or disable vault mode ──
  //
  // Body: { vaultPath: string, writable?: boolean, networkAllowed?: boolean }
  //   - vaultPath empty/null → disable vault mode, return to coding-agent
  //   - vaultPath set        → validate + chdir + swap tools/prompt
  //
  // Calls Agent.setVaultMode() under the hood; see src/agent.ts for the
  // runtime-swap mechanics.
  server.route('GET', '/api/command/vault', async (_req, res) => {
    if (!agent) {
      DashboardServer.error(res, 503, 'Agent not available');
      return;
    }
    DashboardServer.json(res, { vault: agent.getVaultMode() });
  });

  server.route('POST', '/api/command/vault', async (req, res) => {
    if (!agent) {
      DashboardServer.error(res, 503, 'Agent not available');
      return;
    }
    let body: { vaultPath?: string | null; writable?: boolean; networkAllowed?: boolean };
    try {
      body = (await DashboardServer.parseBody(req)) as typeof body;
    } catch (err: any) {
      DashboardServer.error(res, 400, err.message || 'Invalid JSON body');
      return;
    }

    // Empty path → disable
    const raw = (body?.vaultPath || '').trim();
    if (!raw) {
      agent.setVaultMode(null);
      DashboardServer.json(res, { vault: null, disabled: true });
      return;
    }

    // Validate path: must exist + be a directory
    const homedir = require('os').homedir();
    const fs = require('fs');
    const path = require('path');
    const expanded = raw.startsWith('~') ? raw.replace(/^~/, homedir) : raw;
    const vaultPath = path.resolve(expanded);
    if (!fs.existsSync(vaultPath)) {
      DashboardServer.error(res, 400, `Vault path does not exist: ${vaultPath}`);
      return;
    }
    if (!fs.statSync(vaultPath).isDirectory()) {
      DashboardServer.error(res, 400, `Vault path is not a directory: ${vaultPath}`);
      return;
    }

    const opts = {
      vaultPath,
      writable: !!body?.writable,
      networkAllowed: !!body?.networkAllowed,
    };
    agent.setVaultMode(opts);
    DashboardServer.json(res, { vault: opts, enabled: true });
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
    } catch (err: any) {
      DashboardServer.error(res, 400, err.message || 'Invalid JSON body');
      return;
    }

    if (!body?.message && (!body?.images || body.images.length === 0)) {
      DashboardServer.error(res, 400, 'Missing "message" field');
      return;
    }

    // Simple mode: prepend plain-language instruction for non-technical users
    let userMessage = body.message || '';
    if (body.mode === 'simple') {
      userMessage = '[Respond in plain, simple language suitable for someone who is not a programmer. Be concise and friendly. Focus on results, not technical details.]\n\n' + userMessage;
    }

    const chatImages = body.images?.map((img: { data: string; mediaType: string }) => ({
      data: img.data,
      mediaType: img.mediaType as 'image/png' | 'image/jpeg' | 'image/gif' | 'image/webp',
    }));

    // Open SSE immediately — we hold this response open whether we run now
    // or after waiting in the queue. Client receives {type:'queued'} while
    // waiting, then real events when it's our turn.
    DashboardServer.sseHeaders(res);
    let closed = false;
    res.on('close', () => { closed = true; });

    const heartbeat = setInterval(() => {
      if (closed || res.writableEnded || res.destroyed) { clearInterval(heartbeat); return; }
      try { res.write(': heartbeat\n\n'); } catch { clearInterval(heartbeat); closed = true; }
    }, 15_000);

    // Entry declared early so res.on('close') can mark it cancelled
    let entry: { run: () => Promise<void>; cancelled: boolean } | null = null;
    res.on('close', () => { if (entry) entry.cancelled = true; });

    const runAgent = async () => {
      if (closed || res.writableEnded || res.destroyed) {
        clearInterval(heartbeat);
        return;
      }
      agentBusy = true;
      broadcastStatus('working', { message: body.message });
      try {
        for await (const event of agent!.run(userMessage, chatImages)) {
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
        // Process next in queue
        if (messageQueue.length > 0) setTimeout(processQueue, 100);
      }
    };

    if (agentBusy) {
      // Hold the SSE connection open and wait our turn. Let the client know.
      entry = { run: runAgent, cancelled: false };
      messageQueue.push(entry);
      const position = messageQueue.length;
      DashboardServer.sseSend(res, { type: 'queued', position });
      broadcastStatus('queued', { position });
      return;
    }

    await runAgent();
  });

  // ── POST /api/command/quick-action (works standalone via exec) ──
  server.route('POST', '/api/command/quick-action', async (req, res) => {
    let body: { action?: string };
    try {
      body = (await DashboardServer.parseBody(req)) as typeof body;
    } catch (err: any) {
      DashboardServer.error(res, 400, err.message || 'Invalid JSON body');
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
  //
  // 2026-04-23 hardening (external-review response):
  //   This endpoint used to gate `sh -c` behind BLOCKED_PATTERNS regex only.
  //   Regex blocklists are brittle; a product selling on governance cannot
  //   run shell execution outside its own constitutional pipeline. Updated
  //   to:
  //     1. Audit every exec *attempt* (before any decision).
  //     2. Ask the agent's ConstitutionalLayer (CORD+VIGIL) if the command
  //        should be blocked — same check the agent's own `execute` tool
  //        goes through on the autonomous path.
  //     3. Retain BLOCKED_PATTERNS as a defense-in-depth final gate (so the
  //        standalone-mode path, where no agent and no CORD exist, still
  //        has a last line).
  //     4. Audit the outcome (blocked / executed) with the same
  //        hash-chained logger.
  server.route('POST', '/api/command/exec', async (req, res) => {
    let body: { command?: string; cwd?: string };
    try {
      body = (await DashboardServer.parseBody(req)) as typeof body;
    } catch (err: any) {
      DashboardServer.error(res, 400, err.message || 'Invalid JSON body');
      return;
    }

    if (!body?.command) {
      DashboardServer.error(res, 400, 'Missing "command" field');
      return;
    }

    const command = body.command;
    const cwd = body.cwd;
    const auditor: AuditLogger = agent?.getAuditLogger() ?? standaloneAuditor;

    // 1. Constitutional check (agent mode). CORD sees the same
    //    {tool:'execute', args:{command,cwd}} payload that the agent's own
    //    tool-executor sends, so the same policy applies to both paths.
    const constitutional = agent?.getConstitutional();
    if (constitutional) {
      try {
        const cordResult = constitutional.evaluateAction({
          tool: 'execute',
          args: { command, cwd },
          type: 'exec',
        });
        if (cordResult.decision === 'BLOCK') {
          const reason = cordResult.explanation || cordResult.hardBlockReason || 'Constitutional violation';
          auditor.log({
            tool: 'dashboard_exec',
            action: 'constitutional_block',
            args: { command, cwd },
            reason,
          });
          DashboardServer.error(res, 403, `Blocked by safety policy: ${reason}`);
          return;
        }
      } catch {
        // CORD must not crash the endpoint; fall through to blocklist check.
      }
    }

    // 2. Regex blocklist — defense in depth (and the only gate in standalone
    //    mode, where no constitutional layer exists).
    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(command)) {
        auditor.log({
          tool: 'dashboard_exec',
          action: 'security_block',
          args: { command, cwd },
          reason: `BLOCKED_PATTERNS match: ${pattern.source}`,
        });
        DashboardServer.error(res, 403, 'Blocked: dangerous command pattern detected');
        return;
      }
    }

    // 3. Allowed — record the execution decision (result streams back via SSE).
    auditor.log({
      tool: 'dashboard_exec',
      action: 'execute',
      args: { command, cwd },
    });
    execAndStream(res, command, cwd);
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
    } catch (err: any) {
      DashboardServer.error(res, 400, err.message || 'Invalid JSON body');
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
    } catch (err: any) {
      DashboardServer.error(res, 400, err.message || 'Invalid JSON body');
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
