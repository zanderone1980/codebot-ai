import { execFileSync } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { Tool, CapabilityLabel } from '../types';

/**
 * Framework descriptor. `command` + `args` are executed via execFileSync
 * (no shell). No user/agent/repo input is ever concatenated into a shell
 * string — that's how filter/path injection got in pre-2026-04-24.
 */
interface FrameworkInfo {
  name: string;
  command: string;
  args: string[];
  filePattern: string;
}

/**
 * Decide whether `target` is contained within `root`.
 *
 * Uses path.relative rather than startsWith to avoid the sibling-prefix
 * trap where `/tmp/project2` passes a `startsWith('/tmp/project')` check.
 *
 * Returns true iff target === root OR target lives under root.
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

export class TestRunnerTool implements Tool {
  name = 'test_runner';
  description = 'Run tests with auto-detected framework. Actions: run (execute tests), detect (show detected framework), list (list test files).';
  permission: Tool['permission'] = 'prompt';
  capabilities: CapabilityLabel[] = ['read-only', 'write-fs', 'run-cmd'];
  /**
   * Containment root. Issue #17: was `process.cwd()` baked in via Row 10;
   * now plumbed from `Agent.projectRoot` via `ToolRegistry` so a permission-
   * approved test_runner call can never hop sideways out of the agent's
   * declared project, regardless of where the process happens to be CWD'd.
   * Falls back to `process.cwd()` for back-compat with callers that still
   * `new TestRunnerTool()` with no arg (tests, ad-hoc instantiation).
   */
  private readonly projectRoot: string;
  constructor(projectRoot?: string) {
    this.projectRoot = projectRoot || process.cwd();
  }
  parameters = {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Action: run, detect, list' },
      path: { type: 'string', description: 'Test file or directory (defaults to project root)' },
      filter: { type: 'string', description: 'Test name filter / grep pattern' },
      cwd: { type: 'string', description: 'Working directory (must be inside the project root)' },
    },
    required: ['action'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = args.action as string;
    if (!action) return 'Error: action is required';

    // cwd containment. If the caller passes a cwd, it must be within the
    // agent's declared project root (Issue #17). We never clamp silently —
    // we reject. This matches the streaming exec gate's behavior.
    const root = this.projectRoot;
    let cwd: string;
    if (typeof args.cwd === 'string' && args.cwd.length > 0) {
      const resolved = path.resolve(root, args.cwd);
      if (!isContained(root, resolved)) {
        return `Error: cwd escapes project root (${resolved} not under ${root})`;
      }
      cwd = resolved;
    } else {
      cwd = root;
    }

    switch (action) {
      case 'detect': return this.detectFramework(cwd);
      case 'list': return this.listTestFiles(cwd);
      case 'run': return this.runTests(cwd, args);
      default: return `Error: unknown action "${action}". Use: run, detect, list`;
    }
  }

  private detectFramework(cwd: string): string {
    const fw = this.detect(cwd);
    if (!fw) return 'No test framework detected. Checked for: jest, vitest, mocha, node:test, pytest, go test, cargo test.';
    const shown = [fw.command, ...fw.args].join(' ');
    return `Detected: ${fw.name}\nCommand: ${shown}\nTest files: ${fw.filePattern}`;
  }

  private listTestFiles(cwd: string): string {
    const files: string[] = [];
    const skip = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

    this.findTests(cwd, files, skip, 0, 4);
    if (files.length === 0) return 'No test files found.';
    return `Test files (${files.length}):\n${files.map(f => `  ${f}`).join('\n')}`;
  }

  /**
   * Exposed for tests: build the (command, argv) pair without executing.
   * Returns either the planned exec OR an error string. Keeping this pure
   * lets tests pin the argv shape without having to stub child_process
   * (whose exports are read-only getters in modern Node).
   */
  public buildCommand(
    cwd: string,
    args: Record<string, unknown>,
  ): { command: string; argv: string[]; framework: string } | { error: string } {
    const fw = this.detect(cwd);
    if (!fw) return { error: 'Error: no test framework detected' };

    // Build argv by pushing string elements. execFileSync does NOT invoke a
    // shell — metacharacters inside any element stay literal.
    const argv: string[] = [...fw.args];

    const target = args.path;
    if (typeof target === 'string' && target.length > 0) {
      const resolved = path.resolve(cwd, target);
      if (!isContained(cwd, resolved)) {
        return { error: `Error: test path escapes cwd (${resolved} not under ${cwd})` };
      }
      argv.push(resolved);
    }

    const filter = args.filter;
    if (typeof filter === 'string' && filter.length > 0) {
      if (fw.name === 'jest' || fw.name === 'vitest') argv.push('-t', filter);
      else if (fw.name === 'pytest') argv.push('-k', filter);
      else if (fw.name === 'go test') argv.push('-run', filter);
      // Other frameworks ignore the filter rather than try to guess a syntax.
    }

    return { command: fw.command, argv, framework: fw.name };
  }

  private runTests(cwd: string, args: Record<string, unknown>): string {
    const plan = this.buildCommand(cwd, args);
    if ('error' in plan) return plan.error;

    try {
      const output = execFileSync(plan.command, plan.argv, {
        cwd,
        timeout: 120_000,
        maxBuffer: 2 * 1024 * 1024,
        encoding: 'utf-8',
        stdio: ['pipe', 'pipe', 'pipe'],
      });
      return this.summarize(output, plan.framework);
    } catch (err: unknown) {
      const e = err as { status?: number; stdout?: string; stderr?: string };
      const combined = `${e.stdout || ''}\n${e.stderr || ''}`.trim();
      return `Tests failed (exit ${e.status || 1}):\n${this.summarize(combined, plan.framework)}`;
    }
  }

  private detect(cwd: string): FrameworkInfo | null {
    // Check package.json for JS/TS projects.
    //
    // IMPORTANT: we never copy `pkg.scripts.test` verbatim into the exec
    // argv. A malicious package.json with `"test": "node --test && rm -rf ~"`
    // would otherwise be pasted straight into our shell call. Instead, we
    // use scripts.test only as a *classifier* to pick a known-good argv,
    // then defer to `npm test` if the project's own script is what the
    // user actually wants run — that's npm's trust boundary with the
    // package.json, not ours.
    const pkgPath = path.join(cwd, 'package.json');
    if (fs.existsSync(pkgPath)) {
      try {
        const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
        const scripts = pkg.scripts || {};
        const deps = { ...pkg.dependencies, ...pkg.devDependencies };

        if (typeof scripts.test === 'string') {
          if (scripts.test.includes('vitest')) return { name: 'vitest', command: 'npx', args: ['vitest', 'run'], filePattern: '*.test.ts' };
          if (scripts.test.includes('jest')) return { name: 'jest', command: 'npx', args: ['jest'], filePattern: '*.test.ts' };
          if (scripts.test.includes('mocha')) return { name: 'mocha', command: 'npx', args: ['mocha'], filePattern: '*.test.ts' };
          if (scripts.test.includes('node --test')) return { name: 'node:test', command: 'npm', args: ['test'], filePattern: '*.test.*' };
          // Generic npm test — let npm itself handle scripts.test. We do
          // NOT paste scripts.test into our argv.
          return { name: 'npm test', command: 'npm', args: ['test'], filePattern: '*.test.*' };
        }
        if (deps['vitest']) return { name: 'vitest', command: 'npx', args: ['vitest', 'run'], filePattern: '*.test.ts' };
        if (deps['jest']) return { name: 'jest', command: 'npx', args: ['jest'], filePattern: '*.test.ts' };
      } catch { /* invalid package.json */ }
    }

    // Python
    if (fs.existsSync(path.join(cwd, 'pytest.ini')) || fs.existsSync(path.join(cwd, 'setup.py')) || fs.existsSync(path.join(cwd, 'pyproject.toml'))) {
      return { name: 'pytest', command: 'python', args: ['-m', 'pytest', '-v'], filePattern: 'test_*.py' };
    }

    // Go
    if (fs.existsSync(path.join(cwd, 'go.mod'))) {
      return { name: 'go test', command: 'go', args: ['test', './...'], filePattern: '*_test.go' };
    }

    // Rust
    if (fs.existsSync(path.join(cwd, 'Cargo.toml'))) {
      return { name: 'cargo test', command: 'cargo', args: ['test'], filePattern: '*.rs' };
    }

    return null;
  }

  private summarize(output: string, _framework: string): string {
    const lines = output.split('\n');
    const summary: string[] = [];

    // Extract pass/fail counts
    for (const line of lines) {
      if (/(?:pass|fail|error|skip|pending|test|ok|FAIL)/i.test(line) && line.trim().length < 200) {
        summary.push(line);
      }
    }

    if (summary.length > 30) {
      return summary.slice(-30).join('\n') + '\n...(truncated)';
    }
    return summary.length > 0 ? summary.join('\n') : output.substring(0, 2000);
  }

  private findTests(dir: string, files: string[], skip: Set<string>, depth: number, maxDepth: number): void {
    if (depth >= maxDepth) return;
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        this.findTests(full, files, skip, depth + 1, maxDepth);
      } else if (/\.(test|spec)\.\w+$/.test(entry.name) || /^test_.*\.py$/.test(entry.name) || /_test\.go$/.test(entry.name)) {
        files.push(full);
      }
    }
  }
}
