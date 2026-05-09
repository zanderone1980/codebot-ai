/**
 * Early-return CLI subcommand handlers extracted from cli.ts:main().
 *
 * Each handler corresponds to one of the early-return branches in the
 * original main() function. Splitting them out drops main()'s cyclomatic
 * complexity from 139 toward the 30 gate.
 *
 * Convention: each handler either returns normally (caller should `return`
 * from main) or calls process.exit() directly. None of them throw.
 */

import { AuditLogger } from '../audit';
import { ReplayProvider, loadSessionForReplay, compareOutputs } from '../replay';
import { VaultManager } from '../vault';
import { Daemon } from '../daemon';
import { Agent } from '../agent';
import { resolveConfig, createProvider } from './config';
import { truncate } from './render';

type ParsedArgs = Record<string, string | boolean>;

// Local color helper — matches cli.ts pattern. Self-contained so this
// module has no dependency back into cli.ts.
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

/**
 * `codebot vault list|status|set|delete|rm` subcommand.
 *
 * Reads process.argv directly (sub = argv[3]) so it short-circuits before
 * the agent / banner / network. Real CLI for credential management — the
 * gap that previously left users with no honest way to write secrets to
 * ~/.codebot/vault.json.
 *
 * Returns true if argv[2] === 'vault' (handled, caller should return).
 * Returns false otherwise (caller should continue normal flow).
 *
 * Calls process.exit on error paths.
 */
export function handleVaultSubcommand(): boolean {
  if (process.argv[2] !== 'vault') return false;

  const sub = process.argv[3];
  const vault = new VaultManager();

  if (sub === 'list') {
    const names = vault.list();
    if (names.length === 0) {
      console.log('vault: empty');
    } else {
      console.log(`vault: ${names.length} credential(s)`);
      for (const n of names) console.log(`  - ${n}`);
    }
    return true;
  }

  if (sub === 'status') {
    const s = vault.status();
    console.log(`vault path:      ${s.vaultPath}`);
    console.log(`vault exists:    ${s.vaultExists}`);
    console.log(`key source:      ${s.keySource}`);
    console.log(`credential count: ${s.credentialCount}`);
    return true;
  }

  if (sub === 'delete' || sub === 'rm') {
    const name = process.argv[4];
    if (!name) { console.error('Usage: codebot vault delete <name>'); process.exit(1); }
    const ok = vault.delete(name);
    console.log(ok ? `deleted: ${name}` : `not found: ${name}`);
    return true;
  }

  if (sub === 'set') {
    // Usage: codebot vault set <name> KEY=VALUE
    // Stores the VALUE as the credential string. Connector code reads
    // it via registry.getCredential(name) which returns cred.value
    // directly — single-string contract verified at registry.ts:56.
    const name = process.argv[4];
    const kv = process.argv[5];
    if (!name || !kv || !kv.includes('=')) {
      console.error('Usage: codebot vault set <name> KEY=VALUE');
      console.error('Example: codebot vault set github GITHUB_TOKEN=ghp_xxxxx');
      process.exit(1);
    }
    const eq = kv.indexOf('=');
    const value = kv.slice(eq + 1);
    if (!value) { console.error('Empty value rejected.'); process.exit(1); }
    vault.set(name, {
      type: 'oauth_token',
      value,
      metadata: { provider: name, created: new Date().toISOString() },
    });
    console.log(`stored: ${name} (${value.length} chars, value not echoed)`);
    return true;
  }

  console.error('Usage:');
  console.error('  codebot vault list');
  console.error('  codebot vault status');
  console.error('  codebot vault set <name> KEY=VALUE');
  console.error('  codebot vault delete <name>');
  process.exit(1);
}

/**
 * `--verify-audit [sessionId]` — walks the hash-chain for one or all sessions.
 * Single-session mode runs verify on entries for the given id; full mode
 * groups all entries by sessionId, runs per-session verify, prints a summary
 * with legacy/crashed counts.
 */
