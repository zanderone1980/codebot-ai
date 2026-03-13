/**
 * CodeBot AI — Dashboard REST API
 *
 * Registers API routes on the DashboardServer for the web frontend.
 * Reads from the file-based session/audit storage.
 *
 * ZERO external dependencies — uses only Node.js built-in modules.
 */

import * as fs from 'fs';
import * as path from 'path';
import { DashboardServer } from './server';
import { VERSION } from '../index';
import { PROVIDER_DEFAULTS } from '../providers/registry';
import { SessionManager } from '../history';
import { decryptLine } from '../encryption';
import { UserProfile } from '../user-profile';
import { MemoryManager } from '../memory';
import { loadConfig, saveConfig as saveSetupConfig, isFirstRun, detectLocalServers, SavedConfig } from '../setup';
import { codebotPath } from '../paths';

/** Load API key availability from config + env */
function detectAvailableProviders(): Record<string, boolean> {
  const available: Record<string, boolean> = {};

  // Check ~/.codebot/config.json
  let configProvider = '';
  try {
    const configPath = codebotPath('config.json');
    const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    if (config.apiKey && config.provider) {
      configProvider = config.provider;
    }
  } catch { /* no config */ }

  for (const [name, info] of Object.entries(PROVIDER_DEFAULTS)) {
    const envVal = process.env[info.envKey];
    const hasEnv = !!(envVal && envVal.length > 5);
    const hasConfig = (name === configProvider);
    // Anthropic OAuth fallback
    const hasOAuth = (name === 'anthropic' && !!(process.env.CLAUDE_CODE_OAUTH_TOKEN && process.env.CLAUDE_CODE_OAUTH_TOKEN.length > 5));
    available[name] = hasEnv || hasConfig || hasOAuth;
  }

  return available;
}

