/**
 * Interactive slash commands for the REPL.
 * Extracted from cli.ts for maintainability.
 */

import { Agent } from '../agent';
import { Config } from '../types';
import { detectProvider } from '../providers/registry';
import { SessionManager } from '../history';
import { EditFileTool } from '../tools';
import { RiskScorer } from '../risk';
import { runDoctor, formatDoctorReport } from '../doctor';
import { loadTheme, setTheme, getTheme, getThemeNames } from '../theme';

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  cyan: '\x1b[36m',
};

function c(text: string, style: keyof typeof C): string {
  return `${C[style]}${text}${C.reset}`;
}

// ── Per-command handlers ────────────────────────────────────────────────────

function cmdHelp() {
  console.log(`${c('Commands:', 'bold')}
  /help      Show this help
  /model     Show or change model (/model <name>)
  /models    List all supported models
  /sessions  List saved sessions
  /clear     Clear conversation history
  /compact   Force context compaction
  /auto      Toggle autonomous mode
  /routines  List scheduled routines
  /undo      Undo last file edit (/undo [path])
  /usage     Show token usage & cost for this session
  /cost      Show running cost
  /metrics   Show session metrics (counters + histograms)
  /risk      Show risk assessment summary
  /policy    Show current security policy
  /audit     Verify audit chain for this session
  /rate      Show provider rate limit utilization
  /theme     Show or change theme (/theme dark|light|mono)
  /doctor    Run environment health check
  /toolcost  Show per-tool cost breakdown
  /apps      Show connected apps & available connectors
  /connect   Connect an app (/connect <app>)
  /config    Show current config
  /quit      Exit`);
}

function cmdModel(agent: Agent, config: Config, rest: string[]) {
  void agent; // accessed via config mutations which agent picks up
  if (rest.length > 0) {
    config.model = rest.join(' ');
    const detected = detectProvider(config.model);
    if (detected) {
      config.provider = detected;
      console.log(c(`Model: ${config.model} (provider: ${detected})`, 'green'));
    } else {
      console.log(c(`Model: ${config.model} (local/ollama)`, 'green'));
    }
  } else {
    console.log(`Current model: ${config.model} (${config.provider})`);
  }
}

function cmdClear(agent: Agent) {
  agent.clearHistory();
  console.log(c('Conversation cleared.', 'dim'));
}

function cmdCompact(agent: Agent) {
  const stats = agent.forceCompact();
  console.log(c(`Context compacted: ${stats.before} → ${stats.after} messages.`, 'dim'));
}

function cmdAuto(agent: Agent, config: Config) {
  config.autoApprove = !config.autoApprove;
  agent.setAutoApprove(config.autoApprove);
  console.log(c(`Autonomous mode: ${config.autoApprove ? 'ON' : 'OFF'}`, config.autoApprove ? 'yellow' : 'green'));
}

function cmdSessions() {
  const sessions = SessionManager.list();
  if (sessions.length === 0) {
    console.log(c('No saved sessions.', 'dim'));
    return;
  }
  console.log(c('\nSaved sessions:', 'bold'));
  for (const s of sessions) {
    const date = s.updated ? new Date(s.updated).toLocaleString() : 'unknown';
    console.log(`  ${c(s.id.substring(0, 8), 'cyan')}  ${date}  ${s.messageCount} msgs  ${c(s.preview || '(empty)', 'dim')}`);
  }
  console.log(c('\nResume with: codebot --resume <id>', 'dim'));
}

function cmdUndo(rest: string[]) {
  const undoPath = rest.length > 0 ? rest.join(' ') : undefined;
  const undoResult = EditFileTool.undo(undoPath);
  console.log(c(undoResult, undoResult.includes('Restored') ? 'green' : 'yellow'));
}

function cmdUsage(agent: Agent) {
  const tracker = agent.getTokenTracker();
  const summary = tracker.getSummary();
  console.log(c('\nSession Usage:', 'bold'));
  console.log(`  Input:    ${summary.totalInputTokens.toLocaleString()} tokens`);
  console.log(`  Output:   ${summary.totalOutputTokens.toLocaleString()} tokens`);
  console.log(`  Cost:     ${tracker.formatCost()}`);
  console.log(`  Requests: ${summary.requestCount}`);
  console.log(`  Tools:    ${summary.toolCalls} calls`);
  console.log(`  Files:    ${summary.filesModified} modified`);
}

