import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PackageManagerTool } from './package-manager';

/**
 * PackageManagerTool — Row 9 tests (2026-04-24).
 *
 * Pre-fix the tool concatenated MANAGERS string commands with the
 * agent-supplied package name and handed the result to `execSync`. The
 * pkg-name regex was tight (no shell metachars allowed), so the
 * shell-injection class was already closed at the validation layer.
 * The remaining gap was `cwd`: agent could pick any directory and run
 * `npm install` there.
 *
 * Row 9 fix:
 *   - `execFileSync(cmd, argv)` everywhere. Defense-in-depth.
 *   - MANAGERS verbs are now `string[]` argv arrays, not space-joined
 *     strings.
 *   - `cwd` contained under `projectRoot` (Issue #17 pattern).
 *   - Pkg-name regex per ecosystem kept (now strict defense-in-depth).
 *   - `buildPlan()` is a pure seam returning {command, argv, cwd, manager}.
 */

describe('PackageManagerTool — metadata', () => {
  const tool = new PackageManagerTool();

  it('has correct tool name', () => {
    assert.strictEqual(tool.name, 'package_manager');
  });

  it('has prompt permission level', () => {
    assert.strictEqual(tool.permission, 'prompt');
  });

  it('requires action parameter', () => {
    const required = tool.parameters.required as string[];
    assert.ok(required.includes('action'));
  });

  it('has description mentioning dependency management', () => {
    assert.ok(tool.description.includes('dependencies') || tool.description.includes('Manage'));
  });
});

describe('PackageManagerTool — input validation', () => {
  let projectRoot: string;
  let tool: PackageManagerTool;

  before(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row9-pkgmgr-validation-'));
    tool = new PackageManagerTool(projectRoot);
  });

  after(() => {
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns error when action is missing', async () => {
    const result = await tool.execute({});
    assert.ok(result.includes('Error: action is required'));
  });

  it('returns error for unknown action', async () => {
    fs.writeFileSync(path.join(projectRoot, 'package.json'), '{}', 'utf-8');
    const result = await tool.execute({ action: 'deploy' });
    assert.ok(result.includes('Error: unknown action'));
    assert.ok(result.includes('deploy'));
    assert.ok(result.includes('install, add, remove'));
    fs.unlinkSync(path.join(projectRoot, 'package.json'));
  });
});

