import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { Agent } from './agent';
import { AgentEvent, Config, Message } from './types';
import { SessionManager } from './history';
import { loadConfig, isFirstRun, runSetup } from './setup';
import { banner, randomGreeting, formatReaction, sessionSummaryBanner, shouldAnimate, animateBootSequence } from './banner';
import { Scheduler } from './scheduler';
import { AuditLogger } from './audit';
import { generateDefaultPolicyFile } from './policy';
import { getSandboxInfo } from './sandbox';
import { ReplayProvider, loadSessionForReplay, compareOutputs } from './replay';
import { exportSarif, sarifToString } from './sarif';
import { UI, permissionCard, guidedPrompts } from './ui';
import { runDoctor, formatDoctorReport } from './doctor';
import { loadTheme, setTheme } from './theme';
import { autoDetect, runQuickSetup, saveConfig as saveSetupConfig } from './setup';
import { DashboardServer } from './dashboard/server';
import { registerApiRoutes } from './dashboard/api';
import { registerCommandRoutes } from './dashboard/command-api';
import { registerCodeAGIRoutes } from './dashboard/codeagi-api';
import { registerModelRoutes } from './dashboard/models-api';
import { VERSION } from './index';
import { SolveCommand } from './solve';
import { Daemon } from './daemon';

