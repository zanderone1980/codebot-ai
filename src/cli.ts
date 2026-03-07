import * as readline from 'readline';
import * as fs from 'fs';
import * as path from 'path';
import { Agent } from './agent';
import { OpenAIProvider } from './providers/openai';
import { AnthropicProvider } from './providers/anthropic';
import { detectProvider, PROVIDER_DEFAULTS } from './providers/registry';
import { AgentEvent, Config, LLMProvider, Message } from './types';
import { SessionManager } from './history';
import { loadConfig, isFirstRun, runSetup } from './setup';
import { banner, randomGreeting, compactBanner, formatReaction, sessionSummaryBanner, CODI_FACE, animateBootSequence, animateSessionEnd, shouldAnimate } from './banner';
import { EditFileTool } from './tools';
import { Scheduler } from './scheduler';
import { AuditLogger } from './audit';
import { generateDefaultPolicyFile } from './policy';
import { getSandboxInfo } from './sandbox';
import { ReplayProvider, loadSessionForReplay, compareOutputs, listReplayableSessions } from './replay';
import { RiskScorer } from './risk';
import { exportSarif, sarifToString } from './sarif';
import { UI, permissionCard, summaryBox, box, budgetBar, streamingIndicator, costBadge } from './ui';
import { estimateRunCost } from './telemetry';
import { runDoctor, formatDoctorReport } from './doctor';
import { loadTheme, setTheme, getTheme, getThemeNames } from './theme';
import { autoDetect, runQuickSetup, saveConfig as saveSetupConfig } from './setup';
import { TuiMode } from './tui/tui-mode';
import { animateWelcomeBoot } from './banner';
import { guidedPrompts } from './ui';
import { DashboardServer } from './dashboard/server';
import { registerApiRoutes } from './dashboard/api';
import { registerCommandRoutes } from './dashboard/command-api';

import { VERSION } from './index';
import { SolveCommand, SolveEvent, SolveResult } from './solve';

let verbose = false;

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  cyan: '\x1b[36m',
};

function c(text: string, style: keyof typeof C): string {
  return `${C[style]}${text}${C.reset}`;
}

