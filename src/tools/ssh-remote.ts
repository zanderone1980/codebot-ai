/**
 * SSH/SCP remote-execution tool.
 *
 * Row 8 fix (2026-04-24):
 * Pre-fix, every action used `execSync(string)` with agent-supplied
 * `command`, `local_path`, and `remote_path` concatenated raw into a
 * shell line. The `JSON.stringify(cmd)` wrapper looked like quoting,
 * but it produces double-quoted strings — and bash expands `$(...)`,
 * backticks, and `${...}` INSIDE double quotes. So:
 *
 *   command = '$(touch /tmp/pwned)'
 *   →  ssh ... host "$(touch /tmp/pwned)"
 *   →  bash expands $(...) LOCALLY, runs `touch`, then sends the
 *      empty result over ssh.
 *
 * Same shape for `scp ... "${local}" ${host}:"${remote}"` — `local`
 * and `remote` were entirely unvalidated.
 *
 * Security claim of this fix: **argv-based exec removes the LOCAL
 * shell from the loop**. Metacharacters in `command`, `local_path`,
 * and `remote_path` cannot trigger code execution on the agent's
 * machine. The remote command still passes through the REMOTE shell
 * by SSH protocol design — that's how `ssh host "ls /tmp"` is
 * supposed to work, and we are not in the business of sandboxing the
 * remote box. The user/policy decides whether they trust the host.
 *
 * What this file now does:
 *   - `execFileSync('ssh' | 'scp', argv)`. No local shell.
 *   - `host` still validated by `SAFE_HOST` (defense-in-depth on the
 *     SSH target, since some malformed hosts would otherwise hit
 *     OpenSSH's own shell-out paths via ProxyCommand expansion).
 *   - `local_path` for upload/download is contained under the agent's
 *     declared `projectRoot` (Issue #17 pattern). Pre-fix, the agent
 *     could read `/etc/shadow` via download or write into any path
 *     via upload.
 *   - `buildSshArgv()` / `buildScpArgv()` are pure seams returning
 *     `{command, argv} | {error}` so tests pin the argv contract.
 */

import { execFileSync } from 'child_process';
import * as path from 'path';
import { Tool, CapabilityLabel } from '../types';

// Block injection-y characters in host/user inputs. Even argv-only execs
// pipe `host` to OpenSSH's config parser, where ProxyCommand and similar
// directives can shell-out — keeping host strict closes that side door.
const SAFE_HOST = /^[a-zA-Z0-9._\-@:]+$/;

/**
 * Decide whether `target` is contained within `root`.
 * Sibling-prefix safe via path.relative.
 */
function isContained(root: string, target: string): boolean {
  const absRoot = path.resolve(root);
  const absTarget = path.resolve(target);
  if (absRoot === absTarget) return true;
  const rel = path.relative(absRoot, absTarget);
  if (!rel) return true;
  if (rel.startsWith('..')) return false;
  if (path.isAbsolute(rel)) return false;
  return true;
}

export type SshPlan =
  | { command: 'ssh' | 'scp'; argv: string[] }
  | { error: string };