/** Register all API routes on the server */
export function registerApiRoutes(server: DashboardServer, projectRoot?: string): void {
  const root = projectRoot || process.cwd();
  const startTime = Date.now();

  // ── Health ──
  server.route('GET', '/api/health', (_req, res) => {
    DashboardServer.json(res, {
      status: 'ok',
      version: VERSION,
      uptime: Math.floor((Date.now() - startTime) / 1000),
      timestamp: new Date().toISOString(),
    });
  });

  // ── Sessions ──
  server.route('GET', '/api/sessions', (req, res) => {
    const query = DashboardServer.parseQuery(req.url || '');
    const page = Math.max(1, parseInt(query.page || '1', 10));
    const limit = Math.min(100, Math.max(1, parseInt(query.limit || '20', 10)));
    const searchTerm = (query.q || '').toLowerCase();

    let sessions = SessionManager.list(100);

    if (searchTerm) {
      sessions = sessions.filter(s =>
        s.preview.toLowerCase().includes(searchTerm) ||
        s.id.includes(searchTerm) ||
        s.model.toLowerCase().includes(searchTerm)
      );
    }

    const start = (page - 1) * limit;
    const paginated = sessions.slice(start, start + limit);

    const items = paginated.map(s => ({
      id: s.id,
      preview: s.preview,
      model: s.model,
      messageCount: s.messageCount,
      createdAt: s.created || null,
      modifiedAt: s.updated || null,
    }));

    DashboardServer.json(res, {
      sessions: items,
      total: sessions.length,
      page,
      limit,
      hasMore: start + limit < sessions.length,
    });
  });

  server.route('GET', '/api/sessions/:id', (_req, res, params) => {
    const sessionsDir = codebotPath('sessions');
    const sessionFile = path.join(sessionsDir, `${params.id}.jsonl`);
    if (!fs.existsSync(sessionFile)) {
      DashboardServer.error(res, 404, 'Session not found');
      return;
    }

    let lines: string[];
    try {
      lines = fs.readFileSync(sessionFile, 'utf-8').split('\n').filter(Boolean);
    } catch (err: any) {
      DashboardServer.error(res, 500, 'Failed to read session: ' + (err.message || 'unknown'));
      return;
    }
    const messages = lines.map(line => {
      try {
        const decrypted = decryptLine(line);
        const obj = JSON.parse(decrypted);
        delete obj._ts;
        delete obj._model;
        delete obj._sig;
        return obj;
      } catch { return null; }
    }).filter(Boolean);

    const toolCalls = messages.filter((m: any) => m.role === 'assistant' && m.tool_calls?.length > 0);
    const stat = safeStatSync(sessionFile);

    const firstUserMsg = messages.find((m: any) => m.role === 'user');
    const preview = firstUserMsg ? String(firstUserMsg.content || '').substring(0, 120) : '';

    DashboardServer.json(res, {
      id: params.id,
      preview,
      messageCount: messages.length,
      toolCallCount: toolCalls.length,
      messages: messages.slice(-200),
      createdAt: stat?.birthtime?.toISOString() || null,
      modifiedAt: stat?.mtime?.toISOString() || null,
    });
  });

  // ── Delete Session ──
  server.route('DELETE', '/api/sessions/:id', (_req, res, params) => {
    const sessionsDir = codebotPath('sessions');
    const sessionFile = path.join(sessionsDir, `${params.id}.jsonl`);
    if (!fs.existsSync(sessionFile)) {
      DashboardServer.error(res, 404, 'Session not found');
      return;
    }

    try {
      fs.unlinkSync(sessionFile);

      // Also remove corresponding audit log if it exists
      const auditFile = path.join(root, '.codebot', 'audit', `${params.id}.jsonl`);
      if (fs.existsSync(auditFile)) {
        fs.unlinkSync(auditFile);
      }

      DashboardServer.json(res, { deleted: true, id: params.id });
    } catch (err: any) {
      DashboardServer.error(res, 500, 'Failed to delete session: ' + (err.message || 'unknown'));
    }
  });

  // ── Batch Delete Sessions ──
  server.route('POST', '/api/sessions/batch-delete', async (req, res) => {
    let parsed: any;
    try {
      parsed = await DashboardServer.parseBody(req);
    } catch (err: any) {
      DashboardServer.error(res, 400, err.message || 'Invalid JSON body');
      return;
    }

    const ids = parsed?.ids;
    if (!Array.isArray(ids) || ids.length === 0) {
      DashboardServer.error(res, 400, 'ids must be a non-empty array');
      return;
    }

    const sessionsDir = codebotPath('sessions');
    let deleted = 0;
    let failed = 0;

    for (const id of ids) {
      const sessionFile = path.join(sessionsDir, `${id}.jsonl`);
      try {
        if (fs.existsSync(sessionFile)) {
          fs.unlinkSync(sessionFile);
          const auditFile = path.join(root, '.codebot', 'audit', `${id}.jsonl`);
          if (fs.existsSync(auditFile)) fs.unlinkSync(auditFile);
          deleted++;
        }
      } catch { failed++; }
    }

    DashboardServer.json(res, { deleted, failed, total: ids.length });
  });

  // ── Setup / Onboarding ──
  server.route('GET', '/api/setup/status', (_req, res) => {
    const config = loadConfig();
    DashboardServer.json(res, {
      configured: !isFirstRun(),
      firstRunComplete: !!config.firstRunComplete,
      provider: config.provider || null,
      model: config.model || null,
      hasApiKey: !!config.apiKey,
    });
  });

  server.route('GET', '/api/setup/detect', async (_req, res) => {
    // Detect available providers: env vars + local servers
    const envProviders: string[] = [];
    for (const [name, info] of Object.entries(PROVIDER_DEFAULTS)) {
      const envVal = process.env[info.envKey];
      if (envVal && envVal.length > 5) envProviders.push(name);
    }
    if (process.env.CLAUDE_CODE_OAUTH_TOKEN) envProviders.push('anthropic');

    let localServers: Array<{ name: string; url: string; models: string[] }> = [];
    try {
      localServers = await detectLocalServers();
    } catch {}

    DashboardServer.json(res, { envProviders, localServers });
  });

  server.route('POST', '/api/setup/provider', async (req, res) => {
    let body: { provider?: string; model?: string; apiKey?: string; baseUrl?: string };
    try {
      body = (await DashboardServer.parseBody(req)) as typeof body;
    } catch {
      DashboardServer.error(res, 400, 'Invalid JSON body');
      return;
    }

    if (!body?.provider) {
      DashboardServer.error(res, 400, 'Missing provider');
      return;
    }

    const config: SavedConfig = loadConfig();
    config.provider = body.provider;
    if (body.model) config.model = body.model;
    if (body.apiKey) config.apiKey = body.apiKey;
    if (body.baseUrl) config.baseUrl = body.baseUrl;
    saveSetupConfig(config);

    DashboardServer.json(res, { saved: true, provider: config.provider, model: config.model });
  });

  server.route('POST', '/api/setup/complete', async (_req, res) => {
    const config: SavedConfig = loadConfig();
    config.firstRunComplete = true;
    saveSetupConfig(config);
    DashboardServer.json(res, { complete: true });
  });

  // ── User Profile ──
  const userProfile = new UserProfile();

  server.route('GET', '/api/profile', (_req, res) => {
    DashboardServer.json(res, { profile: userProfile.getData() });
  });

  server.route('POST', '/api/profile', async (req, res) => {
    let body: Record<string, unknown>;
    try {
      body = (await DashboardServer.parseBody(req)) as Record<string, unknown>;
    } catch {
      DashboardServer.error(res, 400, 'Invalid JSON body');
      return;
    }

    if (body.preferences) {
      userProfile.updatePreferences(body.preferences as Record<string, string>);
    }

    DashboardServer.json(res, { updated: true, profile: userProfile.getData() });
  });

  // ── Memory ──
  const memoryManager = new MemoryManager(root);

  server.route('GET', '/api/memory', (_req, res) => {
    const files = memoryManager.list();
    DashboardServer.json(res, {
      files,
      global: memoryManager.readGlobal(),
      project: memoryManager.readProject(),
    });
  });

  server.route('GET', '/api/memory/', (req, res) => {
    const url = new URL(req.url || '', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    // api/memory/<scope>/<file>
    const scope = parts[2] || '';
    const file = parts[3] || '';

    if (!scope || !file) {
      DashboardServer.error(res, 400, 'Missing scope or file');
      return;
    }

    const memDir = scope === 'project'
      ? path.join(root, '.codebot', 'memory')
      : codebotPath('memory');

    const filePath = path.join(memDir, file.endsWith('.md') ? file : file + '.md');

    try {
      if (fs.existsSync(filePath)) {
        const content = fs.readFileSync(filePath, 'utf-8');
        DashboardServer.json(res, { scope, file, content });
      } else {
        DashboardServer.error(res, 404, 'Memory file not found');
      }
    } catch (err) {
      DashboardServer.error(res, 500, 'Failed to read memory file');
    }
  });

  server.route('POST', '/api/memory/', async (req, res) => {
    const url = new URL(req.url || '', 'http://localhost');
    const parts = url.pathname.split('/').filter(Boolean);
    const scope = parts[2] || '';
    const file = parts[3] || '';

    if (!scope || !file) {
      DashboardServer.error(res, 400, 'Missing scope or file');
      return;
    }

    let body: { content?: string };
    try {
      body = (await DashboardServer.parseBody(req)) as typeof body;
    } catch {
      DashboardServer.error(res, 400, 'Invalid JSON body');
      return;
    }

    if (typeof body?.content !== 'string') {
      DashboardServer.error(res, 400, 'Missing "content" field');
      return;
    }

    const memDir = scope === 'project'
      ? path.join(root, '.codebot', 'memory')
      : codebotPath('memory');

    fs.mkdirSync(memDir, { recursive: true });
    const filePath = path.join(memDir, file.endsWith('.md') ? file : file + '.md');

    try {
      fs.writeFileSync(filePath, body.content);
      DashboardServer.json(res, { saved: true, scope, file });
    } catch (err) {
      DashboardServer.error(res, 500, 'Failed to write memory file');
    }
  });

  // ── Audit ──
  server.route('GET', '/api/audit', (req, res) => {
    const query = DashboardServer.parseQuery(req.url || '');
    const days = Math.max(1, parseInt(query.days || '7', 10));
    const cutoff = Date.now() - days * 86400 * 1000;

    const auditDir = path.join(root, '.codebot', 'audit');
    const entries = loadAuditEntries(auditDir, cutoff);

    DashboardServer.json(res, {
      entries: entries.slice(-500), // Last 500 entries
      total: entries.length,
      days,
    });
  });

  // NOTE: /api/audit/verify must be registered before /api/audit/:sessionId
  server.route('GET', '/api/audit/verify', (_req, res) => {
    const auditDir = path.join(root, '.codebot', 'audit');
    const entries = loadAuditEntries(auditDir, 0);

    let valid = 0;
    let invalid = 0;
    for (let i = 1; i < entries.length; i++) {
      if (entries[i].prevHash && entries[i].prevHash !== entries[i - 1].hash) {
        invalid++;
      } else {
        valid++;
      }
    }

    DashboardServer.json(res, {
      totalEntries: entries.length,
      valid: valid + (entries.length > 0 ? 1 : 0), // First entry is always valid
      invalid,
      chainIntegrity: invalid === 0 ? 'verified' : 'broken',
    });
  });

  server.route('GET', '/api/audit/:sessionId', (_req, res, params) => {
    const auditDir = path.join(root, '.codebot', 'audit');
    const entries = loadAuditEntries(auditDir, 0).filter(
      (e: any) => e.sessionId === params.sessionId
    );

    // Verify chain integrity
    let chainValid = true;
    for (let i = 1; i < entries.length; i++) {
      if (entries[i].prevHash && entries[i].prevHash !== entries[i - 1].hash) {
        chainValid = false;
        break;
      }
    }

    DashboardServer.json(res, {
      sessionId: params.sessionId,
      entries,
      chainValid,
      entryCount: entries.length,
    });
  });

  // ── Metrics ──
  server.route('GET', '/api/metrics/summary', (_req, res) => {
    const sessionsDir = path.join(root, '.codebot', 'sessions');
    const auditDir = path.join(root, '.codebot', 'audit');

    const sessionCount = listSessionFiles(sessionsDir).length;
    const auditEntries = loadAuditEntries(auditDir, 0);

    // Aggregate audit stats
    const toolCounts: Record<string, number> = {};
    const actionCounts: Record<string, number> = {};
    for (const entry of auditEntries) {
      const tool = entry.tool || 'unknown';
      const action = entry.action || 'unknown';
      toolCounts[tool] = (toolCounts[tool] || 0) + 1;
      actionCounts[action] = (actionCounts[action] || 0) + 1;
    }

    DashboardServer.json(res, {
      sessions: sessionCount,
      auditEntries: auditEntries.length,
      toolUsage: toolCounts,
      actionBreakdown: actionCounts,
    });
  });

  // ── Usage ──
  server.route('GET', '/api/usage', (_req, res) => {
    // Return a usage summary from available sessions
    const sessionsDir = path.join(root, '.codebot', 'sessions');
    const sessions = listSessionFiles(sessionsDir).slice(-10); // Last 10 sessions

    const usage = sessions.map(f => {
      const id = path.basename(f, '.jsonl');
      const stat = safeStatSync(f);
      const lines = safeReadLines(f);
      return {
        sessionId: id,
        messageCount: lines.length,
        date: stat?.mtime?.toISOString() || null,
      };
    });

    DashboardServer.json(res, { usage });
  });

  // ── SARIF Export ──
  server.route('POST', '/api/audit/export', async (_req, res) => {
    const auditDir = path.join(root, '.codebot', 'audit');
    const entries = loadAuditEntries(auditDir, 0);

    // Build a simplified SARIF-like export
    DashboardServer.json(res, {
      format: 'sarif-summary',
      version: VERSION,
      exportedAt: new Date().toISOString(),
      entryCount: entries.length,
      entries: entries.slice(-1000),
    });
  });


  // ── Constitutional Safety (CORD + VIGIL) ──
  server.route('GET', '/api/constitutional', (_req, res) => {
    // Return constitutional metrics if available
    const metrics = (server as unknown as Record<string, unknown>)._constitutionalMetrics;
    if (!metrics) {
      DashboardServer.json(res, {
        enabled: false,
        message: 'Constitutional layer not active. Start CodeBot with an agent to see CORD metrics.',
      });
      return;
    }
    DashboardServer.json(res, { enabled: true, ...metrics });
  });

  // -- Swarm API --

  // Default models per provider (best representative model)
  const PROVIDER_MODELS: Record<string, string> = {
    anthropic: 'claude-sonnet-4-6',
    openai: 'gpt-4o',
    gemini: 'gemini-2.5-pro',
    deepseek: 'deepseek-chat',
    groq: 'llama-3.3-70b-versatile',
    mistral: 'mistral-large-latest',
    xai: 'grok-3',
  };

  const providerAvailability = detectAvailableProviders();

  server.route('GET', '/api/swarm/providers', async (_req, res) => {
    const providers = Object.entries(PROVIDER_DEFAULTS).map(([name, info]) => ({
      name,
      envKey: info.envKey,
      available: providerAvailability[name] || false,
      defaultModel: PROVIDER_MODELS[name] || name,
    }));

    // Detect Ollama on localhost:11434
    try {
      const ollamaRes = await fetch('http://localhost:11434/v1/models', {
        signal: AbortSignal.timeout(2000),
      });
      if (ollamaRes.ok) {
        const data = await ollamaRes.json() as { data?: Array<{ id: string }> };
        const models = (data.data || []).map((m: { id: string }) => m.id);
        const textModels = models.filter((m: string) => !/-vl/i.test(m));
        const pool = textModels.length > 0 ? textModels : models;
        const bestModel = pool.find((m: string) => /qwen.*coder|deepseek-coder|codellama/i.test(m))
          || pool.find((m: string) => /qwen|deepseek|llama|mistral|phi/i.test(m))
          || pool[0] || 'unknown';
        providers.push({
          name: 'ollama',
          envKey: '',
          available: true,
          defaultModel: bestModel,
        });
      }
    } catch { /* Ollama not running */ }

    DashboardServer.json(res, { providers });
  });


  let activeSwarm: import('../swarm').SwarmOrchestrator | null = null;

  server.route('GET', '/api/swarm/status', (_req, res) => {
    if (!activeSwarm) {
      DashboardServer.json(res, { active: false, swarm: null });
      return;
    }
    DashboardServer.json(res, { active: true, swarm: activeSwarm.getState() });
  });

  server.route('GET', '/api/swarm/scores', (_req, res) => {
    if (!activeSwarm) {
      DashboardServer.json(res, { scores: [] });
      return;
    }
    DashboardServer.json(res, { scores: activeSwarm.getScorer().getAllPerformance() });
  });

  server.route('GET', '/api/swarm/bus', (req, res) => {
    if (!activeSwarm) {
      DashboardServer.json(res, { messages: [] });
      return;
    }
    const query = DashboardServer.parseQuery(req.url || '');
    let messages = activeSwarm.getBus().getAllMessages();
    if (query.type) {
      messages = messages.filter((m: { type: string }) => m.type === query.type);
    }
    if (query.role) {
      messages = messages.filter((m: { fromRole: string }) => m.fromRole === query.role);
    }
    DashboardServer.json(res, { messages });
  });

  /** Setter for external code to register the active swarm */
  (server as unknown as Record<string, unknown>)._setActiveSwarm = (swarm: import('../swarm').SwarmOrchestrator | null) => {
    activeSwarm = swarm;
  };
}

// ── File system helpers (fail-safe) ──

function listSessionFiles(dir: string): string[] {
  try {
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => path.join(dir, f))
      .sort((a, b) => {
        const sa = safeStatSync(a);
        const sb = safeStatSync(b);
        return (sb?.mtimeMs || 0) - (sa?.mtimeMs || 0);
      });
  } catch {
    return [];
  }
}

function loadAuditEntries(dir: string, cutoffMs: number): any[] {
  try {
    if (!fs.existsSync(dir)) return [];
    const files = fs.readdirSync(dir)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => path.join(dir, f));

    const entries: any[] = [];
    for (const file of files) {
      const lines = safeReadLines(file);
      for (const line of lines) {
        try {
          const entry = JSON.parse(line);
          if (cutoffMs > 0 && entry.timestamp) {
            const ts = new Date(entry.timestamp).getTime();
            if (ts < cutoffMs) continue;
          }
          entries.push(entry);
        } catch { /* skip malformed lines */ }
      }
    }
    return entries;
  } catch {
    return [];
  }
}

function safeStatSync(filePath: string): fs.Stats | null {
  try { return fs.statSync(filePath); } catch { return null; }
}

function safeReadLines(filePath: string): string[] {
  try {
    return fs.readFileSync(filePath, 'utf-8').split('\n').filter(Boolean);
  } catch {
    return [];
  }
}
