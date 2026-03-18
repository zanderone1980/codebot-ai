import { execSync } from 'child_process';
import { Tool } from '../types';
import { isCwdSafe } from '../security';
import { sandboxExec, isDockerAvailable } from '../sandbox';
import { PolicyEnforcer } from '../policy';

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
  description = 'Execute a shell command. Returns stdout and stderr. Use for running tests, builds, git commands, etc.';
  permission: Tool['permission'] = 'prompt';
  parameters = {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      cwd: { type: 'string', description: 'Working directory (defaults to current)' },
      timeout: { type: 'number', description: 'Timeout in ms (default: 30000)' },
    },
    required: ['command'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    if (!args.command || typeof args.command !== 'string') {
      return 'Error: command is required';
    }
    const cmd = args.command;

    for (const pattern of BLOCKED_PATTERNS) {
      if (pattern.test(cmd)) {
        throw new Error(`Blocked: "${cmd}" matches a dangerous command pattern.`);
      }
    }

    // Security: validate CWD
    const cwd = (args.cwd as string) || process.cwd();
    const projectRoot = process.cwd();
    const cwdSafety = isCwdSafe(cwd, projectRoot);
    if (!cwdSafety.safe) {
      return `Error: ${cwdSafety.reason}`;
    }

    const timeout = (args.timeout as number) || 180000;

    // ── v1.7.0: Sandbox routing (v2.1.5: uses PolicyEnforcer for RBAC) ──
    const enforcer = new PolicyEnforcer(undefined, projectRoot);
    const sandboxMode = enforcer.getSandboxMode();
    const useSandbox =
      sandboxMode === 'docker' ||
      (sandboxMode === 'auto' && isDockerAvailable());

    if (useSandbox) {
      const result = sandboxExec(cmd, projectRoot, {
        network: enforcer.isNetworkAllowed(),
        memoryMb: enforcer.getMaxMemoryMb(),
        timeoutMs: timeout,
      });

      if (result.sandboxed) {
        const output = result.stdout || result.stderr || '(no output)';
        const tag = '[sandboxed]';
        if (result.exitCode !== 0) {
          return `${tag} Exit code ${result.exitCode}\nSTDOUT:\n${result.stdout}\nSTDERR:\n${result.stderr}`;
        }
        return `${tag} ${output}`;
      }
      // Fallthrough: sandboxExec returned sandboxed=false (Docker wasn't available after all)
    }

    // ── Host execution (existing path) ──
    const safeEnv = { ...process.env };
    for (const key of FILTERED_ENV_VARS) {
      delete safeEnv[key];
    }

    const tag = useSandbox ? '[host-fallback]' : '[host]';

    try {
      const output = execSync(cmd, {
        cwd,
        timeout,
        maxBuffer: 1024 * 1024,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
        env: safeEnv,
      });
      return `${tag} ${output || '(no output)'}`;
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return `${tag} Exit code ${e.status || 1}\nSTDOUT:\n${e.stdout || ''}\nSTDERR:\n${e.stderr || ''}`;
    }
  }
}