export class SshRemoteTool implements Tool {
  name = 'ssh_remote';
  description = 'Execute commands on remote servers via SSH, or upload/download files via SCP. Actions: exec, upload, download.';
  permission: Tool['permission'] = 'always-ask';
  capabilities: CapabilityLabel[] = ['write-fs', 'run-cmd', 'net-fetch'];
  /**
   * Containment root for local paths (upload source, download target).
   * Issue #17 pattern: plumbed from `Agent.projectRoot` via `ToolRegistry`,
   * falls back to `process.cwd()` for back-compat.
   */
  private readonly projectRoot: string;
  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot || process.cwd();
  }
  parameters = {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Action: exec, upload, download' },
      host: { type: 'string', description: 'SSH target (user@hostname or hostname)' },
      command: { type: 'string', description: 'Command to execute remotely (for exec)' },
      local_path: { type: 'string', description: 'Local file path — must be inside projectRoot (for upload/download)' },
      remote_path: { type: 'string', description: 'Remote file path (for upload/download)' },
      port: { type: 'number', description: 'SSH port (default: 22)' },
    },
    required: ['action', 'host'],
  };

  /**
   * Pure seam: build the (command, argv) pair without executing.
   * Lets tests pin the argv contract without stubbing child_process.
   */
  public buildPlan(args: Record<string, unknown>): SshPlan {
    const action = args.action as string;
    const host = args.host as string;
    if (!action) return { error: 'Error: action is required' };
    if (!host) return { error: 'Error: host is required' };
    if (!SAFE_HOST.test(host)) {
      return { error: 'Error: host contains invalid characters (possible injection)' };
    }

    // port: strict number, in [1, 65535]
    let port = 22;
    if (args.port !== undefined && args.port !== null) {
      if (typeof args.port !== 'number' || !Number.isInteger(args.port) || args.port < 1 || args.port > 65535) {
        return { error: 'Error: port must be an integer in [1, 65535]' };
      }
      port = args.port;
    }

    const sshOpts = ['-o', 'ConnectTimeout=10', '-o', 'StrictHostKeyChecking=accept-new'];

    switch (action) {
      case 'exec': {
        const cmd = args.command;
        if (typeof cmd !== 'string' || cmd.length === 0) {
          return { error: 'Error: command is required for exec' };
        }
        const portArg = port !== 22 ? ['-p', String(port)] : [];
        // argv: [..opts, host, cmd]. ssh sends `cmd` to the remote shell
        // verbatim — that's by SSH design. Our claim is only about the
        // local exec.
        return { command: 'ssh', argv: [...sshOpts, ...portArg, host, cmd] };
      }
      case 'upload': {
        const local = args.local_path;
        const remote = args.remote_path;
        if (typeof local !== 'string' || local.length === 0 || typeof remote !== 'string' || remote.length === 0) {
          return { error: 'Error: local_path and remote_path are required' };
        }
        const localResolved = path.resolve(this.projectRoot, local);
        if (!isContained(this.projectRoot, localResolved)) {
          return { error: `Error: local_path escapes project root (${localResolved} not under ${this.projectRoot})` };
        }
        const portArg = port !== 22 ? ['-P', String(port)] : [];
        // SCP target spec is `host:remote`. We assemble it as a single
        // argv element so a malicious `host` containing spaces or a
        // malicious `remote` with metacharacters cannot split it.
        // `host` is SAFE_HOST-validated; `remote` may contain anything,
        // but it stays inside one argv element and never sees a local
        // shell. The remote SCP server interprets it on the other end —
        // again, that's the protocol's design.
        return { command: 'scp', argv: [...sshOpts, ...portArg, localResolved, `${host}:${remote}`] };
      }
      case 'download': {
        const local = args.local_path;
        const remote = args.remote_path;
        if (typeof local !== 'string' || local.length === 0 || typeof remote !== 'string' || remote.length === 0) {
          return { error: 'Error: local_path and remote_path are required' };
        }
        const localResolved = path.resolve(this.projectRoot, local);
        if (!isContained(this.projectRoot, localResolved)) {
          return { error: `Error: local_path escapes project root (${localResolved} not under ${this.projectRoot})` };
        }
        const portArg = port !== 22 ? ['-P', String(port)] : [];
        return { command: 'scp', argv: [...sshOpts, ...portArg, `${host}:${remote}`, localResolved] };
      }
      default:
        return { error: `Error: unknown action "${action}". Use: exec, upload, download` };
    }
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const plan = this.buildPlan(args);
    if ('error' in plan) return plan.error;

    try {
      const output = execFileSync(plan.command, plan.argv, {
        timeout: 60_000,
        maxBuffer: 2 * 1024 * 1024,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return output.trim() || '(no output)';
    } catch (err: unknown) {
      const e = err as { status?: number; stderr?: string };
      const msg = (e.stderr || `${plan.command} command failed`).trim();
      if (msg.includes('Connection refused') || msg.includes('Connection timed out')) {
        return `Error: could not connect to host. ${msg}`;
      }
      if (msg.includes('Permission denied')) {
        return 'Error: authentication failed. Check SSH key or credentials.';
      }
      return `Exit ${e.status || 1}: ${msg}`;
    }
  }
}
