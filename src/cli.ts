import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { Agent } from './agent';
import { Config, Message } from './types';
import { SessionManager } from './history';
import { loadConfig, isFirstRun, runSetup } from './setup';
import {
  banner,
  randomGreeting,
  formatReaction,
  sessionSummaryBanner,
  shouldAnimate,
  animateBootSequence,
} from './banner';
import { Scheduler } from './scheduler';
import { permissionCard, guidedPrompts } from './ui';
import { loadTheme, setTheme } from './theme';
import { autoDetect, runQuickSetup, saveConfig as saveSetupConfig } from './setup';
import { DashboardServer } from './dashboard/server';
import { registerApiRoutes } from './dashboard/api';
import { registerCommandRoutes } from './dashboard/command-api';
import { registerModelRoutes } from './dashboard/models-api';
import { VERSION } from './index';
import {
  ensureHeartbeatConfig,
  maybePing as heartbeatMaybePing,
} from './heartbeat';

// Decomposed modules
import { parseArgs, showHelp } from './cli/args';
import { resolveConfig, createProvider } from './cli/config';
import { renderEvent, setVerbose } from './cli/render';
import { handleSlashCommand } from './cli/commands';
import { resolveDashboardPort } from './cli/dashboard-config';
import {
  handleVaultSubcommand,
  handleHeartbeat,
  handleDoctor,
  handleTask,
  dispatchEarlyReturnSubcommand,
} from './cli/subcommands';

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

// ── Local helpers extracted from main() to bring its complexity under gate ──

/** Resolve and validate --vault path. Mutates config.autoApprove when vault is active. */
function resolveVaultModeOpts(
  args: ReturnType<typeof parseArgs>,
  config: Config,
): { vaultPath: string; writable: boolean; networkAllowed: boolean } | undefined {
  const rawPath = args.vault;
  if (typeof rawPath !== 'string' || rawPath.length === 0) return undefined;
  const expanded = rawPath.startsWith('~') ? rawPath.replace(/^~/, require('os').homedir()) : rawPath;
  const vaultPath = path.resolve(expanded);
  if (!fs.existsSync(vaultPath)) {
    console.error(c(`Vault path does not exist: ${vaultPath}`, 'red'));
    process.exit(2);
  }
  if (!fs.statSync(vaultPath).isDirectory()) {
    console.error(c(`Vault path is not a directory: ${vaultPath}`, 'red'));
    process.exit(2);
  }
  try { process.chdir(vaultPath); } catch (err) {
    console.error(c(`Could not chdir to vault: ${(err as Error).message}`, 'red'));
    process.exit(2);
  }
  config.autoApprove = true;
  const opts = { vaultPath, writable: !!(args as any)['vault-writable'], networkAllowed: !!(args as any)['vault-allow-network'] };
  const modeLabel = `${opts.writable ? 'writable' : 'read-only'}, ${opts.networkAllowed ? 'network: on' : 'network: off'}`;
  console.log(c(`  Vault Mode: ${vaultPath} (${modeLabel})`, 'dim'));
  return opts;
}

/** First-run zero-friction setup. Returns whether to show guided prompts or abort main(). */
async function handleFirstRunSetup(
  args: ReturnType<typeof parseArgs>,
): Promise<{ showGuidedPrompts: boolean; abort: boolean }> {
  if (!isFirstRun() || !process.stdin.isTTY || args.message) {
    return { showGuidedPrompts: false, abort: false };
  }
  const detected = await autoDetect();
  if (detected.type === 'auto-start' && detected.model) {
    const autoConfig: any = { model: detected.model, provider: detected.provider, baseUrl: detected.baseUrl, autoApprove: false, firstRunComplete: true };
    if (detected.apiKey) autoConfig.apiKey = detected.apiKey;
    saveSetupConfig(autoConfig);
    return { showGuidedPrompts: true, abort: false };
  }
  const quickConfig = await runQuickSetup(detected);
  if (!quickConfig.model) return { showGuidedPrompts: false, abort: true };
  return { showGuidedPrompts: true, abort: false };
}

/** Render the startup banner + greeting. */
async function displayStartupBanner(opts: {
  version: string; modelName: string; providerLabel: string;
  sessionShort: string; isAuto: boolean; resumeId: string | undefined; noAnimate: boolean;
}): Promise<void> {
  const { version: v, modelName, providerLabel, sessionShort, isAuto, resumeId, noAnimate } = opts;
  if (shouldAnimate() && !noAnimate) {
    await animateBootSequence(banner, v, modelName, providerLabel, `${sessionShort}...`, isAuto, 'normal');
    if (resumeId) console.log(c(`   ${randomGreeting('resuming')}`, 'green'));
    else if (isAuto) console.log(formatReaction('autonomous_start'));
  } else {
    console.log(banner(v, modelName, providerLabel, `${sessionShort}...`, isAuto));
    if (resumeId) console.log(c(`   ${randomGreeting('resuming')}`, 'green'));
    else if (isAuto) { console.log(c(`   ${randomGreeting('confident')}`, 'dim')); console.log(formatReaction('autonomous_start')); }
    else console.log(c(`   ${randomGreeting()}\n`, 'dim'));
  }
}