export function handleVerifyAudit(args: ParsedArgs): void {
  const logger = new AuditLogger();
  const sessionId = typeof args['verify-audit'] === 'string' ? (args['verify-audit'] as string) : undefined;

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
    return;
  }

  const entries = logger.query();
  if (entries.length === 0) {
    console.log(c('No audit entries found.', 'yellow'));
    return;
  }
  const sessions = new Map<string, typeof entries>();
  for (const e of entries) {
    if (!sessions.has(e.sessionId)) sessions.set(e.sessionId, []);
    sessions.get(e.sessionId)!.push(e);
  }
  let allValid = true;
  let legacySessions = 0;
  let legacyEntries = 0;
  let crashed = 0;
  for (const [sid, sessionEntries] of sessions) {
    const shortId = sid.substring(0, 12);
    let result;
    try {
      result = AuditLogger.verify(sessionEntries);
    } catch (err) {
      crashed++;
      allValid = false;
      const msg = err instanceof Error ? err.message : String(err);
      console.log(c(`  ${shortId}  ERROR: verifier threw: ${msg}`, 'red'));
      continue;
    }
    if (result.valid) {
      console.log(c(`  ${shortId}  ${result.entriesChecked} entries  valid`, 'green'));
    } else if (result.legacy) {
      legacySessions++;
      legacyEntries += sessionEntries.length;
      console.log(c(`  ${shortId}  ${sessionEntries.length} entries  skipped (legacy unhashed)`, 'yellow'));
    } else {
      console.log(c(`  ${shortId}  INVALID at seq ${result.firstInvalidAt}: ${result.reason}`, 'red'));
      allValid = false;
    }
  }
  const verifiable = sessions.size - legacySessions;
  const lines: string[] = [];
  if (legacySessions > 0) {
    lines.push(c(`Skipped ${legacySessions} legacy sessions (${legacyEntries} entries) predating v1.7.0 hash chain.`, 'yellow'));
  }
  if (crashed > 0) {
    lines.push(c(`${crashed} sessions failed to verify due to verifier errors.`, 'red'));
  }
  lines.push(
    allValid
      ? c(`All ${verifiable} hashed session chains verified.`, 'green')
      : c(`Some chains are invalid — possible tampering detected.`, 'red'),
  );
  console.log('\n' + lines.join('\n'));
}

/**
 * `--replay [sessionId]` — re-run a recorded session against a ReplayProvider
 * and report tool-output divergences vs. the original recording.
 */
export async function handleReplay(args: ParsedArgs): Promise<void> {
  // Lazy import to avoid pulling SessionManager into modules that don't need it.
  const { SessionManager } = await import('../history');
  const replayId = typeof args.replay === 'string' ? (args.replay as string) : SessionManager.latest();
  if (!replayId) {
    console.log(c('No session to replay.', 'yellow'));
    return;
  }
  const data = loadSessionForReplay(replayId);
  if (!data) {
    console.log(c(`Session ${replayId} not found.`, 'red'));
    return;
  }
  console.log(c(`\nReplaying session ${replayId.substring(0, 12)}...`, 'cyan'));
  console.log(c(`  ${data.messages.length} messages`, 'dim'));
  const replayProvider = new ReplayProvider(data.assistantMessages);
  const config = await resolveConfig(args);
  const agent = new Agent({
    provider: replayProvider,
    model: config.model,
    providerName: 'replay',
    autoApprove: true,
  });
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
          } else {
            console.log(c(`  ✓ ${event.toolResult.name || 'tool'} — output matches`, 'green'));
          }
        }
      }
    }
  }
  console.log(c(`\n\nReplay complete. ${divergences} divergence(s).`, 'bold'));
}

/**
 * `--heartbeat <on|off|status>` — toggles the anonymous opt-in install ping.
 * Returns true if the flag was present (caller returns).
 */
export function handleHeartbeat(args: ParsedArgs): boolean {
  if (args.heartbeat === undefined) return false;
  // Lazy require to avoid pulling heartbeat into modules that don't need it.
  const { setHeartbeatEnabled, heartbeatStatus } = require('../heartbeat');
  const v = String(args.heartbeat).toLowerCase();
  if (v === 'on' || v === 'enable' || v === 'true') {
    const cfg = setHeartbeatEnabled(true);
    console.log(`heartbeat: enabled  (install age: ${cfg.firstSeenDate || 'just now'})`);
    return true;
  }
  if (v === 'off' || v === 'disable' || v === 'false') {
    setHeartbeatEnabled(false);
    console.log('heartbeat: disabled');
    return true;
  }
  if (v === 'status' || v === 'true') {
    console.log(heartbeatStatus());
    return true;
  }
  console.log(`heartbeat: unknown value "${args.heartbeat}". Use on / off / status.`);
  return true;
}

