/**
 * Package-manager tool — auto-detects npm/yarn/pnpm/pip/cargo/go and
 * exposes install / add / remove / list / outdated / audit / detect.
 *
 * Row 9 fix (2026-04-24):
 * Pre-fix, every action concatenated MANAGERS string commands with
 * agent-supplied `pkg` and handed the result to `execSync(string, {cwd})`.
 * The pkg-name regex was tight (no shell metacharacters allowed), so
 * the shell-injection class was already closed at the validation
 * layer. The remaining gap was `cwd`: agent could pick any directory
 * (e.g., `~/.ssh`) and run `npm install` there.
 *
 * What this file now does:
 *   - `execFileSync(cmd, argv)`. Defense-in-depth: even if the pkg
 *     regex ever regresses, no shell expansion happens.
 *   - MANAGERS verbs are now `string[]` argv arrays, not space-joined
 *     strings. Mechanical refactor; the strings were hardcoded.
 *   - `cwd` contained under the agent's `projectRoot` (Issue #17
 *     pattern). Optional constructor arg, falls back to `process.cwd()`
 *     for back-compat.
 *   - Pkg-name regex per ecosystem kept (now strict defense-in-depth).
 *   - `buildPlan()` is a pure seam returning `{command, argv, cwd} |
 *     {error}` so tests pin the argv contract.
 */

import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Tool, CapabilityLabel } from '../types';

interface PkgManager {
  name: string;
  command: string;
  install: string[];
  add: string[];
  remove: string[];
  list: string[];
  outdated: string[];
  audit: string[];
}

const MANAGERS: Record<string, PkgManager> = {
  npm: {
    name: 'npm', command: 'npm',
    install: ['install'], add: ['install'],
    remove: ['uninstall'], list: ['ls', '--depth=0'],
    outdated: ['outdated'], audit: ['audit'],
  },
  yarn: {
    name: 'yarn', command: 'yarn',
    install: ['install'], add: ['add'],
    remove: ['remove'], list: ['list', '--depth=0'],
    outdated: ['outdated'], audit: ['audit'],
  },
  pnpm: {
    name: 'pnpm', command: 'pnpm',
    install: ['install'], add: ['add'],
    remove: ['remove'], list: ['ls', '--depth=0'],
    outdated: ['outdated'], audit: ['audit'],
  },
  pip: {
    name: 'pip', command: 'pip',
    install: ['install', '-r', 'requirements.txt'],
    add: ['install'],
    remove: ['uninstall', '-y'],
    list: ['list'],
    outdated: ['list', '--outdated'],
    audit: ['audit'],
  },
  cargo: {
    name: 'cargo', command: 'cargo',
    install: ['build'], add: ['add'],
    remove: ['remove'], list: ['tree', '--depth=1'],
    outdated: ['outdated'], audit: ['audit'],
  },
  go: {
    name: 'go', command: 'go',
    install: ['mod', 'download'],
    add: ['get'],
    remove: ['mod', 'tidy'],
    list: ['list', '-m', 'all'],
    outdated: ['list', '-m', '-u', 'all'],
    // govulncheck is a separate binary; keep the existing semantic.
    audit: [],
  },
};

const AUDIT_OVERRIDE: Record<string, { command: string; argv: string[] }> = {
  go: { command: 'govulncheck', argv: ['./...'] },
};

/**
 * Package name validation patterns by ecosystem. With argv these are
 * defense-in-depth; the previous shell-injection vector is closed by
 * `execFileSync`. Patterns kept as a clean policy-level rule.
 */
const SAFE_PKG_PATTERNS: Record<string, RegExp> = {
  npm:   /^(@[a-z0-9\-~][a-z0-9\-._~]*\/)?[a-z0-9\-~][a-z0-9\-._~]*(@[a-z0-9^~>=<.*\-]+)?$/,
  yarn:  /^(@[a-z0-9\-~][a-z0-9\-._~]*\/)?[a-z0-9\-~][a-z0-9\-._~]*(@[a-z0-9^~>=<.*\-]+)?$/,
  pnpm:  /^(@[a-z0-9\-~][a-z0-9\-._~]*\/)?[a-z0-9\-~][a-z0-9\-._~]*(@[a-z0-9^~>=<.*\-]+)?$/,
  pip:   /^[a-zA-Z0-9][a-zA-Z0-9._\-]*(\[[a-zA-Z0-9,._\-]+\])?(([>=<!=~]+)[a-zA-Z0-9.*]+)?$/,
  cargo: /^[a-zA-Z][a-zA-Z0-9_\-]*(@[a-zA-Z0-9.^~>=<*\-]+)?$/,
  go:    /^[a-zA-Z0-9][a-zA-Z0-9._\-/]*(@[a-zA-Z0-9.^~>=<*\-]+)?$/,
};

function splitPackages(pkg: string): string[] {
  return pkg.trim().split(/\s+/).filter(Boolean);
}

function arePackageNamesSafe(packages: string[], manager: string): boolean {
  const pattern = SAFE_PKG_PATTERNS[manager];
  if (!pattern) return false;
  for (const p of packages) {
    if (!pattern.test(p)) return false;
  }
  return true;
}

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