export async function main() {
  // Process-level safety nets: prevent silent crashes
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

  const args = parseArgs(process.argv.slice(2));

  // Apply theme early (before any output)
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
    console.log(`codebot v${VERSION}`);
    return;
  }

  // Setup wizard
  if (args.setup) {
    await runSetup();
    return;
  }

  // ── v1.7.0: New standalone commands ──

  // --init-policy: Generate default policy file
  if (args['init-policy']) {
    const policyPath = path.join(process.cwd(), '.codebot', 'policy.json');
    const policyDir = path.dirname(policyPath);
    if (!fs.existsSync(policyDir)) fs.mkdirSync(policyDir, { recursive: true });
    if (fs.existsSync(policyPath)) {
      console.log(c(`Policy file already exists at ${policyPath}`, 'yellow'));
      console.log(c('Delete it first if you want to regenerate.', 'dim'));
    } else {
      fs.writeFileSync(policyPath, generateDefaultPolicyFile(), 'utf-8');
      console.log(c(`Created default policy at ${policyPath}`, 'green'));
    }
    return;
  }

  // --verify-audit: Verify audit chain integrity
  if (args['verify-audit']) {
    const logger = new AuditLogger();
    const sessionId = typeof args['verify-audit'] === 'string' ? args['verify-audit'] as string : undefined;
    if (sessionId) {
      const entries = logger.query({ sessionId });
      if (entries.length === 0) {
        console.log(c(`No audit entries found for session ${sessionId}`, 'yellow'));
        return;
      }
      const result = AuditLogger.verify(entries);
      if (result.valid) {
        console.log(c(`Audit chain valid (${result.entriesChecked} entries checked)`, 'green'));
      } else {
        console.log(c(`Audit chain INVALID at sequence ${result.firstInvalidAt}`, 'red'));
        console.log(c(`Reason: ${result.reason}`, 'red'));
      }
    } else {
      // Verify all entries from today's log
      const entries = logger.query();
      if (entries.length === 0) {
        console.log(c('No audit entries found.', 'yellow'));
        return;
      }
      // Group by session and verify each
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

  // --sandbox-info: Show sandbox status
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

  // --replay: Replay a saved session
  if (args.replay) {
    const replayId = typeof args.replay === 'string'
      ? args.replay as string
      : SessionManager.latest();

    if (!replayId) {
      console.log(c('No session to replay. Specify an ID or ensure a previous session exists.', 'yellow'));
      return;
    }

    const data = loadSessionForReplay(replayId);
    if (!data) {
      console.log(c(`Session ${replayId} not found or empty.`, 'red'));
      return;
    }

    console.log(c(`\nReplaying session ${replayId.substring(0, 12)}...`, 'cyan'));
    console.log(c(`  ${data.messages.length} messages (${data.userMessages.length} user, ${data.assistantMessages.length} assistant)`, 'dim'));

    const replayProvider = new ReplayProvider(data.assistantMessages);
    const config = await resolveConfig(args);
    const agent = new Agent({
      provider: replayProvider,
      model: config.model,
      providerName: 'replay',
      autoApprove: true,
    });

    // Collect recorded tool results in order for sequential comparison
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
            if (diff) {
              divergences++;
              console.log(c(`  ⚠ Divergence in ${event.toolResult.name || 'tool'}:`, 'yellow'));
              console.log(c(`    ${diff.split('\n').join('\n    ')}`, 'dim'));
            } else {
              console.log(c(`  ✓ ${event.toolResult.name || 'tool'} — output matches`, 'green'));
            }
          }
        } else if (event.type === 'text') {
          process.stdout.write(c('.', 'dim'));
        }
      }
    }

    console.log(c(`\n\nReplay complete.`, 'bold'));
    if (divergences === 0) {
      console.log(c('  All tool outputs match — session is reproducible.', 'green'));
    } else {
      console.log(c(`  ${divergences} divergence(s) detected — environment may have changed.`, 'yellow'));
    }
    return;
  }

  // --export-audit sarif: Export audit log as SARIF 2.1.0
  if (args['export-audit'] === 'sarif' || args['export-audit'] === true) {
    const logger = new AuditLogger();
    const sessionId = typeof args['session'] === 'string' ? args['session'] as string : undefined;
    const entries = sessionId ? logger.query({ sessionId }) : logger.query();
    if (entries.length === 0) {
      console.error(c('No audit entries found.', 'yellow'));
      process.exit(1);
    }
    const sarif = exportSarif(entries, { version: VERSION, sessionId });
    process.stdout.write(sarifToString(sarif) + '\n');
    return;
  }

  // --doctor: Environment health check
  if (args.doctor) {
    const report = await runDoctor();
    console.log(formatDoctorReport(report));
    process.exit(report.failed > 0 ? 1 : 0);
  }

  // ── Solve command: autonomous GitHub issue solver ──
  if (args.solve) {
    const solveUrl = typeof args.solve === 'string' ? args.solve as string : (args.message as string);
    if (!solveUrl) {
      console.error(c('Error: provide a GitHub issue URL.\n  Usage: codebot --solve https://github.com/owner/repo/issues/123', 'red'));
      process.exit(1);
    }

    const config = await resolveConfig(args);
    const provider = createProvider(config);

    const solver = new SolveCommand({
      model: config.model,
      provider,
      providerName: config.provider,
      autoApprove: !!config.autoApprove,
      maxIterations: config.maxIterations,
      dryRun: args['dry-run'] !== false && !args['open-pr'],
      openPr: !!args['open-pr'],
      safe: !!args.safe,
      maxFiles: parseInt((args['max-files'] as string) || '10', 10) || 10,
      timeoutMin: parseInt((args['timeout-min'] as string) || '20', 10) || 20,
      workspace: typeof args.workspace === 'string' ? args.workspace as string : undefined,
      json: !!args.json,
      verbose: !!args.verbose,
    });

    console.log(c('\n  CodeBot AI — Issue Solver\n', 'bold'));
    for await (const event of solver.run(solveUrl)) {
      renderSolveEvent(event, !!args.json);
    }
    return;
  }

  // Zero-friction first run: auto-detect or one-question setup
  let showGuidedPrompts = false;
  if (isFirstRun() && process.stdin.isTTY && !args.message) {
    const detected = await autoDetect();
    if (detected.type === 'auto-start' && detected.model) {
      // Auto-start: save config silently, fall through to boot
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
      // One-question setup
      const quickConfig = await runQuickSetup(detected);
      if (!quickConfig.model) return; // user aborted
      showGuidedPrompts = true;
    }
  }

  const config = await resolveConfig(args);
  const provider = createProvider(config);

  // Verbose mode
  verbose = !!args.verbose;

  // Deterministic mode: set temperature=0
  if (args.deterministic) {
    provider.temperature = 0;
    console.log(c('  Deterministic mode: temperature=0', 'dim'));
  }

  // Session management
  let resumeId: string | undefined;
  if (args.continue) {
    resumeId = SessionManager.latest();
    if (!resumeId) {
      console.log(c('No previous session found.', 'yellow'));
    }
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
    if (resumeId) {
      console.log(c(`   ${randomGreeting('resuming')}`, 'green'));
    } else if (isAuto) {
      console.log(formatReaction('autonomous_start'));
    }
  } else {
    console.log(banner(VERSION, config.model, providerLabel, `${sessionShort}...`, isAuto));
    if (resumeId) {
      console.log(c(`   ${randomGreeting('resuming')}`, 'green'));
    } else if (isAuto) {
      console.log(c(`   ${randomGreeting('confident')}`, 'dim'));
      console.log(formatReaction('autonomous_start'));
    } else {
      console.log(c(`   ${randomGreeting()}\n`, 'dim'));
    }
  }

  // Guided first session: show contextual suggestions
  if (showGuidedPrompts) {
    const prompts = getContextualPrompts();
    console.log(guidedPrompts(prompts, 'Type /help for commands, /setup to reconfigure'));
    // Clear the flag so prompts don't show again
    try {
      const saved = loadConfig();
      if (saved.firstRunComplete) {
        delete saved.firstRunComplete;
        saveSetupConfig(saved);
      }
    } catch { /* ignore */ }
  }

  const agent = new Agent({
    provider,
    model: config.model,
    providerName: config.provider,
    maxIterations: config.maxIterations,
    autoApprove: config.autoApprove,
    onMessage: (msg: Message) => session.save(msg),
  });

  // Wire up the enhanced permission card UI
  agent.setAskPermission(async (tool, args, risk, sandbox) => {
    const card = permissionCard(tool, args, risk || { score: 0, level: 'green' }, sandbox);
    process.stdout.write(card);
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    const userResponse = new Promise<boolean>(resolve => {
      rl.question('Allow? [y/N] ', answer => {
        rl.close();
        resolve(answer.toLowerCase().startsWith('y'));
      });
    });
    const timeout = new Promise<boolean>(resolve => {
      setTimeout(() => {
        rl.close();
        process.stdout.write('\n⏱ Permission timed out — denied by default.\n');
        resolve(false);
      }, 30_000);
    });
    return Promise.race([userResponse, timeout]);
  });

  // Resume: load previous messages
  if (resumeId) {
    const messages = session.load();
    if (messages.length > 0) {
      agent.loadMessages(messages);
      console.log(c(`   Loaded ${messages.length} messages from previous session.`, 'dim'));
    }
  }

  // ── Dashboard server (--dashboard flag) ──
  if (args.dashboard) {
    // Dashboard is the user's control plane — terminal permission prompts are useless
    agent.setAutoApprove(true);
    try {
      const dashStaticDir = require('path').join(__dirname, 'dashboard', 'static');
      const dashHost = typeof args.host === 'string' ? args.host : '127.0.0.1';
      const dashServer = new DashboardServer({ port: 3120, host: dashHost, staticDir: dashStaticDir });
      const os = require('os');
      registerApiRoutes(dashServer, os.homedir());
      registerCommandRoutes(dashServer, agent);
      const dashInfo = await dashServer.start();
      console.log(c(`   Dashboard: ${dashInfo.url}`, 'cyan'));
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : String(err);
      console.log(c(`   Dashboard failed: ${msg}`, 'yellow'));
    }
  }

  // Non-interactive: single message from CLI args
  if (typeof args.message === 'string') {
    await runOnce(agent, args.message);
    printSessionSummary(agent);
    return;
  }

  // Non-interactive: piped stdin
  if (!process.stdin.isTTY) {
    const input = await readStdin();
    if (input.trim()) {
      await runOnce(agent, input.trim());
      printSessionSummary(agent);
    }
    return;
  }

  // Start the routine scheduler in the background
  const scheduler = new Scheduler(agent, (text) => process.stdout.write(text));
  scheduler.start();

  // Interactive REPL
  await repl(agent, config, session);

  // Cleanup scheduler on exit
  scheduler.stop();
}

