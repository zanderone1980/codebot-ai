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
import { SwarmOrchestrator, SwarmStrategyType, ProviderSlot, AgentFactory, SwarmAgent, AgentRunResult } from '../swarm';
import { AgentRole, buildRoleSystemPrompt } from '../swarm/roles';
import { PROVIDER_DEFAULTS } from '../providers/registry';
import { AnthropicProvider } from '../providers/anthropic';
import { OpenAIProvider } from '../providers/openai';
import { LLMProvider, Message } from '../types';
import { getProactiveEngine } from '../proactive';
import { loadWorkflows, getWorkflow, resolveWorkflowPrompt, WORKFLOW_CATEGORIES } from '../workflows';

/** Load API keys from ~/.codebot/config.json + environment */
function loadApiKeys(): Record<string, string> {
  const keys: Record<string, string> = {};

  // 1. Read from ~/.codebot/config.json
  try {
    const configPath = codebotPath('config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (config.apiKey && config.provider) {
      const providerInfo = PROVIDER_DEFAULTS[config.provider];
      if (providerInfo) {
        keys[providerInfo.envKey] = config.apiKey;
      }
    }
  } catch { /* no config */ }

  // 2. Environment variables override config
  for (const [, info] of Object.entries(PROVIDER_DEFAULTS)) {
    const envVal = process.env[info.envKey];
    if (envVal && envVal.length > 5) {
      keys[info.envKey] = envVal;
    }
  }

  // 3. Check for OAuth token as Anthropic fallback
  const oauthToken = process.env.CLAUDE_CODE_OAUTH_TOKEN;
  if (oauthToken && oauthToken.length > 5 && !keys['ANTHROPIC_API_KEY']) {
    keys['ANTHROPIC_API_KEY'] = oauthToken;
  }

  return keys;
}

const API_KEYS = loadApiKeys();

/** Default models per provider */
const SWARM_MODELS: Record<string, string> = {
  anthropic: 'claude-sonnet-4-6',
  openai: 'gpt-4o',
  gemini: 'gemini-2.5-pro',
  deepseek: 'deepseek-chat',
  groq: 'llama-3.3-70b-versatile',
  mistral: 'mistral-large-latest',
  xai: 'grok-3',
};

/** Provider tiers for the swarm router */
const PROVIDER_TIERS: Record<string, 'fast' | 'standard' | 'powerful'> = {
  anthropic: 'powerful',
  openai: 'powerful',
  gemini: 'powerful',
  deepseek: 'standard',
  groq: 'fast',
  mistral: 'standard',
  xai: 'powerful',
};

/** Check if a provider has a usable API key */
function hasApiKey(name: string): boolean {
  const info = PROVIDER_DEFAULTS[name];
  if (!info) return false;
  return !!(API_KEYS[info.envKey]);
}

/** Cached Ollama model (detected at runtime) */
let _ollamaModel: string | null = null;

/** Detect best Ollama model */
async function detectOllamaModel(): Promise<string | null> {
  if (_ollamaModel) return _ollamaModel;
  try {
    const res = await fetch('http://localhost:11434/v1/models', {
      signal: AbortSignal.timeout(2000),
    });
    if (!res.ok) return null;
    const data = await res.json() as { data?: Array<{ id: string }> };
    const models = (data.data || []).map((m: { id: string }) => m.id);
    if (models.length === 0) return null;
    // Prefer coding/text models (avoid -vl vision variants for text tasks)
    const textModels = models.filter((m: string) => !/-vl/i.test(m));
    const pool = textModels.length > 0 ? textModels : models;
    _ollamaModel = pool.find((m: string) => /qwen.*coder|deepseek-coder|codellama/i.test(m))
      || pool.find((m: string) => /qwen|deepseek|llama|mistral|phi/i.test(m))
      || pool[0];
    return _ollamaModel;
  } catch { return null; }
}