/**
 * `--init-policy` — write a default `.codebot/policy.json` in the cwd if missing.
 */
export function handleInitPolicy(): void {
  const path = require('path');
  const fs = require('fs');
  const { generateDefaultPolicyFile } = require('../policy');
  const policyPath = path.join(process.cwd(), '.codebot', 'policy.json');
  const policyDir = path.dirname(policyPath);
  if (!fs.existsSync(policyDir)) fs.mkdirSync(policyDir, { recursive: true });
  if (fs.existsSync(policyPath)) {
    console.log(c(`Policy file already exists at ${policyPath}`, 'yellow'));
  } else {
    fs.writeFileSync(policyPath, generateDefaultPolicyFile(), 'utf-8');
    console.log(c(`Created default policy at ${policyPath}`, 'green'));
  }
}

/** `--sandbox-info` — print Docker sandbox availability + defaults. */
export function handleSandboxInfo(): void {
  const { getSandboxInfo } = require('../sandbox');
  const info = getSandboxInfo();
  console.log(c('Sandbox Status:', 'bold'));
  console.log(`  Docker: ${info.available ? c('available', 'green') : c('not available', 'yellow')}`);
  console.log(`  Image:  ${info.image}`);
  console.log(`  CPU:    ${info.defaults.cpus} cores max`);
  console.log(`  Memory: ${info.defaults.memoryMb}MB max`);
  console.log(`  Network: ${info.defaults.network ? 'enabled' : 'disabled'} by default`);
}

/** `--export-audit sarif [--session id]` — emit SARIF 2.1.0 to stdout. */
export function handleExportAudit(args: ParsedArgs, version: string): void {
  const logger = new AuditLogger();
  const sessionId = typeof args['session'] === 'string' ? (args['session'] as string) : undefined;
  const entries = sessionId ? logger.query({ sessionId }) : logger.query();
  if (entries.length === 0) {
    console.error(c('No audit entries found.', 'yellow'));
    process.exit(1);
  }
  const { exportSarif, sarifToString } = require('../sarif');
  const sarif = exportSarif(entries, { version, sessionId });
  process.stdout.write(sarifToString(sarif) + '\n');
}

/** `--doctor` — run the diagnostics suite. Calls process.exit. */
export async function handleDoctor(): Promise<never> {
  const { runDoctor, formatDoctorReport } = require('../doctor');
  const report = await runDoctor();
  console.log(formatDoctorReport(report));
  process.exit(report.failed > 0 ? 1 : 0);
}

/** `--solve <issue-url>` — autonomous issue→PR pipeline. */
export async function handleSolve(args: ParsedArgs): Promise<void> {
  const solveUrl = typeof args.solve === 'string' ? (args.solve as string) : (args.message as string);
  if (!solveUrl) {
    console.error(c('Error: provide a GitHub issue URL.', 'red'));
    process.exit(1);
  }
  const config = await resolveConfig(args);
  const provider = createProvider(config);
  const { SolveCommand } = await import('../solve');
  const { renderSolveEvent } = await import('./render');
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
    workspace: typeof args.workspace === 'string' ? (args.workspace as string) : undefined,
    json: !!args.json,
    verbose: !!args.verbose,
  });
  console.log(c('\n  CodeBot AI — Issue Solver\n', 'bold'));
  for await (const event of solver.run(solveUrl)) {
    renderSolveEvent(event, !!args.json);
  }
}

/** `--task <description>` — headless single-task mode. Calls process.exit. */
export async function handleTask(args: ParsedArgs): Promise<never> {
  const taskDesc = typeof args.task === 'string' ? (args.task as string) : (args.message as string);
  if (!taskDesc) {
    console.error(c('Error: provide a task description.', 'red'));
    process.exit(1);
  }
  const config = await resolveConfig(args);
  const provider = createProvider(config);
  const { runTask } = await import('../task-runner');
  const result = await runTask({
    task: taskDesc,
    provider,
    model: config.model,
    providerName: config.provider,
    projectRoot: process.cwd(),
    auditLogPath: typeof args['audit-log'] === 'string' ? (args['audit-log'] as string) : undefined,
    outputFormat: (typeof args.output === 'string' ? args.output : 'text') as 'json' | 'text' | 'sarif',
    maxCost: args['max-cost'] ? parseFloat(args['max-cost'] as string) : undefined,
    preset: typeof args.preset === 'string' ? (args.preset as string) : undefined,
  });
  process.exit(result.status === 'completed' ? 0 : 1);
}