/** Print session summary with tokens, cost, tool calls, files modified, metrics */
function printSessionSummary(agent: Agent) {
  const tracker = agent.getTokenTracker();
  tracker.saveUsage();
  const summary = tracker.getSummary();

  const duration = (new Date(summary.endTime).getTime() - new Date(summary.startTime).getTime()) / 1000;
  const mins = Math.floor(duration / 60);
  const secs = Math.floor(duration % 60);

  console.log(c('\n── Session Summary ──', 'dim'));
  console.log(`  Duration:  ${mins}m ${secs}s`);
  console.log(`  Model:     ${summary.model} via ${summary.provider}`);
  console.log(`  Tokens:    ${summary.totalInputTokens.toLocaleString()} in / ${summary.totalOutputTokens.toLocaleString()} out (${tracker.formatCost()})`);
  console.log(`  Requests:  ${summary.requestCount}`);
  console.log(`  Tools:     ${summary.toolCalls} calls`);
  console.log(`  Files:     ${summary.filesModified} modified`);

  // v1.9.0: Per-tool breakdown from MetricsCollector
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

  // Per-tool cost breakdown
  const toolCostBreakdown = tracker.getToolCostBreakdown();
  if (toolCostBreakdown.length > 0) {
    console.log(c('  Cost by tool:', 'dim'));
    for (const entry of toolCostBreakdown.slice(0, 5)) {
      const cost = entry.costUsd === 0 ? 'free' : `$${entry.costUsd.toFixed(4)}`;
      console.log(c(`    ${entry.tool}: ${entry.calls} calls, ${cost} (${entry.pctOfTotal.toFixed(1)}%)`, 'dim'));
    }
  }

  // Risk summary
  const riskScorer = agent.getRiskScorer();
  const riskAvg = riskScorer.getSessionAverage();
  if (riskScorer.getHistory().length > 0) {
    console.log(`  Risk:      avg ${riskAvg}/100`);
  }

  // Codi's session summary banner
  console.log(sessionSummaryBanner({
    iterations: summary.requestCount,
    toolCalls: summary.toolCalls,
    tokensUsed: summary.totalInputTokens + summary.totalOutputTokens,
    duration,
  }));

  // Save metrics
  metrics.save();
  metrics.exportOtel();
}

function createProvider(config: Config): LLMProvider {
  if (config.provider === 'anthropic') {
    return new AnthropicProvider({
      baseUrl: config.baseUrl,
      apiKey: config.apiKey,
      model: config.model,
    });
  }

  return new OpenAIProvider({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    model: config.model,
  });
}

