import { execSync, spawn } from 'child_process';
import { Tool, CapabilityLabel } from '../types';
import { isCwdSafe } from '../security';
import { sandboxExec, isDockerAvailable } from '../sandbox';
import { PolicyEnforcer } from '../policy';

/**
 * Stream events emitted by {@link ExecuteTool.stream}. Transport-agnostic —
 * the HTTP/SSE bridge lives in the dashboard layer, not here.
 */
export interface ExecStreamEvents {
  onStdout?: (text: string) => void;
  onStderr?: (text: string) => void;
}

/**
 * Machine-readable failure codes for streaming exec. The dashboard maps
 * `sandbox_required` → HTTP 501 ("transport cannot satisfy policy"), and
 * the other codes → 403 (the gate itself refused the command).
 */
export type ExecStreamErrorCode =
  | 'bad_args'
  | 'blocked_pattern'
  | 'unsafe_cwd'
  | 'sandbox_required'
  | 'spawn_error';

export class ExecStreamError extends Error {
  readonly code: ExecStreamErrorCode;
  constructor(message: string, code: ExecStreamErrorCode) {
    super(message);
    this.name = 'ExecStreamError';
    this.code = code;
  }
}

/** Result of a successful streaming exec. Tails capped at 512 bytes each. */
export interface ExecStreamResult {
  exitCode: number;
  stdoutTail: string;
  stderrTail: string;
  timedOut: boolean;
}

/** Validated execution plan produced by {@link ExecuteTool.preflight}. */
interface ExecPlan {
  cmd: string;
  cwd: string;
  timeoutMs: number;
  useSandbox: boolean;
  sandboxMode: 'auto' | 'docker' | 'host';
  sandboxNetwork: boolean;
  sandboxMemoryMb: number;
  safeEnv: NodeJS.ProcessEnv;
}

/** Outcome of {@link ExecuteTool.preflight} — plan on success, structured reason on failure. */
export type PreflightResult =
  | { ok: true; plan: ExecPlan }
  | { ok: false; reason: string; code: 'bad_args' | 'blocked_pattern' | 'unsafe_cwd' };

const STREAM_TAIL_MAX = 512;

function clampTail(chunks: string[]): string {
  if (chunks.length === 0) return '';
  const joined = chunks.join('');
  if (joined.length <= STREAM_TAIL_MAX) return joined;
  return joined.slice(joined.length - STREAM_TAIL_MAX);
}

