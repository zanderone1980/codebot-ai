import { execFileSync } from 'child_process';
import { Tool, CapabilityLabel } from '../types';
import { PolicyEnforcer } from '../policy';

const ALLOWED_ACTIONS = [
  'status', 'diff', 'log', 'commit', 'branch', 'checkout',
  'stash', 'push', 'pull', 'merge', 'blame', 'tag', 'add', 'reset', 'clone',
];

/** Check for shell injection characters in arguments */
function containsInjection(str: string): boolean {
  return /[;&|`$(){}]/.test(str) || /\beval\b|\bexec\b/.test(str);
}

/** Safely split an argument string into an array (respects quoted strings) */
function splitArgs(argsStr: string): string[] {
  const result: string[] = [];
  let current = '';
  let inQuote = '';
  for (const ch of argsStr) {
    if (inQuote) {
      if (ch === inQuote) { inQuote = ''; } else { current += ch; }
    } else if (ch === '"' || ch === "'") {
      inQuote = ch;
    } else if (ch === ' ' || ch === '\t') {
      if (current) { result.push(current); current = ''; }
    } else {
      current += ch;
    }
  }
  if (current) result.push(current);
  return result;
}

export class GitTool implements Tool {
  name = 'git';
  description = 'Run git operations. Actions: status, diff, log, commit, branch, checkout, stash, push, pull, merge, blame, tag, add, reset, clone.';
  permission: Tool['permission'] = 'prompt';
  capabilities: CapabilityLabel[] = ['write-fs', 'run-cmd', 'net-fetch'];
  private policyEnforcer?: PolicyEnforcer;
  parameters = {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Git action (status, diff, log, commit, branch, checkout, stash, push, pull, merge, blame, tag, add, reset, clone)' },
      args: { type: 'string', description: 'Additional arguments (e.g., file path, branch name, commit message)' },
      cwd: { type: 'string', description: 'Working directory (defaults to current)' },
    },
    required: ['action'],
  };

  constructor(policyEnforcer?: PolicyEnforcer) {
    this.policyEnforcer = policyEnforcer;
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = args.action as string;
    if (!action) return 'Error: action is required';

    if (!ALLOWED_ACTIONS.includes(action)) {
      return `Error: unknown action "${action}". Allowed: ${ALLOWED_ACTIONS.join(', ')}`;
    }

    const extra = (args.args as string) || '';
    const cwd = (args.cwd as string) || process.cwd();

    // Injection detection — block shell metacharacters
    if (extra && containsInjection(extra)) {
      return 'Error: arguments contain disallowed characters (possible injection attempt).';
    }

    // Restrict clone to well-known hosts only
    if (action === 'clone') {
      const cloneArgs = splitArgs(extra);
      const url = cloneArgs[0] || '';
      if (!url.startsWith('https://github.com/') && !url.startsWith('git@github.com:') && !url.startsWith('https://gitlab.com/')) {
        return 'Error: clone is restricted to github.com and gitlab.com URLs for safety.';
      }
    }

    // Build argument array (no shell interpolation)
    const gitArgs = [action, ...splitArgs(extra)];
    const fullCmd = gitArgs.join(' ');

    // Block destructive force operations
    if (/--force\s+.*(main|master)/i.test(fullCmd) || (/--force/.test(fullCmd) && /(main|master)/.test(fullCmd))) {
      return 'Error: force push to main/master is blocked for safety.';
    }
    if (/clean\s+-[a-z]*f/i.test(fullCmd)) {
      return 'Error: git clean -f is blocked for safety.';
    }
    // Block reset --hard (destructive)
    if (action === 'reset' && extra.includes('--hard')) {
      return 'Error: git reset --hard is blocked for safety.';
    }
    // Block destructive bare `git stash` (push form) — silently sweeps working tree.
    // See incident: src/tools/git.test.ts running `tool.execute({action:'stash'})`
    // accumulated 257 stashes of unrelated WIP because the test cwd was the repo itself.
    if (action === 'stash') {
      const stashArgs = splitArgs(extra);
      const sub = stashArgs[0] || '';
      const safeSubs = ['list', 'show', 'apply', 'pop', 'drop', 'branch'];
      if (!sub || sub === 'push' || sub === 'save') {
        return 'Error: bare `git stash` (push/save form) is blocked for safety — it silently captures the working tree. Use `git stash list/show/apply/pop/drop` instead.';
      }
      if (!safeSubs.includes(sub)) {
        return `Error: git stash subcommand "${sub}" is not allowed. Use list/show/apply/pop/drop/branch.`;
      }
    }

    // Policy: block push to main/master when never_push_main=true
    if (action === 'push' && this.policyEnforcer?.isMainPushBlocked()) {
      const currentBranch = this.getCurrentBranch(cwd);
      if (currentBranch === 'main' || currentBranch === 'master') {
        return 'Error: Pushing to main/master is blocked by policy (git.never_push_main=true). Create a feature branch first.';
      }
    }

    // Policy: block commit on main/master when always_branch=true
    if (action === 'commit' && this.policyEnforcer?.shouldAlwaysBranch()) {
      const currentBranch = this.getCurrentBranch(cwd);
      if (currentBranch === 'main' || currentBranch === 'master') {
        return 'Error: Committing to main/master is blocked by policy (git.always_branch=true). Create a feature branch first.';
      }
    }

    try {
      // Use execFileSync (array-based) — bypasses shell, prevents injection
      const output = execFileSync('git', gitArgs, {
        cwd,
        timeout: 30_000,
        maxBuffer: 1024 * 1024,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return output.trim() || '(no output)';
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      const stderr = (e.stderr || '').trim();
      const stdout = (e.stdout || '').trim();
      return `Exit ${e.status || 1}${stdout ? `\n${stdout}` : ''}${stderr ? `\nError: ${stderr}` : ''}`;
    }
  }

  /** Get current git branch name. */
  private getCurrentBranch(cwd: string): string {
    try {
      return execFileSync('git', ['rev-parse', '--abbrev-ref', 'HEAD'], {
        cwd,
        encoding: 'utf-8',
        timeout: 5000,
      }).trim();
    } catch {
      return '';
    }
  }
}