async function repl(agent: Agent, config: Config, session?: SessionManager) {
  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stdout,
    prompt: c('> ', 'cyan'),
  });

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
      const msg = err instanceof Error ? err.message : String(err);
      console.error(c(`\nError: ${msg}`, 'red'));
    }

    console.log();
    rl.prompt();
  });

  rl.on('close', () => {
    printSessionSummary(agent);
    console.log(formatReaction('session_end'));
    process.exit(0);
  });
}

async function runOnce(agent: Agent, message: string) {
  for await (const event of agent.run(message)) {
    renderEvent(event, agent);
  }
  console.log();
}

let isThinking = false;

function renderEvent(event: AgentEvent, agent?: Agent) {
  switch (event.type) {
    case 'thinking':
      if (!isThinking) {
        process.stdout.write(c('\n💭 ', 'dim'));
        isThinking = true;
      }
      process.stdout.write(c(event.text || '', 'dim'));
      break;
    case 'text':
      if (isThinking) {
        process.stdout.write('\n');
        isThinking = false;
      }
      process.stdout.write(event.text || '');
      break;
    case 'tool_call':
      if (isThinking) {
        process.stdout.write('\n');
        isThinking = false;
      }
      {
        const risk = event.risk || { score: 0, level: 'green' };
        const riskColor = risk.level === 'red' ? UI.red : risk.level === 'orange' ? UI.orange : risk.level === 'yellow' ? UI.yellow : UI.green;
        console.log(`\n${UI.bold}${riskColor}⚡${UI.reset} ${UI.bold}${event.toolCall?.name}${UI.reset} ${riskColor}[${risk.score}]${UI.reset}`);
        if (event.toolCall?.args) {
          for (const [k, v] of Object.entries(event.toolCall.args)) {
            const val = typeof v === 'string' ? (v.length > 80 ? v.substring(0, 80) + '...' : v) : JSON.stringify(v);
            console.log(`${UI.dim}  ${k}: ${val}${UI.reset}`);
          }
        }
      }
      break;
    case 'tool_result':
      if (event.toolResult?.is_error) {
        console.log(`${UI.red}  ✗ ${truncate(event.toolResult.result, 200)}${UI.reset}`);
      } else {
        const result = event.toolResult?.result || '';
        const lines = result.split('\n');
        if (lines.length > 5 && !verbose) {
          console.log(`${UI.brightGreen}  ✓${UI.reset} ${UI.dim}(${lines.length} lines, use --verbose to expand)${UI.reset}`);
        } else if (lines.length > 10) {
          console.log(`${UI.brightGreen}  ✓${UI.reset} ${UI.dim}(${lines.length} lines)${UI.reset}`);
        } else {
          console.log(`${UI.brightGreen}  ✓${UI.reset} ${truncate(result, 200)}`);
        }
      }
      break;
    case 'usage':
      if (verbose && event.usage && agent) {
        const tracker = agent.getTokenTracker();
        const parts: string[] = [];
        if (event.usage.inputTokens) parts.push(`in: ${event.usage.inputTokens}`);
        if (event.usage.outputTokens) parts.push(`out: ${event.usage.outputTokens}`);
        if (parts.length > 0) {
          console.log(c(`  [${parts.join(', ')} tokens | ${tracker.formatCost()}]`, 'dim'));
        }
        // Show budget bar when cost limit is active
        const costSoFar = tracker.getTotalCost();
        const costLimit2 = agent.getPolicyEnforcer().getCostLimitUsd();
        if (costLimit2 > 0) {
          console.log(`  ${budgetBar(costSoFar, costLimit2)}`);
        }
      }
      break;
    case 'compaction':
      console.log(c(`\n📦 ${event.text}`, 'dim'));
      break;
    case 'error':
      console.error(c(`\n✗ ${event.error}`, 'red'));
      break;
    case 'stream_progress':
      // Streaming indicator handled in TUI mode
      break;
    case 'done':
      if (isThinking) {
        process.stdout.write('\n');
        isThinking = false;
      }
      break;
  }
}

function formatArgs(args?: Record<string, unknown>): string {
  if (!args) return '';
  return Object.entries(args)
    .map(([k, v]) => {
      const val = typeof v === 'string' ? truncate(v, 60) : JSON.stringify(v);
      return `${k}: ${val}`;
    })
    .join(', ');
}

function truncate(s: string, max: number): string {
  return s.length <= max ? s : s.substring(0, max) + '...';
}

