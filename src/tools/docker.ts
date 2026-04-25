/**
 * Docker tool — ps / images / run / stop / build / logs / exec /
 * inspect / pull / compose_up / compose_down / compose_ps.
 *
 * Row 9 fix (2026-04-24):
 * Pre-fix, every action assembled `docker <verb> ${extra}` and handed
 * it to `execSync(string, {cwd})`. `extra` was a totally-raw string
 * passed straight through:
 *
 *   args: '; rm -rf ~'  →  docker ps ; rm -rf ~   (sh -c)
 *
 * The `--privileged` and `-v /:/` regex filters operated on the joined
 * string but didn't address shell metacharacters at all. `cwd` was
 * also unconstrained.
 *
 * What this file now does:
 *   - `execFileSync('docker', argv)`. No local shell.
 *   - `args` is **strict `string[]`**. A string `args` is rejected with
 *     a clear error pointing at the new shape. Whitespace-splitting a
 *     string would silently change semantics for legit flags like
 *     `--label key="hello world"` and would also silently neuter the
 *     trivial-injection class. Hard rejection is more honest.
 *   - `cwd` is contained under the agent's `projectRoot` (Issue #17
 *     pattern). Optional constructor arg, falls back to `process.cwd()`
 *     for back-compat.
 *   - `--privileged` and root-mount blockers now match argv elements,
 *     not joined strings. Same defense-in-depth, more honest matcher.
 *   - `buildPlan()` is a pure seam returning `{command, argv} | {error}`
 *     so tests pin the argv contract.
 */

import { execFileSync } from 'child_process';
import * as path from 'path';
import { Tool, CapabilityLabel } from '../types';

const ALLOWED_ACTIONS = [
  'ps', 'images', 'run', 'stop', 'rm', 'build', 'logs', 'exec',
  'compose_up', 'compose_down', 'compose_ps', 'inspect', 'pull',
];

/**
 * Static argv prefix per action. The verb tokens come from this table,
 * never from agent input.
 */
const ACTION_PREFIX: Record<string, string[]> = {
  ps:            ['ps'],
  images:        ['images'],
  run:           ['run'],
  stop:          ['stop'],
  rm:            ['rm'],
  build:         ['build'],
  logs:          ['logs', '--tail', '100'],
  exec:          ['exec'],
  inspect:       ['inspect'],
  pull:          ['pull'],
  compose_up:    ['compose', 'up', '-d'],
  compose_down:  ['compose', 'down'],
  compose_ps:    ['compose', 'ps'],
};

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

/**
 * Defense-in-depth blockers, applied to argv elements not the joined
 * string. With argv, these are no longer the security boundary —
 * `execFileSync` already prevents shell expansion. They remain as a
 * policy-layer "don't even ask docker to do this" rule.
 */
function findBlockedFlag(argv: string[]): string | null {
  for (let i = 0; i < argv.length; i++) {
    const el = argv[i];
    if (el === '--privileged' || el.startsWith('--privileged=')) {
      return '--privileged flag is blocked for safety.';
    }
    // Root mount: `-v /:/...` or `--volume=/:/...` or `--volume /:/...`
    if (el === '-v' || el === '--volume') {
      const next = argv[i + 1];
      if (typeof next === 'string' && /^\/:/.test(next)) {
        return 'mounting root filesystem is blocked for safety.';
      }
    }
    if (el.startsWith('--volume=') && /^--volume=\/:/.test(el)) {
      return 'mounting root filesystem is blocked for safety.';
    }
    if (el.startsWith('-v') && el.length > 2 && /^-v\/:/.test(el)) {
      return 'mounting root filesystem is blocked for safety.';
    }
  }
  return null;
}

export type DockerPlan =
  | { command: 'docker'; argv: string[]; cwd: string }
  | { error: string };