/** Build a ProviderSlot from a provider name (returns null if unavailable) */
function buildProviderSlot(name: string, ollamaModel?: string): ProviderSlot | null {
  // Ollama — no API key needed, runs on localhost
  if (name === 'ollama') {
    const model = ollamaModel || _ollamaModel || 'llama3.1:8b';
    const provider = new OpenAIProvider({
      baseUrl: 'http://localhost:11434',
      apiKey: 'ollama',  // Ollama doesn't need a real key
      model,
    });
    return {
      providerName: 'ollama',
      model,
      provider,
      tier: 'standard' as const,
    };
  }

  const info = PROVIDER_DEFAULTS[name];
  if (!info) return null;
  const apiKey = API_KEYS[info.envKey];
  if (!apiKey) return null;

  const model = SWARM_MODELS[name] || name;
  const baseUrl = (name === 'anthropic' && process.env.ANTHROPIC_BASE_URL)
    ? process.env.ANTHROPIC_BASE_URL
    : info.baseUrl;

  // Anthropic uses its own provider class; everything else uses OpenAI-compatible
  const provider = name === 'anthropic'
    ? new AnthropicProvider({ baseUrl, apiKey, model })
    : new OpenAIProvider({ baseUrl, apiKey, model });

  return {
    providerName: name,
    model,
    provider,
    tier: PROVIDER_TIERS[name] || 'standard',
  };
}

/** Real SwarmAgent that calls LLM providers */
class LLMSwarmAgent implements SwarmAgent {
  id: string;
  role: AgentRole;
  model: string;
  providerName: string;
  status: 'idle' | 'running' | 'complete' | 'error' = 'idle';
  depth = 0;
  private provider: LLMProvider;
  private systemPrompt: string;

  constructor(
    role: AgentRole,
    model: string,
    providerName: string,
    provider: LLMProvider,
    systemPromptSuffix: string,
  ) {
    this.id = '';
    this.role = role;
    this.model = model;
    this.providerName = providerName;
    this.provider = provider;
    this.systemPrompt = `You are a ${role} agent in a multi-agent swarm. ${systemPromptSuffix}\nBe concise and focused. Provide your analysis or output directly.`;
  }

  async run(prompt: string): Promise<AgentRunResult> {
    this.status = 'running';
    const startMs = Date.now();
    let output = '';
    let inputTokens = 0;
    let outputTokens = 0;

    const messages: Message[] = [
      { role: 'system', content: this.systemPrompt },
      { role: 'user', content: prompt },
    ];

    try {
      for await (const event of this.provider.chat(messages)) {
        if (event.type === 'text') {
          output += event.text || '';
        } else if (event.type === 'usage') {
          const u = event as unknown as Record<string, unknown>;
          inputTokens = (u.inputTokens as number) || 0;
          outputTokens = (u.outputTokens as number) || 0;
        } else if (event.type === 'error') {
          output += `[Error: ${(event as unknown as Record<string, unknown>).error || 'unknown'}]`;
          this.status = 'error';
          break;
        }
      }
      if (this.status !== 'error') this.status = 'complete';
    } catch (err: unknown) {
      output = `Error: ${err instanceof Error ? err.message : String(err)}`;
      this.status = 'error';
    }

    return {
      output,
      toolCalls: [],
      filesModified: [],
      durationMs: Date.now() - startMs,
      tokenUsage: { input: inputTokens, output: outputTokens },
      errors: this.status === 'error' ? 1 : 0,
    };
  }
}