/** Start the dashboard server if --dashboard was given. */
async function launchDashboard(
  args: ReturnType<typeof parseArgs>,
  agent: Agent,
  pidFile: string,
): Promise<void> {
  try {
    const srcStatic = path.resolve(__dirname, '..', 'src', 'dashboard', 'static');
    const distStatic = path.join(__dirname, 'dashboard', 'static');
    const dashStaticDir = fs.existsSync(srcStatic) ? srcStatic : distStatic;
    const dashHost = typeof args.host === 'string' ? args.host : '127.0.0.1';
    const dashPort = resolveDashboardPort();
    const dashServer = new DashboardServer({ port: dashPort, host: dashHost, staticDir: dashStaticDir });
    registerApiRoutes(dashServer);
    registerCommandRoutes(dashServer, agent);
    registerModelRoutes(dashServer);
    const dashInfo = await dashServer.start();
    console.log(c(`   Dashboard: ${dashInfo.url}`, 'cyan'));
    try {
      const { codebotPath: cbp } = require('./paths');
      const pidDir = cbp('');
      if (!fs.existsSync(pidDir)) fs.mkdirSync(pidDir, { recursive: true });
      fs.writeFileSync(pidFile, String(process.pid), 'utf8');
    } catch { /* best-effort */ }
    const dashUrl = dashHost === '0.0.0.0' ? `http://localhost:${dashInfo.port}` : dashInfo.url;
    if (!args['no-open'] && !process.env.CODEBOT_NO_OPEN) {
      try {
        const { exec } = require('child_process');
        const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
        exec(`${openCmd} ${dashUrl}`);
      } catch { /* best-effort */ }
    }
  } catch (err: unknown) {
    console.log(c(`   Dashboard failed: ${err instanceof Error ? err.message : String(err)}`, 'yellow'));
  }
}

/** Final dispatch: message mode, piped stdin, or interactive REPL. */
async function runInputDispatch(
  args: ReturnType<typeof parseArgs>,
  agent: Agent,
  config: Config,
  session: SessionManager,
  isDashboard: boolean,
): Promise<void> {
  if (typeof args.message === 'string') {
    await runOnce(agent, args.message);
    printSessionSummary(agent);
    return;
  }
  if (!process.stdin.isTTY) {
    if (isDashboard) {
      console.log(c(`   Dashboard-only mode — no REPL, serving on port ${resolveDashboardPort()}.`, 'dim'));
      await new Promise(() => {}); // Block forever — HTTP server IS the product
      return;
    }
    const input = await readStdin();
    if (input.trim()) { await runOnce(agent, input.trim()); printSessionSummary(agent); }
    return;
  }
  const scheduler = new Scheduler(agent, (text) => process.stdout.write(text));
  scheduler.start();
  await repl(agent, config, session, isDashboard);
  scheduler.stop();
}