function handleSlashCommand(input: string, agent: Agent, config: Config) {
  const [cmd, ...rest] = input.split(/\s+/);
  switch (cmd) {
    case '/help':
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
      break;
    case '/model':
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
      break;
    case '/models':
      showModels();
      break;
    case '/clear':
      agent.clearHistory();
      console.log(c('Conversation cleared.', 'dim'));
      break;
    case '/compact': {
      const stats = agent.forceCompact();
      console.log(c(`Context compacted: ${stats.before} → ${stats.after} messages.`, 'dim'));
      break;
    }
    case '/auto':
      config.autoApprove = !config.autoApprove;
      agent.setAutoApprove(config.autoApprove);
      console.log(c(`Autonomous mode: ${config.autoApprove ? 'ON' : 'OFF'}`, config.autoApprove ? 'yellow' : 'green'));
      break;
    case '/sessions': {
      const sessions = SessionManager.list();
      if (sessions.length === 0) {
        console.log(c('No saved sessions.', 'dim'));
      } else {
        console.log(c('\nSaved sessions:', 'bold'));
        for (const s of sessions) {
          const date = s.updated ? new Date(s.updated).toLocaleString() : 'unknown';
          console.log(`  ${c(s.id.substring(0, 8), 'cyan')}  ${date}  ${s.messageCount} msgs  ${c(s.preview || '(empty)', 'dim')}`);
        }
        console.log(c(`\nResume with: codebot --resume <id>`, 'dim'));
      }
      break;
    }
    case '/undo': {
      const undoPath = rest.length > 0 ? rest.join(' ') : undefined;
      const undoResult = EditFileTool.undo(undoPath);
      console.log(c(undoResult, undoResult.includes('Restored') ? 'green' : 'yellow'));
      break;
    }
    case '/usage': {
      const tracker = agent.getTokenTracker();
      const summary = tracker.getSummary();
      console.log(c('\nSession Usage:', 'bold'));
      console.log(`  Input:    ${summary.totalInputTokens.toLocaleString()} tokens`);
      console.log(`  Output:   ${summary.totalOutputTokens.toLocaleString()} tokens`);
      console.log(`  Cost:     ${tracker.formatCost()}`);
      console.log(`  Requests: ${summary.requestCount}`);
      console.log(`  Tools:    ${summary.toolCalls} calls`);
      console.log(`  Files:    ${summary.filesModified} modified`);
      break;
    }
    case '/cost': {
      const tracker = agent.getTokenTracker();
      console.log(c(`  ${tracker.formatStatusLine()}`, 'dim'));
      break;
    }
    case '/metrics': {
      const metricsOutput = agent.getMetrics().formatSummary();
      console.log('\n' + metricsOutput);
      break;
    }
    case '/risk': {
      const riskHistory = agent.getRiskScorer().getHistory();
      if (riskHistory.length === 0) {
        console.log(c('No risk assessments yet.', 'dim'));
      } else {
        const avg = agent.getRiskScorer().getSessionAverage();
        console.log(c(`\nRisk Summary: ${riskHistory.length} assessments, avg ${avg}/100`, 'bold'));
        const last5 = riskHistory.slice(-5);
        for (const a of last5) {
          console.log(`  ${RiskScorer.formatIndicator(a)}`);
        }
      }
      break;
    }
    case '/policy': {
      const policy = agent.getPolicyEnforcer().getPolicy();
      console.log(c('\nCurrent Policy:', 'bold'));
      console.log(JSON.stringify(policy, null, 2));
      break;
    }
    case '/audit': {
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
      break;
    }
    case '/routines': {
      const { RoutineTool } = require('./tools/routine');
      const rt = new RoutineTool();
      rt.execute({ action: 'list' })
        .then((out: string) => console.log('\n' + out))
        .catch((err: unknown) => {
          const msg = err instanceof Error ? err.message : String(err);
          console.error(c(`Error listing routines: ${msg}`, 'red'));
        });
      break;
    }
    case '/rate': {
      const rl2 = agent.getProviderRateLimiter();
      const util = rl2.getUtilization();
      const cfg = rl2.getConfig();
      console.log(c('\nProvider Rate Limits:', 'bold'));
      console.log(`  Provider:    ${cfg.provider}`);
      console.log(`  RPM:         ${util.rpmPercent}% (limit: ${cfg.requestsPerMinute}/min)`);
      console.log(`  TPM:         ${util.tpmPercent}% (limit: ${cfg.tokensPerMinute.toLocaleString()}/min)`);
      console.log(`  Concurrent:  ${util.concurrentPercent}% (limit: ${cfg.concurrentRequests})`);
      break;
    }
    case '/theme': {
      if (rest.length > 0) {
        const themeName = rest[0];
        const available = getThemeNames();
        if (available.includes(themeName)) {
          setTheme(loadTheme(themeName));
          console.log(c(`Theme set to: ${themeName}`, 'green'));
        } else {
          console.log(c(`Unknown theme: ${themeName}. Available: ${available.join(', ')}`, 'yellow'));
        }
      } else {
        const current = getTheme();
        const available = getThemeNames();
        console.log(`Current theme: ${current.name}`);
        console.log(c(`Available: ${available.join(', ')}`, 'dim'));
      }
      break;
    }
    case '/doctor': {
      runDoctor().then(report => {
        console.log(formatDoctorReport(report));
      });
      break;
    }
    case '/toolcost': {
      const tracker = agent.getTokenTracker();
      console.log('\n' + tracker.formatToolCostBreakdown());
      break;
    }
    case '/config':
      console.log(JSON.stringify({ ...config, apiKey: config.apiKey ? '***' : undefined }, null, 2));
      break;
    case '/quit':
    case '/exit':
      process.exit(0);
    case '/apps': {
      try {
        const { VaultManager } = require('./vault');
        const { ConnectorRegistry } = require('./connectors/registry');
        const { GitHubConnector } = require('./connectors/github');
        const { SlackConnector } = require('./connectors/slack');
        const { JiraConnector } = require('./connectors/jira');
        const { LinearConnector } = require('./connectors/linear');
        const { OpenAIImagesConnector } = require('./connectors/openai-images');
        const { ReplicateConnector } = require('./connectors/replicate');
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
      } catch (err) {
        console.log(c('App connectors not available.', 'dim'));
      }
      break;
    }
    case '/connect': {
      const appName = rest[0];
      if (!appName) {
        console.log(c('Usage: /connect <app> (e.g., /connect github)', 'yellow'));
        break;
      }
      console.log(c(`To connect ${appName}, set the appropriate env var or use the app tool:`, 'dim'));
      console.log(c(`  In chat: "connect my ${appName} account"`, 'cyan'));
      console.log(c(`  Or set: export GITHUB_TOKEN=... (for GitHub)`, 'dim'));
      break;
    }
    default:
      console.log(c(`Unknown command: ${cmd}. Type /help`, 'yellow'));
  }
}