export type PkgPlan =
  | { command: string; argv: string[]; cwd: string; manager: string }
  | { error: string }
  | { detect: { name: string } | null };

export class PackageManagerTool implements Tool {
  name = 'package_manager';
  description = 'Manage dependencies. Auto-detects npm/yarn/pnpm/pip/cargo/go. Actions: install, add, remove, list, outdated, audit, detect.';
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
      action: { type: 'string', description: 'Action: install, add, remove, list, outdated, audit, detect' },
      package: { type: 'string', description: 'Package name(s) (for add/remove). Multiple names separated by whitespace.' },
      cwd: { type: 'string', description: 'Working directory (must be inside projectRoot)' },
      manager: { type: 'string', description: 'Force specific manager (npm, yarn, pnpm, pip, cargo, go)' },
    },
    required: ['action'],
  };

  /**
   * Pure seam: build the plan without executing. Returns one of:
   *   - {command, argv, cwd, manager} for run actions
   *   - {detect: PkgManager | null} for the detect action (no exec)
   *   - {error} for validation failures
   */
  public buildPlan(args: Record<string, unknown>): PkgPlan {
    const action = args.action;
    if (typeof action !== 'string' || action.length === 0) {
      return { error: 'Error: action is required' };
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

    if (action === 'detect') {
      const mgr = this.detect(cwd, args.manager as string | undefined);
      return { detect: mgr ? { name: mgr.name } : null };
    }

    const mgr = this.detect(cwd, args.manager as string | undefined);
    if (!mgr) return { error: 'Error: no package manager detected. Specify with manager parameter.' };

    let argv: string[];
    let command: string = mgr.command;
    switch (action) {
      case 'install':
        argv = [...mgr.install];
        break;
      case 'add': {
        const pkg = args.package;
        if (typeof pkg !== 'string' || pkg.length === 0) {
          return { error: 'Error: package name is required for add' };
        }
        const packages = splitPackages(pkg);
        if (!arePackageNamesSafe(packages, mgr.name)) {
          return { error: `Error: invalid package name "${pkg}". Package names must be alphanumeric with hyphens/underscores/dots only. Shell metacharacters are not allowed.` };
        }
        argv = [...mgr.add, ...packages];
        break;
      }
      case 'remove': {
        const pkg = args.package;
        if (typeof pkg !== 'string' || pkg.length === 0) {
          return { error: 'Error: package name is required for remove' };
        }
        const packages = splitPackages(pkg);
        if (!arePackageNamesSafe(packages, mgr.name)) {
          return { error: `Error: invalid package name "${pkg}". Package names must be alphanumeric with hyphens/underscores/dots only. Shell metacharacters are not allowed.` };
        }
        argv = [...mgr.remove, ...packages];
        break;
      }
      case 'list':
        argv = [...mgr.list];
        break;
      case 'outdated':
        argv = [...mgr.outdated];
        break;
      case 'audit': {
        const override = AUDIT_OVERRIDE[mgr.name];
        if (override) {
          command = override.command;
          argv = [...override.argv];
        } else {
          argv = [...mgr.audit];
        }
        break;
      }
      default:
        return { error: `Error: unknown action "${action}". Use: install, add, remove, list, outdated, audit, detect` };
    }

    return { command, argv, cwd, manager: mgr.name };
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const plan = this.buildPlan(args);
    if ('error' in plan) return plan.error;
    if ('detect' in plan) {
      return plan.detect ? `Detected: ${plan.detect.name}` : 'No package manager detected.';
    }

    try {
      const output = execFileSync(plan.command, plan.argv, {
        cwd: plan.cwd,
        timeout: 120_000,
        maxBuffer: 2 * 1024 * 1024,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return output.trim() || '(no output)';
    } catch (err: unknown) {
      const e = err as { code?: string; status?: number; stdout?: string; stderr?: string };
      if (e.code === 'ENOENT') {
        return `Error: ${plan.command} not found. Install it for this project's ecosystem.`;
      }
      const action = args.action as string;
      // Audit and outdated commands often exit non-zero when issues are found
      if (['audit', 'outdated'].includes(action) && e.stdout) {
        return e.stdout.trim();
      }
      return `Exit ${e.status || 1}:\n${(e.stdout || '').trim()}\n${(e.stderr || '').trim()}`.trim();
    }
  }

  private detect(cwd: string, forced?: string): PkgManager | null {
    if (forced && MANAGERS[forced]) return MANAGERS[forced];

    if (fs.existsSync(path.join(cwd, 'pnpm-lock.yaml'))) return MANAGERS.pnpm;
    if (fs.existsSync(path.join(cwd, 'yarn.lock'))) return MANAGERS.yarn;
    if (fs.existsSync(path.join(cwd, 'package-lock.json')) || fs.existsSync(path.join(cwd, 'package.json'))) return MANAGERS.npm;
    if (fs.existsSync(path.join(cwd, 'requirements.txt')) || fs.existsSync(path.join(cwd, 'setup.py')) || fs.existsSync(path.join(cwd, 'pyproject.toml'))) return MANAGERS.pip;
    if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) return MANAGERS.cargo;
    if (fs.existsSync(path.join(cwd, 'go.mod'))) return MANAGERS.go;

    return null;
  }
}