/**
 * `--listen` — start the event-driven webhook receiver.
 *
 *   codebot --listen [--port 8442] [--secret <key>] [--host 0.0.0.0]
 *
 * Required: --secret (>= 16 chars) OR CODEBOT_LISTEN_SECRET env var.
 * Default port: 8442. Default host: 127.0.0.1.
 *
 * Every signed POST to /event is HMAC-verified, hash-chained into the
 * audit log via existing AuditLogger, and acknowledged with the audit
 * entry hash so the caller can later verify the chain.
 *
 * For v0, no dispatch — just receive + audit. Buyers / users who want
 * to trigger CodeBot tasks from inbound events can add the dispatch
 * hook in a later iteration; the contract is in src/event-listener.ts.
 */
export async function handleListen(args: ParsedArgs): Promise<void> {
  const { EventListener } = await import('../event-listener');
  const { AuditLogger } = await import('../audit');
  const port = typeof args.port === 'string' ? parseInt(args.port, 10) : 8442;
  const host = typeof args.host === 'string' ? args.host : '127.0.0.1';
  const secret = typeof args.secret === 'string'
    ? args.secret
    : process.env.CODEBOT_LISTEN_SECRET || '';
  if (!secret) {
    console.error(c('error: --secret <key> or CODEBOT_LISTEN_SECRET env var required (>= 16 chars)', 'red'));
    process.exit(2);
  }
  if (secret.length < 16) {
    console.error(c('error: --secret must be at least 16 characters', 'red'));
    process.exit(2);
  }
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    console.error(c(`error: invalid --port ${port}`, 'red'));
    process.exit(2);
  }

  const audit = new AuditLogger();
  const listener = new EventListener({ port, host, secret, audit });
  const { port: actualPort } = await listener.start();
  console.log(c(`event listener: ${host}:${actualPort}/event`, 'cyan'));
  console.log(c(`audit session:  ${audit.getSessionId()}`, 'dim'));
  console.log(c(`signing scheme: HMAC-SHA256 over (timestamp + body)`, 'dim'));
  console.log(c(`headers:        x-codebot-signature, x-codebot-timestamp, x-codebot-event`, 'dim'));
  console.log(c(`replay window:  300s`, 'dim'));
  console.log(c(`Ctrl+C to stop.`, 'dim'));

  await new Promise<void>((resolve) => {
    const shutdown = async () => {
      console.log(c('\nshutting down...', 'yellow'));
      await listener.stop();
      resolve();
    };
    process.once('SIGINT', shutdown);
    process.once('SIGTERM', shutdown);
  });
}

/**
 * `--daemon` — start the long-running daemon worker. Constructs an Agent
 * from resolved config and a Daemon, wires the execute-job handler,
 * blocks on daemon.start().
 */
export async function handleDaemon(args: ParsedArgs): Promise<void> {
  const config = await resolveConfig(args);
  const provider = createProvider(config);
  const agent = new Agent({
    provider,
    model: config.model,
    providerName: config.provider,
    maxIterations: config.maxIterations,
    autoApprove: true,
    routerConfig: config.router,
    budgetConfig: config.budget,
    allowedCapabilities: config.allowedCapabilities,
    constitutional: { enabled: !config.disableConstitutional },
  });
  const daemon = new Daemon();
  daemon.onExecuteJob = async (job) => {
    let output = '';
    for await (const event of agent.run(job.description)) {
      if (event.type === 'text' && event.text) output += event.text;
    }
    return output || `Completed: ${job.description}`;
  };
  console.log(c('  CodeBot Daemon starting...', 'cyan'));
  console.log(c('  Press Ctrl+C to stop.', 'dim'));
  await daemon.start();
}