function showModels() {
  const { MODEL_REGISTRY } = require('./providers/registry');
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

async function resolveConfig(args: Record<string, string | boolean>): Promise<Config> {
  const saved = loadConfig();

  const model = (args.model as string) || process.env.CODEBOT_MODEL || saved.model || 'qwen2.5-coder:32b';
  const detected = detectProvider(model);

  const config: Config = {
    provider: (args.provider as string) || process.env.CODEBOT_PROVIDER || saved.provider || detected || 'openai',
    model,
    baseUrl: (args['base-url'] as string) || process.env.CODEBOT_BASE_URL || saved.baseUrl || '',
    apiKey: (args['api-key'] as string) || '',
    maxIterations: Math.max(1, Math.min(parseInt((args['max-iterations'] as string) || String(saved.maxIterations || 50), 10) || 50, 500)),
    autoApprove: !!args['auto-approve'] || !!args.autonomous || !!args.auto || !!saved.autoApprove,
  };

  if (!config.baseUrl || !config.apiKey) {
    const defaults = PROVIDER_DEFAULTS[config.provider];
    if (defaults) {
      if (!config.baseUrl) config.baseUrl = defaults.baseUrl;
      if (!config.apiKey) config.apiKey = process.env[defaults.envKey] || process.env.CODEBOT_API_KEY || '';
    }
  }

  if (!config.apiKey && saved.apiKey) {
    config.apiKey = saved.apiKey;
  }
  if (!config.apiKey) {
    config.apiKey = process.env.CODEBOT_API_KEY || process.env.OPENAI_API_KEY || '';
  }

  if (!config.baseUrl) {
    config.baseUrl = await autoDetectProvider();
  }

  // Validate base URL format
  if (config.baseUrl && !config.baseUrl.startsWith('http://') && !config.baseUrl.startsWith('https://')) {
    console.log(c(`  ⚠ Invalid base URL: "${config.baseUrl}". Must start with http:// or https://`, 'yellow'));
    config.baseUrl = 'http://localhost:11434';
  }

  // Early API key warning for cloud providers
  const isLocal = config.baseUrl.includes('localhost') || config.baseUrl.includes('127.0.0.1');
  if (!isLocal && !config.apiKey) {
    console.log(c(`  ⚠ No API key found for ${config.provider}. Run: codebot --setup`, 'yellow'));
  }

  return config;
}

async function autoDetectProvider(): Promise<string> {
  const candidates = [
    { url: 'http://localhost:11434', name: 'Ollama' },
    { url: 'http://localhost:1234', name: 'LM Studio' },
    { url: 'http://localhost:8000', name: 'vLLM' },
  ];

  for (const { url, name } of candidates) {
    try {
      const res = await fetch(`${url}/v1/models`, {
        signal: AbortSignal.timeout(2000),
      });
      if (res.ok) {
        console.log(c(`  ✓ ${name} detected on ${url}`, 'green'));
        return url;
      }
    } catch {
      // not running
    }
  }

  console.log(c('  ⚠ No local LLM detected. Start Ollama or set --base-url', 'yellow'));
  return 'http://localhost:11434';
}

function parseArgs(argv: string[]): Record<string, string | boolean> {
  const result: Record<string, string | boolean> = {};
  const positional: string[] = [];

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      result.help = true;
      continue;
    }
    if (arg === '--version' || arg === '-v') {
      result.version = true;
      continue;
    }
    if (arg === '--auto-approve' || arg === '--autonomous' || arg === '--auto') {
      result['auto-approve'] = true;
      result.autonomous = true;
      result.auto = true;
      continue;
    }
    if (arg === '--continue' || arg === '-c') {
      result.continue = true;
      continue;
    }
    if (arg === '--setup' || arg === '--init') {
      result.setup = true;
      continue;
    }
    if (arg === '--init-policy') {
      result['init-policy'] = true;
      continue;
    }
    if (arg === '--sandbox-info') {
      result['sandbox-info'] = true;
      continue;
    }
    if (arg === '--verify-audit') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        result['verify-audit'] = next;
        i++;
      } else {
        result['verify-audit'] = true;
      }
      continue;
    }
    if (arg === '--export-audit') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        result['export-audit'] = next;
        i++;
      } else {
        result['export-audit'] = true;
      }
      continue;
    }
    if (arg === '--replay') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        result['replay'] = next;
        i++;
      } else {
        result['replay'] = true; // replay latest
      }
      continue;
    }
    if (arg === '--dashboard') {
      result.dashboard = true;
      continue;
    }
    if (arg === '--host') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        result.host = next;
        i++;
      }
      continue;
    }
    if (arg === '--tui') {
      result.tui = true;
      continue;
    }
    if (arg === '--no-stream') {
      result.noStream = true;
      continue;
    }
    if (arg === '--theme') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        result.theme = next;
        i++;
      } else {
        result.theme = true;
      }
      continue;
    }
    if (arg === '--doctor') {
      result.doctor = true;
      continue;
    }
    if (arg === '--solve') {
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        result['solve'] = next;
        i++;
      } else {
        result['solve'] = true;
      }
      continue;
    }
    if (arg === '--open-pr') {
      result['open-pr'] = true;
      continue;
    }
    if (arg === '--safe') {
      result['safe'] = true;
      continue;
    }
    if (arg === '--no-constitutional') {
      result['no-constitutional'] = true;
      continue;
    }
    if (arg === '--dry-run' || arg === '--estimate') {
      result['dry-run'] = true;
      continue;
    }
    if (arg === '--deterministic') {
      result['deterministic'] = true;
      continue;
    }
    if (arg.startsWith('--')) {
      const key = arg.slice(2);
      const next = argv[i + 1];
      if (next && !next.startsWith('--')) {
        result[key] = next;
        i++;
      } else {
        result[key] = true;
      }
      continue;
    }
    positional.push(arg);
  }

  if (positional.length > 0) {
    result.message = positional.join(' ');
  }

  return result;
}

