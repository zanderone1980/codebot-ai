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
  handleVerifyAudit,
  handleReplay,
  handleDaemon,
  handleHeartbeat,
  handleInitPolicy,
  handleSandboxInfo,
  handleExportAudit,
  handleDoctor,
  handleSolve,
  handleTask,
  handleListen,
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

export async function main() {
  process.on('unhandledRejection', (reason: unknown) => {
    const msg = reason instanceof Error ? reason.message : String(reason);
    console.error(`\x1b[31m\nUnhandled error: ${msg}\x1b[0m`);
  });

  process.on('uncaughtException', (err: Error) => {
    console.error(`\x1b[31m\nUncaught exception: ${err.message}\x1b[0m`);
    if (err.message.includes('out of memory') || err.message.includes('ENOMEM')) {
      process.exit(1);
    }
  });

  // ── Process lifecycle: graceful shutdown on signals ──
  // Prevents orphaned zombie processes when parent session ends
  const { codebotPath } = require('./paths');
  const pidFile = codebotPath('dashboard.pid');
  let shuttingDown = false;
  const gracefulShutdown = (signal: string) => {
    if (shuttingDown) return;
    shuttingDown = true;
    console.log(`\n\x1b[2mCodeBot shutting down (${signal})...\x1b[0m`);
    try {
      fs.unlinkSync(pidFile);
    } catch {
      /* ignore */
    }
    process.exit(0);
  };
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
  process.on('SIGINT', () => gracefulShutdown('SIGINT'));
  // SIGHUP = terminal hangup. In dashboard mode, ignore it — the dashboard
  // should survive terminal disconnects. Only kill on explicit SIGINT/SIGTERM.
  process.on('SIGHUP', () => {
    if (parseArgs(process.argv.slice(2)).dashboard) {
      console.log('\x1b[2mTerminal disconnected — dashboard stays alive.\x1b[0m');
    } else {
      gracefulShutdown('SIGHUP');
    }
  });

  // `codebot vault …` subcommand short-circuits before the main agent flow.
  if (handleVaultSubcommand()) return;

  const args = parseArgs(process.argv.slice(2));

  if (typeof args.theme === 'string') {
    setTheme(loadTheme(args.theme));
  } else {
    setTheme(loadTheme());
  }

  if (args.help) {
    showHelp();
    return;
  }
  if (args.version) {
    console.log(`CodeBot AI v${VERSION}`);
    return;
  }
  if (args.setup) {
    await runSetup();
  }

  // Heartbeat subcommand short-circuits before the main agent flow.
  if (handleHeartbeat(args)) return;

  // First-run prompt + daily ping. Both are silent on failure and never block.
  // The ping fires-and-forgets — we don't await it before the main flow.
  ensureHeartbeatConfig();
  void heartbeatMaybePing(VERSION);

  // ── Standalone commands ──
  if (args['init-policy']) { handleInitPolicy(); return; }
  if (args['verify-audit']) { handleVerifyAudit(args); return; }
  if (args['sandbox-info']) { handleSandboxInfo(); return; }
  if (args.replay) { await handleReplay(args); return; }
  if (args['export-audit'] === 'sarif' || args['export-audit'] === true) { handleExportAudit(args, VERSION); return; }
  if (args.doctor) { await handleDoctor(); }
  if (args.solve) { await handleSolve(args); return; }

  if (args.task) { await handleTask(args); }

  if (args.daemon) { await handleDaemon(args); return; }
  if (args.listen) { await handleListen(args); return; }

  // ── Zero-friction first run ──
  let showGuidedPrompts = false;
  if (isFirstRun() && process.stdin.isTTY && !args.message) {
    const detected = await autoDetect();
    if (detected.type === 'auto-start' && detected.model) {
      const autoConfig: any = {
        model: detected.model,
        provider: detected.provider,
        baseUrl: detected.baseUrl,
        autoApprove: false,
        firstRunComplete: true,
      };
      if (detected.apiKey) autoConfig.apiKey = detected.apiKey;
      saveSetupConfig(autoConfig);
      showGuidedPrompts = true;
    } else {
      const quickConfig = await runQuickSetup(detected);
      if (!quickConfig.model) return;
      showGuidedPrompts = true;
    }
  }

  const config = await resolveConfig(args);
  const provider = createProvider(config);
  setVerbose(!!args.verbose);

  // ── Vault Mode ─────────────────────────────────────────────────────
  // When --vault <path> is set, the agent becomes a read-only research
  // assistant over a folder of markdown notes. We chdir into the vault
  // so file tools operate there, force autoApprove (read-only by default
  // anyway), and construct a vaultMode option object to pass to Agent +
  // ToolRegistry. See src/agent/vault-prompt.ts + src/tools/index.ts.
  let vaultModeOpts: { vaultPath: string; writable: boolean; networkAllowed: boolean } | undefined;
  if (typeof args.vault === 'string' && args.vault.length > 0) {
    const rawVaultPath = args.vault as string;
    // Expand ~ manually — Node doesn't
    const expanded = rawVaultPath.startsWith('~')
      ? rawVaultPath.replace(/^~/, require('os').homedir())
      : rawVaultPath;
    const vaultPath = require('path').resolve(expanded);
    const fs = require('fs');
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
    vaultModeOpts = {
      vaultPath,
      writable: !!args['vault-writable'],
      networkAllowed: !!args['vault-allow-network'],
    };
    // Vault mode implies autoApprove — the agent is read-only by default
    // and there's no destructive default surface to gate interactively.
    config.autoApprove = true;
    const readonlyLabel = vaultModeOpts.writable ? 'writable' : 'read-only';
    const netLabel = vaultModeOpts.networkAllowed ? 'network: on' : 'network: off';
    console.log(c(`  Vault Mode: ${vaultPath} (${readonlyLabel}, ${netLabel})`, 'dim'));
  }


  if (args.deterministic) {
    provider.temperature = 0;
    console.log(c('  Deterministic mode: temperature=0', 'dim'));
  }

  // Session management
  let resumeId: string | undefined;
  if (args.continue) {
    resumeId = SessionManager.latest();
    if (!resumeId) console.log(c('No previous session found.', 'yellow'));
  } else if (typeof args.resume === 'string') {
    resumeId = args.resume as string;
  }

  const session = new SessionManager(config.model, resumeId);
  const sessionShort = session.getId().substring(0, 8);
  const providerLabel = `${config.provider} @ ${config.baseUrl}`;
  const isAuto = !!config.autoApprove;
  const noAnimate = args['no-animate'] === true || args['no-animation'] === true;

  if (shouldAnimate() && !noAnimate) {
    await animateBootSequence(banner, VERSION, config.model, providerLabel, `${sessionShort}...`, isAuto, 'normal');
    if (resumeId) console.log(c(`   ${randomGreeting('resuming')}`, 'green'));
    else if (isAuto) console.log(formatReaction('autonomous_start'));
  } else {
    console.log(banner(VERSION, config.model, providerLabel, `${sessionShort}...`, isAuto));
    if (resumeId) console.log(c(`   ${randomGreeting('resuming')}`, 'green'));
    else if (isAuto) {
      console.log(c(`   ${randomGreeting('confident')}`, 'dim'));
      console.log(formatReaction('autonomous_start'));
    } else console.log(c(`   ${randomGreeting()}\n`, 'dim'));
  }

  if (showGuidedPrompts) {
    const prompts = getContextualPrompts();
    console.log(guidedPrompts(prompts, 'Type /help for commands, /setup to reconfigure'));
    try {
      const saved = loadConfig();
      if (saved.firstRunComplete) {
        delete saved.firstRunComplete;
        saveSetupConfig(saved);
      }
    } catch {
      /* ignore */
    }
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
    const card = permissionCard(tool, args, risk || { score: 0, level: 'green' }, sandbox);
    process.stdout.write(card);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const userResponse = new Promise<boolean>((resolve) => {
      rl.question('Allow? [y/N] ', (answer) => {
        rl.close();
        resolve(answer.toLowerCase().startsWith('y'));
      });
    });
    const timeout = new Promise<boolean>((resolve) => {
      setTimeout(() => {
        rl.close();
        process.stdout.write('\n\u23f1 Permission timed out — denied by default.\n');
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
  if (args.dashboard) {
    // PR 25 — do NOT force agent.setAutoApprove(true) here. Pre-PR-21
    // the dashboard had no UI to surface permission prompts, so the
    // CLI's startup unconditionally set autoApprove=true to avoid a
    // hung readline prompt. PR 21 wired a visible Approve/Deny card
    // for the chat path; PR 25 wired it for the tool-runner path.
    // With both surfaces honoring per-request approval, the
    // unconditional auto-approve at startup is now actively
    // harmful: the agent's PR-11 unattended-block path
    // (`blockedByUnallowedCapability`) fires for any send-on-behalf
    // tool, denying with the PR-11 reason wording instead of letting
    // askPermission surface a card. Chats that want auto-approve
    // can still opt in per-request via `body.autoApprove: true`
    // (PR 16); tool-runner gets approval through the new
    // /api/command/permission/respond endpoint (PR 25).
    try {
      // Resolve static dir: prefer src/ (canonical) over dist/ (stale copies)
      const srcStatic = require('path').resolve(__dirname, '..', 'src', 'dashboard', 'static');
      const distStatic = require('path').join(__dirname, 'dashboard', 'static');
      const dashStaticDir = require('fs').existsSync(srcStatic) ? srcStatic : distStatic;
      const dashHost = typeof args.host === 'string' ? args.host : '127.0.0.1';
      const dashPort = resolveDashboardPort();
      const dashServer = new DashboardServer({ port: dashPort, host: dashHost, staticDir: dashStaticDir });
      registerApiRoutes(dashServer);
      registerCommandRoutes(dashServer, agent);
      registerModelRoutes(dashServer);
      const dashInfo = await dashServer.start();
      console.log(c(`   Dashboard: ${dashInfo.url}`, 'cyan'));
      // Write PID file so stale processes can be identified
      try {
        const pidDir = codebotPath('');
        if (!fs.existsSync(pidDir)) fs.mkdirSync(pidDir, { recursive: true });
        fs.writeFileSync(pidFile, String(process.pid), 'utf8');
      } catch {
        /* best-effort */
      }
      const dashUrl = dashHost === '0.0.0.0' ? `http://localhost:${dashInfo.port}` : dashInfo.url;
      if (!args['no-open'] && !process.env.CODEBOT_NO_OPEN) {
        try {
          const { exec } = require('child_process');
          const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open';
          exec(`${openCmd} ${dashUrl}`);
        } catch {
          /* best-effort */
        }
      }
    } catch (err: unknown) {
      console.log(c(`   Dashboard failed: ${err instanceof Error ? err.message : String(err)}`, 'yellow'));
    }

    // In dashboard mode, DO NOT run orphan watchdog — the dashboard is the
    // primary process and should survive independently. Only non-dashboard
    // mode needs orphan detection (e.g., piped/scripted usage).
    if (!args.dashboard) {
      const watchdog = setInterval(() => {
        try {
          const ppid = process.ppid;
          if (ppid === undefined || ppid <= 1) {
            console.log(c('   Parent process gone, shutting down cleanly.', 'dim'));
            clearInterval(watchdog);
            gracefulShutdown('orphan-detected');
          }
        } catch {
          /* ignore */
        }
      }, 30_000);
      watchdog.unref();
    }
  }

  if (typeof args.message === 'string') {
    await runOnce(agent, args.message);
    printSessionSummary(agent);
    return;
  }
  if (!process.stdin.isTTY) {
    if (args.dashboard) {
      // Dashboard mode with no TTY (backgrounded, launched from .app, etc.)
      // Keep process alive — the HTTP server IS the product, REPL is optional.
      console.log(c(`   Dashboard-only mode — no REPL, serving on port ${resolveDashboardPort()}.`, 'dim'));
      await new Promise(() => {}); // Block forever — HTTP server keeps running
      return;
    }
    const input = await readStdin();
    if (input.trim()) {
      await runOnce(agent, input.trim());
      printSessionSummary(agent);
    }
    return;
  }

  const scheduler = new Scheduler(agent, (text) => process.stdout.write(text));
  scheduler.start();
  await repl(agent, config, session, !!args.dashboard);
  scheduler.stop();
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
