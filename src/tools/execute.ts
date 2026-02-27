import { execSync } from 'child_process';
import { Tool } from '../types';

const BLOCKED_PATTERNS = [
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
];

export class ExecuteTool implements Tool {
  name = 'execute';
  description = 'Execute a shell command. Returns stdout and stderr. Use for running tests, builds, git commands, etc.';
  permission: Tool['permission'] = 'always-ask';
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

    try {
      const output = execSync(cmd, {
        cwd: (args.cwd as string) || process.cwd(),
        timeout: (args.timeout as number) || 30000,
        maxBuffer: 1024 * 1024,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return output || '(no output)';
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      return `Exit code ${e.status || 1}\nSTDOUT:\n${e.stdout || ''}\nSTDERR:\n${e.stderr || ''}`;
    }
  }
}