export async function main() {
  process.on('unhandledRejection', (reason: unknown) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error(`\x1b[31m\nUnhandled error: ${msg}\x1b[0m`);
  });
  process.on('uncaughtException', (err: Error) => {
    console.error(`\x1b[31m\nUncaught exception: ${err.message}\x1b[0m`);
    if (err.message.includes('out of memory') || err.message.includes('ENOMEM')) process.exit(1);
  });

  // ── Process lifecycle: graceful shutdown on signals ──
  const { codebotPath } = require('./paths');
  const pidFile = codebotPath('dashboard.pid');
  let shuttingDown = false;
  const gracefulShutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n\x1b[2mCodeBot shutting down (${signal})...\x1b[0m`);
    try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
    process.exit(0);
  };
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  // SIGHUP: survive in dashboard mode, shut down otherwise.
  process.on('SIGHUP', () => {
    if (parseArgs(process.argv.slice(2)).dashboard) {
      console.log('\x1b[2mTerminal disconnected — dashboard stays alive.\x1b[0m');
    } else { gracefulShutdown('SIGHUP'); }
  });

  // `codebot vault …` short-circuits before banner / agent.
  if (handleVaultSubcommand()) return;

  const args = parseArgs(process.argv.slice(2));
  setTheme(typeof args.theme === 'string' ? loadTheme(args.theme) : loadTheme());

  if (args.help) { showHelp(); return; }
  if (args.version) { console.log(`CodeBot AI v${VERSION}`); return; }
  if (args.setup) await runSetup();
  if (handleHeartbeat(args)) return;

  ensureHeartbeatConfig();
  void heartbeatMaybePing(VERSION);

  // ── Early-return subcommands (routing table) ──
  if (await dispatchEarlyReturnSubcommand(args as Record<string, string | boolean>, VERSION)) return;

  // doctor / task fall through to the agent REPL after running.
  if (args.doctor) await handleDoctor();
  if (args.task) await handleTask(args as Record<string, string | boolean>);

  // ── Zero-friction first run ──
  const firstRun = await handleFirstRunSetup(args);
  if (firstRun.abort) return;

  const config = await resolveConfig(args);
  const provider = createProvider(config);
  setVerbose(!!args.verbose);

  // Vault mode: validates path, chdir's, sets config.autoApprove.
  const vaultModeOpts = resolveVaultModeOpts(args, config);

  if (args.deterministic) {
    provider.temperature = 0;
    console.log(c('  Deterministic mode: temperature=0', 'dim'));
  }

  // ── Session management ──
  let resumeId: string | undefined;
  if (args.continue) {
    resumeId = SessionManager.latest();
    if (!resumeId) console.log(c('No previous session found.', 'yellow'));
  } else if (typeof args.resume === 'string') {
    resumeId = args.resume as string;
  }

  const session = new SessionManager(config.model, resumeId);
  const noAnimate = args['no-animate'] === true || args['no-animation'] === true;
  await displayStartupBanner({
    version: VERSION,
    modelName: config.model,
    providerLabel: `${config.provider} @ ${config.baseUrl}`,
    sessionShort: session.getId().substring(0, 8),
    isAuto: !!config.autoApprove,
    resumeId,
    noAnimate,
  });

  if (firstRun.showGuidedPrompts) {
    console.log(guidedPrompts(getContextualPrompts(), 'Type /help for commands, /setup to reconfigure'));
    try {
      const saved = loadConfig();
      if (saved.firstRunComplete) { delete saved.firstRunComplete; saveSetupConfig(saved); }
    } catch { /* ignore */ }
  }

  const agent = new Agent({
    provider,
    model: config.model,
    providerName: config.provider,
    maxIterations: config.maxIterations,
    autoApprove: config.autoApprove,
    onMessage: (msg: Message) => session.save(msg),
    vaultMode: vaultModeOpts,
    routerConfig: config.router,
    budgetConfig: config.budget,
    allowedCapabilities: config.allowedCapabilities,
    constitutional: { enabled: !config.disableConstitutional },
  });

  agent.setAskPermission(async (tool, args, risk, sandbox) => {
    process.stdout.write(permissionCard(tool, args, risk || { score: 0, level: 'green' }, sandbox));
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const userResponse = new Promise<boolean>((resolve) => {
      rl.question('Allow? [y/N] ', (answer) => { rl.close(); resolve(answer.toLowerCase().startsWith('y')); });
    });
    const timeout = new Promise<boolean>((resolve) => {
      setTimeout(() => {
        rl.close();
        process.stdout.write('\n⏱ Permission timed out — denied by default.\n');
        resolve(false);
      }, 30_000);
    });
    return Promise.race([userResponse, timeout]);
  });

  if (resumeId) {
    const messages = session.load();
    if (messages.length > 0) {
      agent.loadMessages(messages);
      console.log(c(`   Loaded ${messages.length} messages from previous session.`, 'dim'));
    }
  }

  // ── Dashboard ──
  // PR 25: do NOT force autoApprove=true here — the dashboard surfaces its
  // own Approve/Deny card (PR 21 chat path, PR 25 tool-runner path).
  if (args.dashboard) await launchDashboard(args, agent, pidFile);

  await runInputDispatch(args, agent, config, session, !!args.dashboard);
}

function printSessionSummary(agent: Agent) {
  const tracker = agent.getTokenTracker();
  tracker.saveUsage();
  const summary = tracker.getSummary();
  const duration = (new Date(summary.endTime).getTime() - new Date(summary.startTime).getTime()) / 1000;
  const mins = Math.floor(duration / 60);
  const secs = Math.floor(duration % 60);

  console.log(c('\n\u2500\u2500 Session Summary \u2500\u2500', 'dim'));
  console.log(`  Duration:  ${mins}m ${secs}s`);
  console.log(`  Model:     ${summary.model} via ${summary.provider}`);
  console.log(
    `  Tokens:    ${summary.totalInputTokens.toLocaleString()} in / ${summary.totalOutputTokens.toLocaleString()} out (${tracker.formatCost()})`,
  );
  console.log(`  Requests:  ${summary.requestCount}`);
  console.log(`  Tools:     ${summary.toolCalls} calls`);
  console.log(`  Files:     ${summary.filesModified} modified`);

  const metrics = agent.getMetrics();
  const snap = metrics.snapshot();
  const toolCounters = snap.counters.filter((c) => c.name === 'tool_calls_total');
  if (toolCounters.length > 0) {
    console.log(c('  Per-tool:', 'dim'));
    for (const tc of toolCounters.sort((a, b) => b.value - a.value)) {
      const hist = snap.histograms.find((h) => h.name === 'tool_latency_seconds' && h.labels.tool === tc.labels.tool);
      const avg = hist && hist.count > 0 ? ((hist.sum / hist.count) * 1000).toFixed(0) : '?';
      console.log(c(`    ${tc.labels.tool}: ${tc.value} calls (avg ${avg}ms)`, 'dim'));
    }
  }

  const toolCostBreakdown = tracker.getToolCostBreakdown();
  if (toolCostBreakdown.length > 0) {
    console.log(c('  Cost by tool:', 'dim'));
    for (const entry of toolCostBreakdown.slice(0, 5)) {
      const cost = entry.costUsd === 0 ? 'free' : `$${entry.costUsd.toFixed(4)}`;
      console.log(c(`    ${entry.tool}: ${entry.calls} calls, ${cost} (${entry.pctOfTotal.toFixed(1)}%)`, 'dim'));
    }
  }

  const riskScorer = agent.getRiskScorer();
  const riskAvg = riskScorer.getSessionAverage();
  if (riskScorer.getHistory().length > 0) console.log(`  Risk:      avg ${riskAvg}/100`);

  // PR 6 — surface session cost + budget remaining when an effective
  // cap exists. Without a cap, banner falls back to "no cap" rendering.
  const tokenTracker = agent.getTokenTracker();
  const budgetCapUsd = agent.getEffectiveBudgetCapUsd();
  const remainingUsd = tokenTracker.getRemainingBudget();
  console.log(
    sessionSummaryBanner({
      iterations: summary.requestCount,
      toolCalls: summary.toolCalls,
      tokensUsed: summary.totalInputTokens + summary.totalOutputTokens,
      cost: summary.totalCostUsd,
      duration,
      budgetCapUsd,
      budgetRemainingUsd: remainingUsd,
    }),
  );
  metrics.save();
  metrics.exportOtel();
}

async function repl(agent: Agent, config: Config, session?: SessionManager, isDashboard: boolean = false) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: c('> ', 'cyan') });
  rl.prompt();
  rl.on('line', async (line: string) => {
    const input = line.trim();
    if (!input) {
      rl.prompt();
      return;
    }
    if (input.startsWith('/')) {
      handleSlashCommand(input, agent, config);
      rl.prompt();
      return;
    }
    try {
      for await (const event of agent.run(input)) {
        renderEvent(event, agent);
      }
    } catch (err: unknown) {
      console.error(c(`\nError: ${err instanceof Error ? err.message : String(err)}`, 'red'));
    }
    console.log();
    rl.prompt();
  });
  rl.on('close', () => {
    printSessionSummary(agent);
    console.log(formatReaction('session_end'));
    // In dashboard mode, keep process alive — dashboard serves independently
    if (isDashboard) {
      console.log(c(`   REPL closed — dashboard still running on port ${resolveDashboardPort()}.`, 'dim'));
    } else {
      process.exit(0);
    }
  });
}

async function runOnce(agent: Agent, message: string) {
  for await (const event of agent.run(message)) {
    renderEvent(event, agent);
  }
  console.log();
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    let data = '';
    process.stdin.on('data', (chunk: Buffer) => (data += chunk.toString()));
    process.stdin.on('end', () => resolve(data));
  });
}

function getContextualPrompts(): string[] {
  const cwd = process.cwd();
  const isGitRepo = fs.existsSync(path.join(cwd, '.git'));
  const hasPackageJson = fs.existsSync(path.join(cwd, 'package.json'));
  if (isGitRepo && hasPackageJson)
    return ['"explain what this project does"', '"find and fix any bugs in src/"', '"add tests for the main module"'];
  if (isGitRepo)
    return ['"summarize the recent git changes"', '"review the code in this repo"', '"help me refactor the main file"'];
  return ['"create a new Node.js project"', '"write a Python script that..."', '"help me set up a React app"'];
}