describe('PackageManagerTool — detect action', () => {
  let projectRoot: string;

  before(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row9-pkgmgr-detect-'));
  });

  after(() => {
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function makeSubdir(name: string): { tool: PackageManagerTool; cwd: string } {
    const dir = path.join(projectRoot, name);
    fs.mkdirSync(dir, { recursive: true });
    const tool = new PackageManagerTool(projectRoot);
    return { tool, cwd: dir };
  }

  it('detects npm when package.json exists', async () => {
    const { tool, cwd } = makeSubdir('npm-project');
    fs.writeFileSync(path.join(cwd, 'package.json'), '{}', 'utf-8');
    const result = await tool.execute({ action: 'detect', cwd });
    assert.ok(result.includes('Detected: npm'));
  });

  it('detects yarn when yarn.lock exists', async () => {
    const { tool, cwd } = makeSubdir('yarn-project');
    fs.writeFileSync(path.join(cwd, 'yarn.lock'), '', 'utf-8');
    const result = await tool.execute({ action: 'detect', cwd });
    assert.ok(result.includes('Detected: yarn'));
  });

  it('detects pnpm when pnpm-lock.yaml exists', async () => {
    const { tool, cwd } = makeSubdir('pnpm-project');
    fs.writeFileSync(path.join(cwd, 'pnpm-lock.yaml'), '', 'utf-8');
    const result = await tool.execute({ action: 'detect', cwd });
    assert.ok(result.includes('Detected: pnpm'));
  });

  it('detects pip when requirements.txt exists', async () => {
    const { tool, cwd } = makeSubdir('pip-project');
    fs.writeFileSync(path.join(cwd, 'requirements.txt'), '', 'utf-8');
    const result = await tool.execute({ action: 'detect', cwd });
    assert.ok(result.includes('Detected: pip'));
  });

  it('detects cargo when Cargo.toml exists', async () => {
    const { tool, cwd } = makeSubdir('cargo-project');
    fs.writeFileSync(path.join(cwd, 'Cargo.toml'), '', 'utf-8');
    const result = await tool.execute({ action: 'detect', cwd });
    assert.ok(result.includes('Detected: cargo'));
  });

  it('detects go when go.mod exists', async () => {
    const { tool, cwd } = makeSubdir('go-project');
    fs.writeFileSync(path.join(cwd, 'go.mod'), '', 'utf-8');
    const result = await tool.execute({ action: 'detect', cwd });
    assert.ok(result.includes('Detected: go'));
  });

  it('returns "No package manager detected" for empty dir', async () => {
    const { tool, cwd } = makeSubdir('empty-project');
    const result = await tool.execute({ action: 'detect', cwd });
    assert.ok(result.includes('No package manager detected'));
  });

  it('uses forced manager when specified', async () => {
    const { tool, cwd } = makeSubdir('forced-project');
    const result = await tool.execute({ action: 'detect', cwd, manager: 'yarn' });
    assert.ok(result.includes('Detected: yarn'));
  });
});

describe('PackageManagerTool — add/remove require package name', () => {
  let projectRoot: string;

  before(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row9-pkgmgr-addrm-'));
    fs.writeFileSync(path.join(projectRoot, 'package.json'), '{}', 'utf-8');
  });

  after(() => {
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('returns error when package name is missing for add', async () => {
    const tool = new PackageManagerTool(projectRoot);
    const result = await tool.execute({ action: 'add' });
    assert.ok(result.includes('Error: package name is required for add'));
  });

  it('returns error when package name is missing for remove', async () => {
    const tool = new PackageManagerTool(projectRoot);
    const result = await tool.execute({ action: 'remove' });
    assert.ok(result.includes('Error: package name is required for remove'));
  });

  it('returns error when no package manager is detected', async () => {
    const empty = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row9-pkgmgr-empty-'));
    try {
      const tool = new PackageManagerTool(empty);
      const result = await tool.execute({ action: 'install' });
      assert.ok(result.includes('Error: no package manager detected'));
    } finally {
      fs.rmSync(empty, { recursive: true, force: true });
    }
  });
});

describe('PackageManagerTool — malicious package name blocking (defense-in-depth)', () => {
  let projectRoot: string;

  before(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row9-pkgmgr-mal-'));
    fs.writeFileSync(path.join(projectRoot, 'package.json'), '{}', 'utf-8');
  });

  after(() => {
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('blocks package name with semicolon', async () => {
    const tool = new PackageManagerTool(projectRoot);
    const result = await tool.execute({ action: 'add', package: 'lodash; rm -rf /' });
    assert.ok(result.includes('Error: invalid package name'));
  });

  it('blocks package name with pipe', async () => {
    const tool = new PackageManagerTool(projectRoot);
    const result = await tool.execute({ action: 'add', package: 'lodash | cat /etc/passwd' });
    assert.ok(result.includes('Error: invalid package name'));
  });

  it('blocks package name with backticks', async () => {
    const tool = new PackageManagerTool(projectRoot);
    const result = await tool.execute({ action: 'add', package: '`rm -rf /`' });
    assert.ok(result.includes('Error: invalid package name'));
  });

  it('blocks package name with $()', async () => {
    const tool = new PackageManagerTool(projectRoot);
    const result = await tool.execute({ action: 'add', package: '$(whoami)' });
    assert.ok(result.includes('Error: invalid package name'));
  });

  it('allows valid npm package names', () => {
    const tool = new PackageManagerTool(projectRoot);
    const plan = tool.buildPlan({ action: 'add', package: 'lodash' });
    assert.ok(!('error' in plan), `expected plan, got error: ${'error' in plan ? plan.error : ''}`);
  });

  it('allows scoped npm package names', () => {
    const tool = new PackageManagerTool(projectRoot);
    const plan = tool.buildPlan({ action: 'add', package: '@types/node' });
    assert.ok(!('error' in plan));
  });

  it('allows npm package with version specifier', () => {
    const tool = new PackageManagerTool(projectRoot);
    const plan = tool.buildPlan({ action: 'add', package: 'express@4.18.0' });
    assert.ok(!('error' in plan));
  });
});

/**
 * Row 9 — argv shape via buildPlan(). Pure seam; no manager binary
 * needed. These pin the array-form contract so a future refactor
 * can't slide back into space-joined strings.
 */
describe('PackageManagerTool — argv shape (Row 9: via buildPlan)', () => {
  let projectRoot: string;

  before(() => {
    projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row9-pkgmgr-argv-'));
    fs.writeFileSync(path.join(projectRoot, 'package.json'), '{}', 'utf-8');
  });

  after(() => {
    try { fs.rmSync(projectRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  function isRunPlan(p: unknown): p is { command: string; argv: string[]; cwd: string; manager: string } {
    return typeof p === 'object' && p !== null && 'command' in p && 'argv' in p;
  }

  it('npm add: argv is ["install", "<pkg>"]', () => {
    const tool = new PackageManagerTool(projectRoot);
    const plan = tool.buildPlan({ action: 'add', package: 'lodash' });
    assert.ok(isRunPlan(plan));
    if (!isRunPlan(plan)) return;
    assert.strictEqual(plan.command, 'npm');
    assert.deepStrictEqual(plan.argv, ['install', 'lodash']);
  });

  it('npm add: scoped name stays as a single argv element', () => {
    const tool = new PackageManagerTool(projectRoot);
    const plan = tool.buildPlan({ action: 'add', package: '@types/node' });
    assert.ok(isRunPlan(plan));
    if (!isRunPlan(plan)) return;
    assert.deepStrictEqual(plan.argv, ['install', '@types/node']);
  });

  it('npm add multiple: split on whitespace, each becomes one argv element', () => {
    const tool = new PackageManagerTool(projectRoot);
    const plan = tool.buildPlan({ action: 'add', package: 'react react-dom' });
    assert.ok(isRunPlan(plan));
    if (!isRunPlan(plan)) return;
    assert.deepStrictEqual(plan.argv, ['install', 'react', 'react-dom']);
  });

  it('npm install: argv is just ["install"]', () => {
    const tool = new PackageManagerTool(projectRoot);
    const plan = tool.buildPlan({ action: 'install' });
    assert.ok(isRunPlan(plan));
    if (!isRunPlan(plan)) return;
    assert.deepStrictEqual(plan.argv, ['install']);
  });

  it('pip install (with forced manager): argv carries -r requirements.txt', () => {
    const pipDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row9-pkgmgr-pip-'));
    fs.writeFileSync(path.join(pipDir, 'requirements.txt'), '', 'utf-8');
    try {
      const tool = new PackageManagerTool(pipDir);
      const plan = tool.buildPlan({ action: 'install' });
      assert.ok(isRunPlan(plan));
      if (!isRunPlan(plan)) return;
      assert.strictEqual(plan.command, 'pip');
      assert.deepStrictEqual(plan.argv, ['install', '-r', 'requirements.txt']);
    } finally {
      fs.rmSync(pipDir, { recursive: true, force: true });
    }
  });

  it('go list outdated: argv carries -m -u all', () => {
    const goDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row9-pkgmgr-go-'));
    fs.writeFileSync(path.join(goDir, 'go.mod'), 'module x', 'utf-8');
    try {
      const tool = new PackageManagerTool(goDir);
      const plan = tool.buildPlan({ action: 'outdated' });
      assert.ok(isRunPlan(plan));
      if (!isRunPlan(plan)) return;
      assert.strictEqual(plan.command, 'go');
      assert.deepStrictEqual(plan.argv, ['list', '-m', '-u', 'all']);
    } finally {
      fs.rmSync(goDir, { recursive: true, force: true });
    }
  });

  it('go audit: dispatches to govulncheck (separate binary)', () => {
    const goDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row9-pkgmgr-goaudit-'));
    fs.writeFileSync(path.join(goDir, 'go.mod'), 'module x', 'utf-8');
    try {
      const tool = new PackageManagerTool(goDir);
      const plan = tool.buildPlan({ action: 'audit' });
      assert.ok(isRunPlan(plan));
      if (!isRunPlan(plan)) return;
      assert.strictEqual(plan.command, 'govulncheck');
      assert.deepStrictEqual(plan.argv, ['./...']);
    } finally {
      fs.rmSync(goDir, { recursive: true, force: true });
    }
  });
});

/**
 * Row 9 — cwd containment.
 */
describe('PackageManagerTool — cwd containment (Row 9 — closes the actual gap)', () => {
  it('rejects cwd outside projectRoot via parent traversal', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row9-pkgmgr-contain-'));
    try {
      const tool = new PackageManagerTool(projectRoot);
      const plan = tool.buildPlan({ action: 'install', cwd: '../../etc' });
      assert.ok('error' in plan);
      if ('error' in plan) assert.match(plan.error, /cwd escapes project root/);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects absolute cwd outside projectRoot', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row9-pkgmgr-contain-'));
    try {
      const tool = new PackageManagerTool(projectRoot);
      const escapeTarget = process.platform === 'win32' ? 'C:\\Windows\\System32' : '/etc/passwd';
      const plan = tool.buildPlan({ action: 'install', cwd: escapeTarget });
      assert.ok('error' in plan);
      if ('error' in plan) assert.match(plan.error, /cwd escapes project root/);
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('rejects sibling-prefix cwd', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row9-pkgmgr-contain-'));
    try {
      const sibling = projectRoot + '-evil';
      const tool = new PackageManagerTool(projectRoot);
      const plan = tool.buildPlan({ action: 'install', cwd: sibling });
      assert.ok('error' in plan, 'sibling-prefix must be rejected');
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });

  it('accepts cwd inside projectRoot', () => {
    const projectRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row9-pkgmgr-contain-'));
    const sub = path.join(projectRoot, 'sub');
    fs.mkdirSync(sub);
    fs.writeFileSync(path.join(sub, 'package.json'), '{}', 'utf-8');
    try {
      const tool = new PackageManagerTool(projectRoot);
      const plan = tool.buildPlan({ action: 'install', cwd: 'sub' });
      assert.ok(!('error' in plan) && !('detect' in plan));
    } finally {
      fs.rmSync(projectRoot, { recursive: true, force: true });
    }
  });
});

/**
 * Row 9 — real-exec canary. Even if pkg regex catches `;rm`, prove
 * argv-form means no shell expansion. Driven through buildPlan with
 * a payload that the regex would reject — and through execute()
 * with a regex-bypassing edge case.
 */
describe('PackageManagerTool — local-shell injection canary (real exec)', () => {
  let workDir: string;
  let originalCwd: string;

  before(() => {
    originalCwd = process.cwd();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row9-pkgmgr-canary-'));
    process.chdir(workDir);
    fs.writeFileSync(path.join(workDir, 'package.json'), '{}', 'utf-8');
  });

  after(() => {
    process.chdir(originalCwd);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('regex rejects $(...) payloads (shell injection blocked at validation)', async () => {
    const marker = path.join(workDir, 'PWNED_PKG_DOLLAR');
    const tool = new PackageManagerTool(workDir);
    const payload = `lodash$(node -e "require('fs').writeFileSync('${marker.replace(/\\/g, '\\\\')}','pwned')")`;
    const result = await tool.execute({ action: 'add', package: payload });
    assert.match(result, /invalid package name/, 'regex must reject');
    assert.strictEqual(fs.existsSync(marker), false,
      `LOCAL SHELL INJECTION REGRESSION: ${marker} created via package.`);
  });

  it('regex rejects backtick payloads', async () => {
    const marker = path.join(workDir, 'PWNED_PKG_BACKTICK');
    const tool = new PackageManagerTool(workDir);
    const payload = `lodash\`node -e "require('fs').writeFileSync('${marker.replace(/\\/g, '\\\\')}','pwned')"\``;
    const result = await tool.execute({ action: 'add', package: payload });
    assert.match(result, /invalid package name/);
    assert.strictEqual(fs.existsSync(marker), false);
  });
});
