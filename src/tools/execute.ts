import { execSync } from 'child_process';
import { Tool } from '../types';

const BLOCKED_PATTERNS = [
  /rm\s+-rf\s+\//,
  /rm\s+-rf\s+~/,
  /rm\s+-rf\s+\*/,
  /mkfs\./,
  /dd\s+if=.*of=\/dev\//,
  /:\(\)\s*\{[^}]*:\|:.*\}/,
  /chmod\s+-R\s+777\s+\//,
  /format\s+c:/i,
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
    const cmd = args.command as string;

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