function cmdCost(agent: Agent) {
  const tracker = agent.getTokenTracker();
  console.log(c(`  ${tracker.formatStatusLine()}`, 'dim'));
}

function cmdMetrics(agent: Agent) {
  const metricsOutput = agent.getMetrics().formatSummary();
  console.log('\n' + metricsOutput);
}

function cmdRisk(agent: Agent) {
  const riskHistory = agent.getRiskScorer().getHistory();
  if (riskHistory.length === 0) {
    console.log(c('No risk assessments yet.', 'dim'));
    return;
  }
  const avg = agent.getRiskScorer().getSessionAverage();
  console.log(c(`\nRisk Summary: ${riskHistory.length} assessments, avg ${avg}/100`, 'bold'));
  const last5 = riskHistory.slice(-5);
  for (const a of last5) {
    console.log(`  ${RiskScorer.formatIndicator(a)}`);
  }
}

function cmdPolicy(agent: Agent) {
  const policy = agent.getPolicyEnforcer().getPolicy();
  console.log(c('\nCurrent Policy:', 'bold'));
  console.log(JSON.stringify(policy, null, 2));
}

function cmdAudit(agent: Agent) {
  const auditLogger = agent.getAuditLogger();
  const result = auditLogger.verifySession();
  if (result.entriesChecked === 0) {
    console.log(c('No audit entries yet.', 'dim'));
  } else if (result.valid) {
    console.log(c(`Audit chain valid (${result.entriesChecked} entries)`, 'green'));
  } else {
    console.log(c(`Audit chain INVALID at sequence ${result.firstInvalidAt}`, 'red'));
    console.log(c(`  ${result.reason}`, 'red'));
  }
}

function cmdRoutines() {
  const { RoutineTool } = require('../tools/routine');
  const rt = new RoutineTool();
  rt.execute({ action: 'list' })
    .then((out: string) => console.log('\n' + out))
    .catch((err: unknown) => {
      const msg = err instanceof Error ? err.message : String(err);
      console.error(c(`Error listing routines: ${msg}`, 'red'));
    });
}

function cmdRate(agent: Agent) {
  const rl2 = agent.getProviderRateLimiter();
  const util = rl2.getUtilization();
  const cfg = rl2.getConfig();
  console.log(c('\nProvider Rate Limits:', 'bold'));
  console.log(`  Provider:    ${cfg.provider}`);
  console.log(`  RPM:         ${util.rpmPercent}% (limit: ${cfg.requestsPerMinute}/min)`);
  console.log(`  TPM:         ${util.tpmPercent}% (limit: ${cfg.tokensPerMinute.toLocaleString()}/min)`);
  console.log(`  Concurrent:  ${util.concurrentPercent}% (limit: ${cfg.concurrentRequests})`);
}

function cmdTheme(rest: string[]) {
  if (rest.length > 0) {
    const themeName = rest[0];
    const available = getThemeNames();
    if (available.includes(themeName)) {
      setTheme(loadTheme(themeName));
      console.log(c(`Theme set to: ${themeName}`, 'green'));
    } else {
      console.log(c(`Unknown theme: ${themeName}. Available: ${available.join(', ')}`, 'yellow'));
    }
    return;
  }
  const current = getTheme();
  const available = getThemeNames();
  console.log(`Current theme: ${current.name}`);
  console.log(c(`Available: ${available.join(', ')}`, 'dim'));
}

function cmdDoctor() {
  runDoctor().then(report => {
    console.log(formatDoctorReport(report));
  });
}

function cmdToolcost(agent: Agent) {
  const tracker = agent.getTokenTracker();
  console.log('\n' + tracker.formatToolCostBreakdown());
}

function cmdConfig(config: Config) {
  console.log(JSON.stringify({ ...config, apiKey: config.apiKey ? '***' : undefined }, null, 2));
}