function readStdin(): Promise<string> {
  return new Promise(resolve => {
    let data = '';
    process.stdin.on('data', (chunk: Buffer) => (data += chunk.toString()));
    process.stdin.on('end', () => resolve(data));
  });
}

function showHelp() {
  console.log(`${c('CodeBot AI', 'bold')} - Local-first AI coding assistant

${c('Quick Start:', 'bold')}
  codebot --setup                  Run interactive setup wizard
  codebot                          Start interactive mode
  codebot "fix the bug in app.ts"  Single message mode
  echo "explain this" | codebot    Pipe mode

${c('Options:', 'bold')}
  --setup              Run the setup wizard (auto-runs on first use)
  --model <name>       Model to use (default: qwen2.5-coder:32b)
  --provider <name>    Provider: openai, anthropic, gemini, deepseek, groq, mistral, xai
  --base-url <url>     LLM API base URL (auto-detects Ollama/LM Studio/vLLM + cloud)
  --api-key <key>      API key (or set provider-specific env var)
  --dashboard          Start web dashboard on port 3120
  --host <addr>        Dashboard bind address (default: 127.0.0.1, use 0.0.0.0 for LAN)
  --tui                Full-screen TUI mode with panels
  --no-stream          Suppress streaming progress indicators
  --theme <name>       Theme: dark, light, mono (default: auto)
  --autonomous         Skip ALL permission prompts — full auto mode
  --auto-approve       Same as --autonomous
  --resume <id>        Resume a previous session by ID
  --continue, -c       Resume the most recent session
  --max-iterations <n> Max agent loop iterations (default: 50)
  --sandbox <mode>     Execution sandbox: docker, host, auto (default: auto)
  -h, --help           Show this help
  -v, --version        Show version

${c('Security & Policy:', 'bold')}
  --init-policy        Generate default .codebot/policy.json
  --verify-audit [id]  Verify audit log hash chain integrity
  --export-audit sarif Export audit log as SARIF 2.1.0 JSON
  --sandbox-info       Show Docker sandbox status

${c('Diagnostics:', 'bold')}
  --doctor             Run environment health check
  --dry-run, --estimate Estimate cost without executing

${c('Issue Solving:', 'bold')}
  --solve <url>          Solve a GitHub issue autonomously
  --open-pr              Push branch and create PR (default: dry-run)
  --safe                 Conservative mode (max 3 files, no dep changes)
  --max-files <n>        Max files to modify (default: 10)
  --timeout-min <n>      Hard timeout in minutes (default: 20)
  --json                 Structured JSON output

${c('Constitutional Safety:', 'bold')}
  --no-constitutional    Disable CORD + VIGIL safety layer
  (enabled by default — 14-dimension constitutional evaluation + threat patrol)

${c('Debugging & Replay:', 'bold')}
  --replay [id]        Replay a session, re-execute tools, compare outputs
  --deterministic      Set temperature=0 for reproducible outputs

${c('Supported Providers:', 'bold')}
  Local:      Ollama, LM Studio, vLLM (auto-detected)
  Anthropic:  Claude Opus/Sonnet/Haiku (ANTHROPIC_API_KEY)
  OpenAI:     GPT-4o, GPT-4.1, o1/o3/o4 (OPENAI_API_KEY)
  Google:     Gemini 2.5/2.0/1.5 (GEMINI_API_KEY)
  DeepSeek:   deepseek-chat, deepseek-reasoner (DEEPSEEK_API_KEY)
  Groq:       Llama, Mixtral on Groq (GROQ_API_KEY)
  Mistral:    mistral-large, codestral (MISTRAL_API_KEY)
  xAI:        Grok-3 (XAI_API_KEY)

${c('Examples:', 'bold')}
  codebot --model claude-opus-4-6          Uses Anthropic API
  codebot --model gpt-4o                   Uses OpenAI API
  codebot --model gemini-2.5-pro           Uses Gemini API
  codebot --model deepseek-chat            Uses DeepSeek API
  codebot --model qwen2.5-coder:32b        Uses local Ollama
  codebot --autonomous "refactor src/"     Full auto, no prompts
  codebot --init-policy                    Create security policy
  codebot --verify-audit                   Check audit integrity
  codebot --export-audit sarif > r.sarif   Export SARIF report

${c('Interactive Commands:', 'bold')}
  /help      Show commands
  /model     Show or change model
  /models    List all supported models
  /sessions  List saved sessions
  /auto      Toggle autonomous mode
  /clear     Clear conversation
  /compact   Force context compaction
  /usage     Show token usage & cost
  /cost      Show running cost
  /metrics   Show session metrics
  /risk      Show risk assessment summary
  /policy    Show security policy
  /audit     Verify session audit chain
  /rate      Show provider rate limits
  /theme     Show or change theme
  /doctor    Run environment health check
  /toolcost  Show per-tool cost breakdown
  /config    Show configuration
  /quit      Exit`);
}