/** Create a real AgentFactory from available ProviderSlots */
function createAgentFactory(slots: ProviderSlot[]): AgentFactory {
  const slotMap = new Map<string, ProviderSlot>();
  for (const s of slots) slotMap.set(s.providerName, s);

  return (
    role: AgentRole,
    model: string,
    providerName: string,
    systemPromptSuffix: string,
    _allowedTools: string[],
    _maxIterations: number,
  ): SwarmAgent => {
    const slot = slotMap.get(providerName) || slots[0];
    return new LLMSwarmAgent(role, model, providerName, slot.provider, systemPromptSuffix);
  };
}

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

    let body: { message?: string; mode?: 'simple' | 'detailed' };
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

    // Simple mode: prepend plain-language instruction for non-technical users
    let userMessage = body.message;
    if (body.mode === 'simple') {
      userMessage = '[Respond in plain, simple language suitable for someone who is not a programmer. Be concise and friendly. Focus on results, not technical details.]\n\n' + userMessage;
    }

    agentBusy = true;
    DashboardServer.sseHeaders(res);

    let closed = false;
    res.on('close', () => { closed = true; });

    try {
      for await (const event of agent.run(userMessage)) {
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

  // ── POST /api/command/swarm (direct SwarmOrchestrator invocation) ──
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

    if (agentBusy) {
      DashboardServer.error(res, 409, 'Agent is busy processing another request');
      return;
    }

    // Detect Ollama model if ollama is in the provider list
    if (body.providers.includes('ollama')) {
      await detectOllamaModel();
    }

    // Build ProviderSlots from selected provider names
    const slots: ProviderSlot[] = [];
    for (const name of body.providers) {
      const slot = buildProviderSlot(name);
      if (slot) slots.push(slot);
    }

    if (slots.length === 0) {
      DashboardServer.error(res, 400, 'None of the selected providers have API keys configured. Set environment variables (e.g. OPENAI_API_KEY) and restart.');
      return;
    }

    // Get policy + metrics from agent if available, otherwise create minimal ones
    let policyEnforcer: import('../policy').PolicyEnforcer;
    let metrics: import('../metrics').MetricsCollector;
    if (agent) {
      policyEnforcer = agent.getPolicyEnforcer();
      metrics = agent.getMetrics();
    } else {
      const { PolicyEnforcer: PE, loadPolicy } = require('../policy');
      const { MetricsCollector: MC } = require('../metrics');
      policyEnforcer = new PE(loadPolicy(process.cwd()), process.cwd());
      metrics = new MC();
    }

    const strategy = (body.strategy || 'auto') as SwarmStrategyType;

    // Create SwarmOrchestrator with real agent factory
    const swarm = new SwarmOrchestrator(policyEnforcer, metrics, {
      providers: slots,
      strategyOverride: strategy === 'auto' ? null : strategy,
      maxTotalAgents: 10,
      maxConcurrentAgents: 4,
      agentTimeoutMs: 120_000,
    });
    swarm.setAgentFactory(createAgentFactory(slots));

    agentBusy = true;
    DashboardServer.sseHeaders(res);

    let closed = false;
    res.on('close', () => { closed = true; });

    try {
      for await (const event of swarm.execute(body.task, {
        preferredStrategy: strategy,
      })) {
        if (closed) break;

        // Map SwarmEvents to SSE-friendly format for the dashboard
        if (event.type === 'swarm_start') {
          DashboardServer.sseSend(res, { type: 'text', text: `Swarm started. Analyzing task...\n` });
        } else if (event.type === 'strategy_selected') {
          const d = event.data as Record<string, unknown>;
          const assignments = (d?.assignments as Array<{ role: string; providerSlot: { model: string } }>) || [];
          const agentList = assignments.map(a => `${a.role} (${a.providerSlot.model})`).join(', ');
          DashboardServer.sseSend(res, { type: 'text', text: `Strategy: ${d?.strategy || strategy}\nAgents: ${agentList}\n\n` });
        } else if (event.type === 'agent_spawn') {
          DashboardServer.sseSend(res, { type: 'text', text: `Agent spawned: ${event.role || 'agent'} on ${event.model || 'unknown'}\n` });
        } else if (event.type === 'agent_complete') {
          // Get the output from the context bus since strategies post contributions there
          const bus = swarm.getBus();
          const msgs = bus.getAllMessages().filter(m => m.fromAgentId === event.agentId && m.type === 'contribution');
          const lastMsg = msgs[msgs.length - 1];
          const content = lastMsg?.payload?.content || '';
          const d = event.data as Record<string, unknown>;
          const dur = d?.durationMs ? ` (${Math.round(d.durationMs as number / 1000)}s)` : '';
          DashboardServer.sseSend(res, { type: 'text', text: `\n--- ${(event.role || 'agent').toUpperCase()} (${event.model || ''})${dur} ---\n${content}\n` });
        } else if (event.type === 'agent_error') {
          const d = event.data as Record<string, unknown>;
          DashboardServer.sseSend(res, { type: 'text', text: `\n[Agent Error: ${d?.error || 'unknown'}]\n` });
        } else if (event.type === 'swarm_complete') {
          const d = event.data as Record<string, unknown>;
          DashboardServer.sseSend(res, { type: 'text', text: `\n=== Swarm Complete ===\nAgents: ${d?.totalAgents || 0} | Time: ${Math.round((d?.elapsed as number || 0) / 1000)}s\n` });
        } else if (event.type === 'swarm_error') {
          const d = event.data as Record<string, unknown>;
          DashboardServer.sseSend(res, { type: 'error', text: `Swarm error: ${d?.error || 'unknown'}` });
        } else if (event.type === 'round_start' || event.type === 'round_end') {
          DashboardServer.sseSend(res, { type: 'text', text: `\n[Round ${event.round ?? '?'}${event.type === 'round_end' ? ' complete' : ' starting'}]\n` });
        } else if (event.type === 'synthesis') {
          const d = event.data as Record<string, unknown>;
          DashboardServer.sseSend(res, { type: 'text', text: `\n--- SYNTHESIS ---\n${d?.content || ''}\n` });
        }
      }

      // Final done event
      if (!closed) {
        DashboardServer.sseSend(res, { type: 'done' });
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

  // ── GET /api/notifications ──
  server.route('GET', '/api/notifications', (_req, res) => {
    const engine = getProactiveEngine();
    DashboardServer.json(res, {
      notifications: engine.getAll(),
      unreadCount: engine.getUnreadCount(),
    });
  });

  // ── POST /api/notifications/:id/dismiss ──
  server.route('POST', '/api/notifications/', async (req, res) => {
    const url = new URL(req.url || '', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    // api/notifications/<id>/dismiss  OR  api/notifications/dismiss-all
    const engine = getProactiveEngine();

    if (parts[2] === 'dismiss-all') {
      const count = engine.dismissAll();
      DashboardServer.json(res, { dismissed: count });
      return;
    }

    const id = parts[2] || '';
    const action = parts[3] || '';

    if (action === 'dismiss') {
      const ok = engine.dismiss(id);
      DashboardServer.json(res, { dismissed: ok });
    } else if (action === 'read') {
      const ok = engine.markRead(id);
      DashboardServer.json(res, { read: ok });
    } else {
      DashboardServer.error(res, 400, 'Unknown action. Use /dismiss or /read');
    }
  });

  // ── GET /api/notifications/stream (SSE) ──
  server.route('GET', '/api/notifications/stream', (_req, res) => {
    DashboardServer.sseHeaders(res);
    const engine = getProactiveEngine();

    const listener = (notification: unknown) => {
      if (res.writable) {
        DashboardServer.sseSend(res, { type: 'notification', notification });
      }
    };

    engine.onNotification(listener);

    res.on('close', () => {
      engine.removeListener(listener);
    });

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
  server.route('GET', '/api/workflows/', (req, res) => {
    const url = new URL(req.url || '', 'http://localhost');
    const parts = url.pathname.split('/');
    const name = parts[parts.length - 1];
    if (!name) {
      DashboardServer.error(res, 400, 'Missing workflow name');
      return;
    }
    const workflow = getWorkflow(name);
    if (!workflow) {
      DashboardServer.error(res, 404, 'Workflow "' + name + '" not found');
      return;
    }
    DashboardServer.json(res, { workflow });
  });

  // ── POST /api/workflows/:name/run (SSE stream) ──
  server.route('POST', '/api/workflows/', async (req, res) => {
    if (!agent) {
      DashboardServer.error(res, 503, 'Agent not available');
      return;
    }

    // Extract workflow name from URL path
    const url = new URL(req.url || '', 'http://localhost');
    const pathParts = url.pathname.split('/').filter(Boolean);
    // Expected: api, workflows, <name>, run
    const name = pathParts.length >= 3 ? pathParts[2] : '';

    const workflow = getWorkflow(name);
    if (!workflow) {
      DashboardServer.error(res, 404, 'Workflow "' + name + '" not found');
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
      agentBusy = false;
      if (!closed) DashboardServer.sseClose(res);
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