function cmdApps() {
  try {
    const { VaultManager } = require('../vault');
    const { ConnectorRegistry } = require('../connectors/registry');
    const { GitHubConnector } = require('../connectors/github');
    const { SlackConnector } = require('../connectors/slack');
    const { JiraConnector } = require('../connectors/jira');
    const { LinearConnector } = require('../connectors/linear');
    const { OpenAIImagesConnector } = require('../connectors/openai-images');
    const { ReplicateConnector } = require('../connectors/replicate');
    const vault = new VaultManager();
    const reg = new ConnectorRegistry(vault);
    reg.register(new GitHubConnector());
    reg.register(new SlackConnector());
    reg.register(new JiraConnector());
    reg.register(new LinearConnector());
    reg.register(new OpenAIImagesConnector());
    reg.register(new ReplicateConnector());
    console.log(c('\nApp Connectors:', 'bold'));
    for (const conn of reg.all()) {
      const connected = reg.isConnected(conn.name);
      const status = connected ? c('connected', 'green') : c('not connected', 'dim');
      const envHint = conn.envKey ? c(` (${conn.envKey})`, 'dim') : '';
      console.log(`  ${conn.displayName} [${conn.name}]: ${status}${envHint}`);
      console.log(`    Actions: ${conn.actions.map((a: {name: string}) => a.name).join(', ')}`);
    }
    console.log(c('\nConnect with: /connect <app> or set env var', 'dim'));
  } catch {
    console.log(c('App connectors not available.', 'dim'));
  }
}

function cmdConnect(rest: string[]) {
  const appName = rest[0];
  if (!appName) {
    console.log(c('Usage: /connect <app> (e.g., /connect github)', 'yellow'));
    return;
  }
  console.log(c(`To connect ${appName}, set the appropriate env var or use the app tool:`, 'dim'));
  console.log(c(`  In chat: "connect my ${appName} account"`, 'cyan'));
  console.log(c(`  Or set: export GITHUB_TOKEN=... (for GitHub)`, 'dim'));
}

// ── Dispatch table ──────────────────────────────────────────────────────────

type Handler = (agent: Agent, config: Config, rest: string[]) => void;

const COMMAND_TABLE: Record<string, Handler> = {
  '/help':      (_a, _c, _r) => cmdHelp(),
  '/model':     (a, c, r) => cmdModel(a, c, r),
  '/models':    () => showModels(),
  '/clear':     (a) => cmdClear(a),
  '/compact':   (a) => cmdCompact(a),
  '/auto':      (a, c) => cmdAuto(a, c),
  '/sessions':  () => cmdSessions(),
  '/undo':      (_a, _c, r) => cmdUndo(r),
  '/usage':     (a) => cmdUsage(a),
  '/cost':      (a) => cmdCost(a),
  '/metrics':   (a) => cmdMetrics(a),
  '/risk':      (a) => cmdRisk(a),
  '/policy':    (a) => cmdPolicy(a),
  '/audit':     (a) => cmdAudit(a),
  '/routines':  () => cmdRoutines(),
  '/rate':      (a) => cmdRate(a),
  '/theme':     (_a, _c, r) => cmdTheme(r),
  '/doctor':    () => cmdDoctor(),
  '/toolcost':  (a) => cmdToolcost(a),
  '/config':    (_a, c) => cmdConfig(c),
  '/apps':      () => cmdApps(),
  '/connect':   (_a, _c, r) => cmdConnect(r),
  '/quit':      () => process.exit(0),
  '/exit':      () => process.exit(0),
};

export function handleSlashCommand(input: string, agent: Agent, config: Config) {
  const [cmd, ...rest] = input.split(/\s+/);
  const handler = COMMAND_TABLE[cmd];
  if (handler) {
    handler(agent, config, rest);
  } else {
    console.log(c(`Unknown command: ${cmd}. Type /help`, 'yellow'));
  }
}

export function showModels() {
  const { MODEL_REGISTRY } = require('../providers/registry');
  const byProvider: Record<string, string[]> = {};
  for (const [name, info] of Object.entries(MODEL_REGISTRY) as [string, { provider?: string }][]) {
    const p = info.provider || 'local/ollama';
    if (!byProvider[p]) byProvider[p] = [];
    byProvider[p].push(name);
  }
  for (const [provider, models] of Object.entries(byProvider).sort()) {
    console.log(c(`\n${provider}:`, 'bold'));
    for (const m of models) {
      console.log(`  ${m}`);
    }
  }
}