// Decomposed modules
import { parseArgs, showHelp } from './cli/args';
import { resolveConfig, createProvider } from './cli/config';
import { renderEvent, renderSolveEvent, setVerbose, truncate } from './cli/render';
import { handleSlashCommand } from './cli/commands';

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
    try { fs.unlinkSync(pidFile); } catch { /* ignore */ }
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

  const args = parseArgs(process.argv.slice(2));

  if (typeof args.theme === 'string') {
    setTheme(loadTheme(args.theme));
  } else {
    setTheme(loadTheme());
  }

  if (args.help) { showHelp(); return; }
  if (args.version) { console.log(`codebot v${VERSION}`); return; }
  if (args.setup) { await runSetup(); }

  // ── Standalone commands ──
  if (args['init-policy']) {
    const policyPath = path.join(process.cwd(), '.codebot', 'policy.json');
    const policyDir = path.dirname(policyPath);
    if (!fs.existsSync(policyDir)) fs.mkdirSync(policyDir, { recursive: true });
    if (fs.existsSync(policyPath)) {
      console.log(c(`Policy file already exists at ${policyPath}`, 'yellow'));
    } else {
      fs.writeFileSync(policyPath, generateDefaultPolicyFile(), 'utf-8');
      console.log(c(`Created default policy at ${policyPath}`, 'green'));
    }
    return;
  }

  if (args['verify-audit']) {
    const logger = new AuditLogger();
    const sessionId = typeof args['verify-audit'] === 'string' ? args['verify-audit'] as string : undefined;
    if (sessionId) {
      const entries = logger.query({ sessionId });
      if (entries.length === 0) { console.log(c(`No audit entries found for session ${sessionId}`, 'yellow')); return; }
      const result = AuditLogger.verify(entries);
      if (result.valid) {
        console.log(c(`Audit chain valid (${result.entriesChecked} entries checked)`, 'green'));
      } else {
        console.log(c(`Audit chain INVALID at sequence ${result.firstInvalidAt}`, 'red'));
        console.log(c(`Reason: ${result.reason}`, 'red'));
      }
    } else {
      const entries = logger.query();
      if (entries.length === 0) { console.log(c('No audit entries found.', 'yellow')); return; }
      const sessions = new Map<string, typeof entries>();
      for (const e of entries) {
        if (!sessions.has(e.sessionId)) sessions.set(e.sessionId, []);
        sessions.get(e.sessionId)!.push(e);
      }
      let allValid = true;
      for (const [sid, sessionEntries] of sessions) {
        const result = AuditLogger.verify(sessionEntries);
        const shortId = sid.substring(0, 12);
        if (result.valid) {
          console.log(c(`  ${shortId}  ${result.entriesChecked} entries  valid`, 'green'));
        } else {
          console.log(c(`  ${shortId}  INVALID at seq ${result.firstInvalidAt}: ${result.reason}`, 'red'));
          allValid = false;
        }
      }
      console.log(allValid
        ? c(`\nAll ${sessions.size} session chains verified.`, 'green')
        : c(`\nSome chains are invalid — possible tampering detected.`, 'red'));
    }
    return;
  }

  if (args['sandbox-info']) {
    const info = getSandboxInfo();
    console.log(c('Sandbox Status:', 'bold'));
    console.log(`  Docker: ${info.available ? c('available', 'green') : c('not available', 'yellow')}`);
    console.log(`  Image:  ${info.image}`);
    console.log(`  CPU:    ${info.defaults.cpus} cores max`);
    console.log(`  Memory: ${info.defaults.memoryMb}MB max`);
    console.log(`  Network: ${info.defaults.network ? 'enabled' : 'disabled'} by default`);
    return;
  }

  if (args.replay) {
    const replayId = typeof args.replay === 'string' ? args.replay as string : SessionManager.latest();
    if (!replayId) { console.log(c('No session to replay.', 'yellow')); return; }
    const data = loadSessionForReplay(replayId);
    if (!data) { console.log(c(`Session ${replayId} not found.`, 'red')); return; }
    console.log(c(`\nReplaying session ${replayId.substring(0, 12)}...`, 'cyan'));
    console.log(c(`  ${data.messages.length} messages`, 'dim'));
    const replayProvider = new ReplayProvider(data.assistantMessages);
    const config = await resolveConfig(args);
    const agent = new Agent({ provider: replayProvider, model: config.model, providerName: 'replay', autoApprove: true });
    const recordedResults = Array.from(data.toolResults.values());
    let resultIndex = 0;
    let divergences = 0;
    for (const userMsg of data.userMessages) {
      console.log(c(`\n> ${truncate(userMsg.content, 100)}`, 'cyan'));
      for await (const event of agent.run(userMsg.content)) {
        if (event.type === 'tool_result' && event.toolResult && !event.toolResult.is_error) {
          const recorded = recordedResults[resultIndex++];
          if (recorded !== undefined) {
            const diff = compareOutputs(recorded, event.toolResult.result);
            if (diff) { divergences++; console.log(c(`  \u26a0 Divergence in ${event.toolResult.name || 'tool'}:`, 'yellow')); }
            else { console.log(c(`  \u2713 ${event.toolResult.name || 'tool'} — output matches`, 'green')); }
          }
        }
      }
    }
    console.log(c(`\n\nReplay complete. ${divergences} divergence(s).`, 'bold'));
    return;
  }

  if (args['export-audit'] === 'sarif' || args['export-audit'] === true) {
    const logger = new AuditLogger();
    const sessionId = typeof args['session'] === 'string' ? args['session'] as string : undefined;
    const entries = sessionId ? logger.query({ sessionId }) : logger.query();
    if (entries.length === 0) { console.error(c('No audit entries found.', 'yellow')); process.exit(1); }
    const sarif = exportSarif(entries, { version: VERSION, sessionId });
    process.stdout.write(sarifToString(sarif) + '\n');
    return;
  }

  if (args.doctor) {
    const report = await runDoctor();
    console.log(formatDoctorReport(report));
    process.exit(report.failed > 0 ? 1 : 0);
  }

  if (args.solve) {
    const solveUrl = typeof args.solve === 'string' ? args.solve as string : (args.message as string);
    if (!solveUrl) { console.error(c('Error: provide a GitHub issue URL.', 'red')); process.exit(1); }
    const config = await resolveConfig(args);
    const provider = createProvider(config);
    const solver = new SolveCommand({
      model: config.model, provider, providerName: config.provider,
      autoApprove: !!config.autoApprove, maxIterations: config.maxIterations,
      dryRun: args['dry-run'] !== false && !args['open-pr'], openPr: !!args['open-pr'],
      safe: !!args.safe, maxFiles: parseInt((args['max-files'] as string) || '10', 10) || 10,
      timeoutMin: parseInt((args['timeout-min'] as string) || '20', 10) || 20,
      workspace: typeof args.workspace === 'string' ? args.workspace as string : undefined,
      json: !!args.json, verbose: !!args.verbose,
    });
    console.log(c('\n  CodeBot AI — Issue Solver\n', 'bold'));
    for await (const event of solver.run(solveUrl)) { renderSolveEvent(event, !!args.json); }
    return;
  }

  // ── Daemon mode ──
  if (args.daemon) {
    const config = await resolveConfig(args);
    const provider = createProvider(config);
    const agent = new Agent({
      provider, model: config.model, providerName: config.provider,
      maxIterations: config.maxIterations, autoApprove: true,
    });
    const daemon = new Daemon();
    console.log(c('  CodeBot Daemon starting...', 'cyan'));
    console.log(c('  Press Ctrl+C to stop.', 'dim'));
    await daemon.start();
    return;
  }

  // ── Zero-friction first run ──
  let showGuidedPrompts = false;
  if (isFirstRun() && process.stdin.isTTY && !args.message) {
    const detected = await autoDetect();
    if (detected.type === 'auto-start' && detected.model) {
      const autoConfig: any = { model: detected.model, provider: detected.provider, baseUrl: detected.baseUrl, autoApprove: false, firstRunComplete: true };
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
    else if (isAuto) { console.log(c(`   ${randomGreeting('confident')}`, 'dim')); console.log(formatReaction('autonomous_start')); }
    else console.log(c(`   ${randomGreeting()}\n`, 'dim'));
  }

  if (showGuidedPrompts) {
    const prompts = getContextualPrompts();
    console.log(guidedPrompts(prompts, 'Type /help for commands, /setup to reconfigure'));
    try { const saved = loadConfig(); if (saved.firstRunComplete) { delete saved.firstRunComplete; saveSetupConfig(saved); } } catch { /* ignore */ }
  }

  const agent = new Agent({
    provider, model: config.model, providerName: config.provider,
    maxIterations: config.maxIterations, autoApprove: config.autoApprove,
    onMessage: (msg: Message) => session.save(msg),
  });

  agent.setAskPermission(async (tool, args, risk, sandbox) => {
    const card = permissionCard(tool, args, risk || { score: 0, level: 'green' }, sandbox);
    process.stdout.write(card);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const userResponse = new Promise<boolean>(resolve => { rl.question('Allow? [y/N] ', answer => { rl.close(); resolve(answer.toLowerCase().startsWith('y')); }); });
    const timeout = new Promise<boolean>(resolve => { setTimeout(() => { rl.close(); process.stdout.write('\n\u23f1 Permission timed out — denied by default.\n'); resolve(false); }, 30_000); });
    return Promise.race([userResponse, timeout]);
  });

  if (resumeId) {
    const messages = session.load();
    if (messages.length > 0) { agent.loadMessages(messages); console.log(c(`   Loaded ${messages.length} messages from previous session.`, 'dim')); }
  }

  // ── Dashboard ──
  if (args.dashboard) {
    agent.setAutoApprove(true);
    try {
      // Resolve static dir: prefer src/ (canonical) over dist/ (stale copies)
      const srcStatic = require('path').resolve(__dirname, '..', 'src', 'dashboard', 'static');
      const distStatic = require('path').join(__dirname, 'dashboard', 'static');
      const dashStaticDir = require('fs').existsSync(srcStatic) ? srcStatic : distStatic;
      const dashHost = typeof args.host === 'string' ? args.host : '127.0.0.1';
      const dashServer = new DashboardServer({ port: 3120, host: dashHost, staticDir: dashStaticDir });
      registerApiRoutes(dashServer);
      registerCommandRoutes(dashServer, agent);
      registerCodeAGIRoutes(dashServer);
      registerModelRoutes(dashServer);
      const dashInfo = await dashServer.start();
      console.log(c(`   Dashboard: ${dashInfo.url}`, 'cyan'));
      // Write PID file so stale processes can be identified
      try {
        const pidDir = codebotPath('');
        if (!fs.existsSync(pidDir)) fs.mkdirSync(pidDir, { recursive: true });
        fs.writeFileSync(pidFile, String(process.pid), 'utf8');
      } catch { /* best-effort */ }
      const dashUrl = dashHost === '0.0.0.0' ? `http://localhost:${dashInfo.port}` : dashInfo.url;
      try { const { exec } = require('child_process'); const openCmd = process.platform === 'darwin' ? 'open' : process.platform === 'win32' ? 'start' : 'xdg-open'; exec(`${openCmd} ${dashUrl}`); } catch { /* best-effort */ }
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
        } catch { /* ignore */ }
      }, 30_000);
      watchdog.unref();
    }
  }

  if (typeof args.message === 'string') { await runOnce(agent, args.message); printSessionSummary(agent); return; }
  if (!process.stdin.isTTY) {
    if (args.dashboard) {
      // Dashboard mode with no TTY (backgrounded, launched from .app, etc.)
      // Keep process alive — the HTTP server IS the product, REPL is optional.
      console.log(c('   Dashboard-only mode — no REPL, serving on port 3120.', 'dim'));
      await new Promise(() => {}); // Block forever — HTTP server keeps running
      return;
    }
    const input = await readStdin(); if (input.trim()) { await runOnce(agent, input.trim()); printSessionSummary(agent); } return;
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
  console.log(`  Tokens:    ${summary.totalInputTokens.toLocaleString()} in / ${summary.totalOutputTokens.toLocaleString()} out (${tracker.formatCost()})`);
  console.log(`  Requests:  ${summary.requestCount}`);
  console.log(`  Tools:     ${summary.toolCalls} calls`);
  console.log(`  Files:     ${summary.filesModified} modified`);

  const metrics = agent.getMetrics();
  const snap = metrics.snapshot();
  const toolCounters = snap.counters.filter(c => c.name === 'tool_calls_total');
  if (toolCounters.length > 0) {
    console.log(c('  Per-tool:', 'dim'));
    for (const tc of toolCounters.sort((a, b) => b.value - a.value)) {
      const hist = snap.histograms.find(h => h.name === 'tool_latency_seconds' && h.labels.tool === tc.labels.tool);
      const avg = hist && hist.count > 0 ? (hist.sum / hist.count * 1000).toFixed(0) : '?';
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

  console.log(sessionSummaryBanner({ iterations: summary.requestCount, toolCalls: summary.toolCalls, tokensUsed: summary.totalInputTokens + summary.totalOutputTokens, duration }));
  metrics.save();
  metrics.exportOtel();
}

async function repl(agent: Agent, config: Config, session?: SessionManager, isDashboard: boolean = false) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, prompt: c('> ', 'cyan') });
  rl.prompt();
  rl.on('line', async (line: string) => {
    const input = line.trim();
    if (!input) { rl.prompt(); return; }
    if (input.startsWith('/')) { handleSlashCommand(input, agent, config); rl.prompt(); return; }
    try { for await (const event of agent.run(input)) { renderEvent(event, agent); } }
    catch (err: unknown) { console.error(c(`\nError: ${err instanceof Error ? err.message : String(err)}`, 'red')); }
    console.log();
    rl.prompt();
  });
  rl.on('close', () => {
    printSessionSummary(agent);
    console.log(formatReaction('session_end'));
    // In dashboard mode, keep process alive — dashboard serves independently
    if (isDashboard) {
      console.log(c('   REPL closed — dashboard still running on port 3120.', 'dim'));
    } else {
      process.exit(0);
    }
  });
}

async function runOnce(agent: Agent, message: string) {
  for await (const event of agent.run(message)) { renderEvent(event, agent); }
  console.log();
}

function readStdin(): Promise<string> {
  return new Promise(resolve => {
    let data = '';
    process.stdin.on('data', (chunk: Buffer) => (data += chunk.toString()));
    process.stdin.on('end', () => resolve(data));
  });
}

function getContextualPrompts(): string[] {
  const cwd = process.cwd();
  const isGitRepo = fs.existsSync(path.join(cwd, '.git'));
  const hasPackageJson = fs.existsSync(path.join(cwd, 'package.json'));
  if (isGitRepo && hasPackageJson) return ['"explain what this project does"', '"find and fix any bugs in src/"', '"add tests for the main module"'];
  if (isGitRepo) return ['"summarize the recent git changes"', '"review the code in this repo"', '"help me refactor the main file"'];
  return ['"create a new Node.js project"', '"write a Python script that..."', '"help me set up a React app"'];
}