export class DockerTool implements Tool {
  name = 'docker';
  description = 'Run Docker operations. Actions: ps, images, run, stop, rm, build, logs, exec, compose_up, compose_down, compose_ps, inspect, pull. `args` MUST be a string array (e.g., ["-d", "--name", "nginx", "nginx:latest"]). String args are rejected.';
  permission: Tool['permission'] = 'prompt';
  capabilities: CapabilityLabel[] = ['write-fs', 'run-cmd', 'net-fetch'];
  /**
   * Containment root. Issue #17 pattern: plumbed from `Agent.projectRoot`
   * via `ToolRegistry`, falls back to `process.cwd()` for back-compat.
   */
  private readonly projectRoot: string;
  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot || process.cwd();
  }
  parameters = {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Docker action to perform' },
      args: {
        type: 'array',
        items: { type: 'string' },
        description: 'Docker flags/args as a string array. Each element becomes one argv token, never interpreted by a shell. Example: ["-d", "--name", "nginx", "nginx:latest"]',
      },
      cwd: { type: 'string', description: 'Working directory (must be inside projectRoot)' },
    },
    required: ['action'],
  };

  /**
   * Pure seam: build the (command, argv, cwd) triple without executing.
   */
  public buildPlan(args: Record<string, unknown>): DockerPlan {
    const action = args.action;
    if (typeof action !== 'string' || action.length === 0) {
      return { error: 'Error: action is required' };
    }
    if (!ALLOWED_ACTIONS.includes(action)) {
      return { error: `Error: unknown action "${action}". Allowed: ${ALLOWED_ACTIONS.join(', ')}` };
    }

    // args must be string[]. A bare string is rejected — see file
    // header for why we don't whitespace-split silently.
    let extra: string[] = [];
    if (args.args !== undefined && args.args !== null) {
      if (typeof args.args === 'string') {
        return { error: 'Error: docker args must be a string array (e.g., ["-d", "--name", "nginx"]). Pass each flag/value as its own array element. String args are rejected to avoid silent shell-quoting bugs.' };
      }
      if (!Array.isArray(args.args) || !args.args.every(a => typeof a === 'string')) {
        return { error: 'Error: docker args must be an array of strings' };
      }
      extra = args.args as string[];
    }

    // cwd containment.
    let cwd = this.projectRoot;
    if (args.cwd !== undefined && args.cwd !== null) {
      if (typeof args.cwd !== 'string' || args.cwd.length === 0) {
        return { error: 'Error: cwd must be a non-empty string' };
      }
      const resolved = path.resolve(this.projectRoot, args.cwd);
      if (!isContained(this.projectRoot, resolved)) {
        return { error: `Error: cwd escapes project root (${resolved} not under ${this.projectRoot})` };
      }
      cwd = resolved;
    }

    const prefix = ACTION_PREFIX[action];
    const argv = [...prefix, ...extra];

    // Defense-in-depth blockers on argv elements. With execFileSync the
    // shell can't fire anyway, but these are policy-layer "don't even
    // try" rules.
    const blocked = findBlockedFlag(argv);
    if (blocked) return { error: `Error: ${blocked}` };

    return { command: 'docker', argv, cwd };
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const plan = this.buildPlan(args);
    if ('error' in plan) return plan.error;

    try {
      const output = execFileSync(plan.command, plan.argv, {
        cwd: plan.cwd,
        timeout: 60_000,
        maxBuffer: 2 * 1024 * 1024,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return output.trim() || '(no output)';
    } catch (err: unknown) {
      const e = err as { code?: string; status?: number; stdout?: string; stderr?: string };
      if (e.code === 'ENOENT') {
        return 'Error: Docker is not installed or not running. Install Docker Desktop or start the Docker daemon.';
      }
      const msg = (e.stderr || e.stdout || 'command failed').trim();
      if (msg.includes('Cannot connect')) {
        return 'Error: Docker is not installed or not running. Install Docker Desktop or start the Docker daemon.';
      }
      return `Exit ${e.status || 1}: ${msg}`;
    }
  }
}