export const BLOCKED_PATTERNS = [
  // Destructive filesystem operations
  /rm\s+-rf\s+\//,
  /rm\s+-rf\s+~/,
  /rm\s+-rf\s+\*/,
  /rm\s+-rf\s+\.\s/,
  /rm\s+(-[a-z]*f[a-z]*\s+)?--no-preserve-root/,
  // Disk/partition destruction
  /mkfs\./,
  /dd\s+if=.*of=\/dev\//,
  /wipefs/,
  /fdisk\s+\/dev\//,
  /parted\s+\/dev\//,
  // Fork bomb
  /:\(\)\s*\{[^}]*:\|:.*\}/,
  // Permission escalation
  /chmod\s+-R\s+777\s+\//,
  /chmod\s+777\s+\//,
  /chown\s+-R\s+.*\s+\//,
  // Windows destructive
  /format\s+c:/i,
  /del\s+\/[sfq]\s+c:\\/i,
  /rd\s+\/s\s+\/q\s+c:\\/i,
  // Curl to shell pipes (common attack vector)
  /curl\s+.*\|\s*(ba)?sh/,
  /wget\s+.*\|\s*(ba)?sh/,
  // History/log destruction
  />\s*\/dev\/sda/,
  /history\s+-c.*&&.*rm/,
  // Shutdown/reboot
  /shutdown\s+(-h\s+)?now/,
  /reboot\b/,
  /init\s+[06]/,
  // Kernel module manipulation
  /insmod\b/,
  /rmmod\b/,
  /modprobe\s+-r/,

  // ── v1.6.0 security hardening: evasion-resistant patterns ──

  // Base64 decode pipes (obfuscated command execution)
  /base64\s+(-d|--decode)\s*\|/,
  // Hex escape sequences (obfuscation)
  /\\x[0-9a-fA-F]{2}.*\\x[0-9a-fA-F]{2}/,
  // Variable-based obfuscation
  /\$\{[^}]*rm\s/,
  /eval\s+.*\$/,
  // Backtick-based command injection
  /`[^`]*rm\s+-rf/,
  // Process substitution with dangerous commands
  /<\(.*curl/,
  /<\(.*wget/,
  // Python/perl inline execution of destructive commands
  /python[23]?\s+-c\s+.*import\s+os.*remove/,
  /perl\s+-e\s+.*unlink/,
  // Encoded shell commands
  /echo\s+.*\|\s*base64\s+(-d|--decode)\s*\|\s*(ba)?sh/,
  // Crontab manipulation
  /crontab\s+-r/,
  // Systemctl destructive operations
  /systemctl\s+(disable|mask|stop)\s+(sshd|firewalld|iptables)/,
];

/** Sensitive environment variables to strip before passing to child process */
export const FILTERED_ENV_VARS = [
  'AWS_SECRET_ACCESS_KEY',
  'AWS_SESSION_TOKEN',
  'GITHUB_TOKEN',
  'GH_TOKEN',
  'NPM_TOKEN',
  'DATABASE_URL',
  'OPENAI_API_KEY',
  'ANTHROPIC_API_KEY',
  'GOOGLE_API_KEY',
  'STRIPE_SECRET_KEY',
  'SENDGRID_API_KEY',
  'SLACK_TOKEN',
  'SLACK_BOT_TOKEN',
];

export class ExecuteTool implements Tool {
  name = 'execute';
  private projectRoot: string;
  constructor(projectRoot?: string) { this.projectRoot = projectRoot || process.cwd(); }
  description = 'Execute a shell command. Returns stdout and stderr. Use for running tests, builds, git commands, etc.';
  permission: Tool['permission'] = 'prompt';
  capabilities: CapabilityLabel[] = ['read-only', 'write-fs', 'run-cmd'];
  parameters = {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      cwd: { type: 'string', description: 'Working directory (defaults to current)' },
      timeout: { type: 'number', description: 'Timeout in ms (default: 30000)' },
    },
    required: ['command'],
  };

  /**
   * Shared preflight — validates args, checks patterns, verifies cwd
   * containment, and resolves the sandbox plan. Pure: no side effects,
   * no spawn. Both {@link execute} (buffered) and {@link stream} (SSE)
   * call this first so there is a single source of truth for what a
   * given `args` payload means. If you add a rule, add it here.
   *
   * Does NOT throw for blocked patterns — returns a structured
   * `{ ok: false, code: 'blocked_pattern' }`. The {@link execute}
   * wrapper preserves the historical throwing behavior for its
   * callers; new callers should handle the result directly.
   */
  preflight(args: Record<string, unknown>): PreflightResult {
    if (!args.command || typeof args.command !== 'string') {
      return { ok: false, reason: 'command is required', code: 'bad_args' };
    }
    const cmd = args.command;

    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(cmd)) {
        return {
          ok: false,
          reason: `Blocked: "${cmd}" matches a dangerous command pattern.`,
          code: 'blocked_pattern',
        };
      }
    }

    const cwd = (args.cwd as string) || this.projectRoot;
    const cwdSafety = isCwdSafe(cwd, this.projectRoot);
    if (!cwdSafety.safe) {
      return { ok: false, reason: cwdSafety.reason || 'CWD outside project root', code: 'unsafe_cwd' };
    }

    const timeoutMs = (args.timeout as number) || 180000;

    const enforcer = new PolicyEnforcer(undefined, this.projectRoot);
    const sandboxMode = enforcer.getSandboxMode();
    const useSandbox =
      sandboxMode === 'docker' ||
      (sandboxMode === 'auto' && isDockerAvailable());

    const safeEnv = { ...process.env };
    for (const key of FILTERED_ENV_VARS) {
      delete safeEnv[key];
    }

    return {
      ok: true,
      plan: {
        cmd,
        cwd,
        timeoutMs,
        useSandbox,
        sandboxMode,
        sandboxNetwork: enforcer.isNetworkAllowed(),
        sandboxMemoryMb: enforcer.getMaxMemoryMb(),
        safeEnv,
      },
    };
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const pre = this.preflight(args);
    if (!pre.ok) {
      // Preserve historical behavior of the buffered path: blocked
      // patterns throw (callers catch and surface); arg/cwd errors
      // return as `Error: ...` strings.
      if (pre.code === 'blocked_pattern') {
        throw new Error(pre.reason);
      }
      return `Error: ${pre.reason}`;
    }
    return this.runBuffered(pre.plan);
  }

  /**
   * Streaming exec. Same {@link preflight} as {@link execute} plus one
   * fail-closed rule: if policy requires sandbox, we do NOT host-fallback
   * and we do NOT audit-and-proceed — we throw `sandbox_required`. The
   * SSE transport cannot satisfy Docker-sandbox semantics, so we refuse
   * the transport and tell the caller to use the non-streaming runner.
   *
   * Caller owns audit: Agent.runStreamingTool writes exec_start before
   * this returns a stream, and exec_complete after the returned promise
   * resolves (or exec_error if we throw). Tails are capped at 512 bytes
   * each and returned in the resolved value.
   */
  async stream(
    args: Record<string, unknown>,
    events: ExecStreamEvents,
    opts: { timeoutMs?: number } = {},
  ): Promise<ExecStreamResult> {
    const pre = this.preflight(args);
    if (!pre.ok) {
      throw new ExecStreamError(pre.reason, pre.code);
    }
    // Fail closed only when policy EXPLICITLY requires sandbox
    // (`sandbox: 'docker'`). Under `auto` the buffered path may sandbox
    // when Docker is available, but the intent is "prefer sandbox, OK
    // to host-fallback" — not a hard requirement. Host-streaming under
    // auto is the same UX as the pre-2026-04-24 behavior and we do NOT
    // silently downgrade from a hard `docker` requirement.
    if (pre.plan.sandboxMode === 'docker') {
      throw new ExecStreamError(
        'Streaming exec is not supported when policy requires sandbox. Use the non-streaming tool runner.',
        'sandbox_required',
      );
    }
    return this.runStreaming(pre.plan, events, opts.timeoutMs ?? pre.plan.timeoutMs);
  }

  /** Buffered runner — used by {@link execute}. Sandbox-aware. */
  private runBuffered(plan: ExecPlan): string {
    if (plan.useSandbox) {
      const result = sandboxExec(plan.cmd, this.projectRoot, {
        network: plan.sandboxNetwork,
        memoryMb: plan.sandboxMemoryMb,
        timeoutMs: plan.timeoutMs,
      });

      if (result.sandboxed) {
        const output = result.stdout || result.stderr || '(no output)';
        const tag = '[sandboxed]';
        if (result.exitCode !== 0) {
          return `${tag} Exit code ${result.exitCode}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`;
        }
        return `${tag} ${output}`;
      }
      // Sandbox declined at runtime — fall through to host.
    }

    const tag = plan.useSandbox ? '[host-fallback]' : '[host]';

    try {
      const output = execSync(plan.cmd, {
        cwd: plan.cwd,
        timeout: plan.timeoutMs,
        maxBuffer: 1024 * 1024,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: plan.safeEnv,
      });
      return `${tag} ${output || '(no output)'}`;
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return `${tag} Exit code ${e.status || 1}\nSTDOUT:\n${e.stdout || ''}\nSTDERR:\n${e.stderr || ''}`;
    }
  }

  /**
   * Streaming runner — spawns via sh, pipes stdout/stderr through
   * callbacks, enforces the timeout, captures 512-byte rolling tails
   * for audit forensics.
   */
  private runStreaming(
    plan: ExecPlan,
    events: ExecStreamEvents,
    timeoutMs: number,
  ): Promise<ExecStreamResult> {
    return new Promise<ExecStreamResult>((resolve, reject) => {
      let settled = false;
      const stdoutChunks: string[] = [];
      const stderrChunks: string[] = [];
      let stdoutLen = 0;
      let stderrLen = 0;

      // Rolling tail — keep only the final STREAM_TAIL_MAX bytes of each stream.
      const pushBounded = (buf: string[], incoming: string, currentLen: number): number => {
        buf.push(incoming);
        let total = currentLen + incoming.length;
        while (total > STREAM_TAIL_MAX * 2 && buf.length > 1) {
          total -= buf.shift()!.length;
        }
        return total;
      };

      let child;
      try {
        child = spawn('sh', ['-c', plan.cmd], { cwd: plan.cwd, env: plan.safeEnv });
      } catch (err) {
        reject(new ExecStreamError((err as Error).message || 'spawn failed', 'spawn_error'));
        return;
      }

      const timer = setTimeout(() => {
        if (!child.killed) child.kill('SIGTERM');
      }, timeoutMs);
      let timedOut = false;
      timer.unref?.();
      const armTimeoutFlag = setTimeout(() => { timedOut = true; }, timeoutMs);
      armTimeoutFlag.unref?.();

      child.stdout.on('data', (d: Buffer) => {
        const text = d.toString('utf-8');
        stdoutLen = pushBounded(stdoutChunks, text, stdoutLen);
        try { events.onStdout?.(text); } catch { /* consumer errors must not kill the stream */ }
      });

      child.stderr.on('data', (d: Buffer) => {
        const text = d.toString('utf-8');
        stderrLen = pushBounded(stderrChunks, text, stderrLen);
        try { events.onStderr?.(text); } catch { /* ditto */ }
      });

      child.on('error', (err: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(armTimeoutFlag);
        reject(new ExecStreamError(err.message || 'spawn failed', 'spawn_error'));
      });

      child.on('close', (code: number | null) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        clearTimeout(armTimeoutFlag);
        resolve({
          exitCode: code ?? (timedOut ? 124 : 0),
          stdoutTail: clampTail(stdoutChunks),
          stderrTail: clampTail(stderrChunks),
          timedOut,
        });
      });
    });
  }
}