function renderSolveEvent(event: SolveEvent, jsonMode: boolean): void {
  if (jsonMode && event.type === 'result' && event.result) {
    console.log(JSON.stringify(event.result, null, 2));
    return;
  }

  switch (event.type) {
    case 'phase_start':
      console.log(c(`  >> ${event.phase}: ${event.message}`, 'cyan'));
      break;
    case 'phase_end':
      console.log(c(`     Done: ${event.message}`, 'green'));
      break;
    case 'progress':
      console.log(c(`     ${event.message}`, 'dim'));
      break;
    case 'agent_event':
      if (event.agentEvent?.type === 'text' && event.agentEvent.text) {
        process.stdout.write(event.agentEvent.text);
      } else if (event.agentEvent?.type === 'tool_call' && event.agentEvent.toolCall) {
        console.log(c(`     [tool] ${event.agentEvent.toolCall.name}`, 'dim'));
      } else if (event.agentEvent?.type === 'tool_result' && event.agentEvent.toolResult) {
        const r = event.agentEvent.toolResult;
        const preview = r.result.substring(0, 80).replace(/\n/g, ' ');
        console.log(c(`     [result] ${r.name}: ${preview}${r.result.length > 80 ? '...' : ''}`, 'dim'));
      }
      break;
    case 'error':
      console.error(c(`  ✗ Error: ${event.error}`, 'red'));
      break;
    case 'result':
      if (event.result) {
        renderSolveResult(event.result);
      }
      break;
  }
}

function renderSolveResult(r: SolveResult): void {
  const lines = [
    '',
    c('  ═══════════════════════════════════════════', 'cyan'),
    c('  SOLVE RESULT', 'bold'),
    c('  ═══════════════════════════════════════════', 'cyan'),
    `  Session:    ${r.sessionId}`,
    `  Issue:      #${r.issue.number} "${r.issue.title}"`,
    `  Repo:       ${r.issue.owner}/${r.issue.repo}`,
    `  Branch:     ${r.branch}`,
    `  Files:      ${r.filesModified.length} changed`,
  ];

  if (r.filesModified.length > 0) {
    for (const f of r.filesModified) {
      lines.push(`              - ${f}`);
    }
  }

  lines.push(`  Tests:      ${r.testsPassed ? c('PASSED', 'green') : r.testsOutput ? c('FAILED', 'red') : c('N/A', 'yellow')}`);
  lines.push(`  Confidence: ${r.confidence}%`);
  lines.push(`  Risk:       ${r.risk}`);
  lines.push(`  Duration:   ${(r.durationMs / 1000).toFixed(1)}s`);
  lines.push(`  Tokens:     ${r.tokensUsed.toLocaleString()}`);
  lines.push(`  Cost:       ${r.cost}`);

  if (r.prUrl) {
    lines.push(`  PR:         ${c(r.prUrl, 'cyan')}`);
  }

  lines.push(c('  ═══════════════════════════════════════════', 'cyan'));
  lines.push('');

  console.log(lines.join('\n'));
}


// ── Guided first-session prompts ──

function getContextualPrompts(): string[] {
  const cwd = process.cwd();
  const isGitRepo = fs.existsSync(path.join(cwd, '.git'));
  const hasPackageJson = fs.existsSync(path.join(cwd, 'package.json'));

  if (isGitRepo && hasPackageJson) {
    return [
      '"explain what this project does"',
      '"find and fix any bugs in src/"',
      '"add tests for the main module"',
    ];
  } else if (isGitRepo) {
    return [
      '"summarize the recent git changes"',
      '"review the code in this repo"',
      '"help me refactor the main file"',
    ];
  } else {
    return [
      '"create a new Node.js project"',
      '"write a Python script that..."',
      '"help me set up a React app"',
    ];
  }
}
