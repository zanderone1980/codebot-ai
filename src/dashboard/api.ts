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
import * as os from 'os';
import { DashboardServer } from './server';
import { VERSION } from '../index';
import { PROVIDER_DEFAULTS } from '../providers/registry';

/** Load API key availability from config + env */
function detectAvailableProviders(): Record<string, boolean> {
  const available: Record<string, boolean> = {};

  // Check ~/.codebot/config.json
  let configProvider = '';
  try {
    const configPath = path.join(os.homedir(), '.codebot', 'config.json');
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

    const sessionsDir = path.join(root, '.codebot', 'sessions');
    const sessions = listSessionFiles(sessionsDir);

    const start = (page - 1) * limit;
    const paginated = sessions.slice(start, start + limit);

    const items = paginated.map(f => {
      const id = path.basename(f, '.jsonl');
      const stat = safeStatSync(f);
      return {
        id,
        createdAt: stat?.birthtime?.toISOString() || null,
        modifiedAt: stat?.mtime?.toISOString() || null,
        sizeBytes: stat?.size || 0,
      };
    });

    DashboardServer.json(res, {
      sessions: items,
      total: sessions.length,
      page,
      limit,
      hasMore: start + limit < sessions.length,
    });
  });

  server.route('GET', '/api/sessions/:id', (_req, res, params) => {
    const sessionFile = path.join(root, '.codebot', 'sessions', `${params.id}.jsonl`);
    if (!fs.existsSync(sessionFile)) {
      DashboardServer.error(res, 404, 'Session not found');
      return;
    }

    const lines = fs.readFileSync(sessionFile, 'utf-8').split('\n').filter(Boolean);
    const messages = lines.map(line => {
      try { return JSON.parse(line); } catch { return null; }
    }).filter(Boolean);

    // Extract summary stats
    const toolCalls = messages.filter((m: any) => m.role === 'assistant' && m.tool_calls?.length > 0);
    const stat = safeStatSync(sessionFile);

    DashboardServer.json(res, {
      id: params.id,
      messageCount: messages.length,
      toolCallCount: toolCalls.length,
      messages: messages.slice(-200), // Last 200 messages
      createdAt: stat?.birthtime?.toISOString() || null,
      modifiedAt: stat?.mtime?.toISOString() || null,
    });
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

  server.route('GET', '/api/swarm/providers', (_req, res) => {
    const providers = Object.entries(PROVIDER_DEFAULTS).map(([name, info]) => ({
      name,
      envKey: info.envKey,
      available: providerAvailability[name] || false,
      defaultModel: PROVIDER_MODELS[name] || name,
    }));
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
