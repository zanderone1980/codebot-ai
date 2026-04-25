import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { DockerTool } from './docker';

/**
 * DockerTool — Row 9 injection + containment tests (2026-04-24).
 *
 * Pre-fix the tool concatenated `extra` (a raw user-supplied string)
 * into `docker <verb> ${extra}` and handed it to `execSync(string)`.
 * Trivial bypass via `args: '; rm -rf ~'`. The `--privileged` and
 * `-v /:/` regex filters didn't address shell metacharacters at all
 * and `cwd` had no containment.
 *
 * Row 9 fix:
 *   - `execFileSync('docker', argv)`. No local shell.
 *   - `args` is **strict `string[]`** — string `args` rejected with
 *     a clear error.
 *   - `cwd` contained under `projectRoot` (Issue #17 pattern).
 *   - Blockers (`--privileged`, root mount) match argv elements,
 *     not joined strings.
 */

describe('DockerTool — metadata', () => {
  const tool = new DockerTool();

  it('has correct tool name', () => {
    assert.strictEqual(tool.name, 'docker');
  });

  it('has prompt permission level', () => {
    assert.strictEqual(tool.permission, 'prompt');
  });

  it('requires action parameter', () => {
    const required = tool.parameters.required as string[];
    assert.ok(required.includes('action'));
  });

  it('JSON schema declares args as a string array (Row 9 contract)', () => {
    const props = (tool.parameters as { properties: Record<string, { type?: string; items?: { type?: string } }> }).properties;
    assert.strictEqual(props.args.type, 'array',
      'args.type must be "array" so the JSON schema actually advertises the new shape');
    assert.strictEqual(props.args.items?.type, 'string',
      'args.items.type must be "string"');
  });
});

describe('DockerTool — unknown action handling', () => {
  const tool = new DockerTool();

  it('returns error for unknown action', async () => {
    const result = await tool.execute({ action: 'destroy_all' });
    assert.ok(result.includes('Error: unknown action'));
    assert.ok(result.includes('destroy_all'));
    assert.ok(result.includes('Allowed:'));
  });

  it('returns error when action is missing', async () => {
    const result = await tool.execute({});
    assert.ok(result.includes('Error: action is required'));
  });

  it('lists allowed actions in error message', async () => {
    const result = await tool.execute({ action: 'nope' });
    for (const a of ['ps', 'images', 'run', 'stop', 'build']) {
      assert.ok(result.includes(a), `expected "${a}" in error: ${result}`);
    }
  });
});

/**
 * Row 9 — args parameter shape. String args are rejected, array args
 * are passed as discrete argv elements. The `--privileged` /
 * root-mount blockers operate on the argv elements.
 */
describe('DockerTool — args contract (Row 9)', () => {
  const tool = new DockerTool();

  it('rejects string args with a clear "use array form" error', async () => {
    const result = await tool.execute({ action: 'run', args: '-d nginx' });
    assert.match(result, /docker args must be a string array/);
    assert.match(result, /String args are rejected/);
  });

  it('rejects string args even for trivial-injection payloads', async () => {
    const result = await tool.execute({ action: 'ps', args: '; rm -rf ~' });
    assert.match(result, /docker args must be a string array/);
  });

  it('rejects non-string elements in args array', async () => {
    const result = await tool.execute({ action: 'run', args: ['-d', 42 as unknown as string, 'nginx'] });
    assert.match(result, /docker args must be an array of strings/);
  });

  it('accepts empty args array', () => {
    const plan = tool.buildPlan({ action: 'ps' });
    assert.ok(!('error' in plan));
    if ('error' in plan) return;
    assert.deepStrictEqual(plan.argv, ['ps']);
  });

  it('accepts string array, each element becomes one argv token', () => {
    const plan = tool.buildPlan({
      action: 'run',
      args: ['-d', '--name', 'nginx', 'nginx:latest'],
    });
    assert.ok(!('error' in plan));
    if ('error' in plan) return;
    assert.deepStrictEqual(plan.argv, ['run', '-d', '--name', 'nginx', 'nginx:latest']);
  });

  it('compose_up prefix is multi-token, agent extras append after', () => {
    const plan = tool.buildPlan({
      action: 'compose_up',
      args: ['service-a'],
    });
    assert.ok(!('error' in plan));
    if ('error' in plan) return;
    assert.deepStrictEqual(plan.argv, ['compose', 'up', '-d', 'service-a']);
  });

  it('logs prefix includes --tail 100, agent extras append', () => {
    const plan = tool.buildPlan({
      action: 'logs',
      args: ['my-container'],
    });
    assert.ok(!('error' in plan));
    if ('error' in plan) return;
    assert.deepStrictEqual(plan.argv, ['logs', '--tail', '100', 'my-container']);
  });
});

/**
 * Row 9 — defense-in-depth blockers. With argv the security boundary
 * is `execFileSync` itself, but these are policy-layer "don't even
 * ask docker to do this" rules.
 */
describe('DockerTool — argv blockers (--privileged, root mount)', () => {
  const tool = new DockerTool();

  it('blocks --privileged as its own argv element', async () => {
    const result = await tool.execute({
      action: 'run',
      args: ['--privileged', 'ubuntu', 'bash'],
    });
    assert.match(result, /--privileged flag is blocked/);
  });

  it('blocks --privileged=true', async () => {
    const result = await tool.execute({
      action: 'run',
      args: ['--privileged=true', 'ubuntu'],
    });
    assert.match(result, /--privileged flag is blocked/);
  });

  it('blocks --privileged mixed with other args', async () => {
    const result = await tool.execute({
      action: 'run',
      args: ['-d', '--name', 'test', '--privileged', 'nginx'],
    });
    assert.match(result, /--privileged flag is blocked/);
  });

  it('blocks -v /:/host root mount', async () => {
    const result = await tool.execute({
      action: 'run',
      args: ['-v', '/:/host', 'ubuntu', 'bash'],
    });
    assert.match(result, /mounting root filesystem is blocked/);
  });

  it('blocks --volume=/:/mnt root mount', async () => {
    const result = await tool.execute({
      action: 'run',
      args: ['--volume=/:/mnt', 'ubuntu'],
    });
    assert.match(result, /mounting root filesystem is blocked/);
  });

  it('does NOT block docker.sock mount (specific path mount, current behavior)', () => {
    const plan = tool.buildPlan({
      action: 'run',
      args: ['-v', '/var/run/docker.sock:/var/run/docker.sock', 'alpine'],
    });
    assert.ok(!('error' in plan), 'docker.sock mount should pass blocker layer');
  });

  it('does NOT block --net=host (current behavior)', () => {
    const plan = tool.buildPlan({
      action: 'run',
      args: ['--net=host', 'nginx'],
    });
    assert.ok(!('error' in plan), '--net=host should pass blocker layer');
  });
});

/**
 * Row 9 — cwd containment under projectRoot.
 */
describe('DockerTool — cwd containment (Row 9)', () => {
  it('rejects cwd that escapes projectRoot via ../', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row9-docker-'));
    try {
      const tool = new DockerTool(workDir);
      const plan = tool.buildPlan({
        action: 'compose_up',
        args: [],
        cwd: '../../etc',
      });
      assert.ok('error' in plan);
      if ('error' in plan) assert.match(plan.error, /cwd escapes project root/);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('rejects sibling-prefix cwd', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row9-docker-'));
    try {
      const sibling = workDir + '-evil';
      const tool = new DockerTool(workDir);
      const plan = tool.buildPlan({
        action: 'compose_up',
        cwd: sibling,
      });
      assert.ok('error' in plan, 'sibling-prefix must be rejected');
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('accepts cwd inside projectRoot', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row9-docker-'));
    const sub = path.join(workDir, 'sub');
    fs.mkdirSync(sub);
    try {
      const tool = new DockerTool(workDir);
      const plan = tool.buildPlan({
        action: 'compose_up',
        cwd: 'sub',
      });
      assert.ok(!('error' in plan));
      if ('error' in plan) return;
      assert.strictEqual(plan.cwd, sub);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});

/**
 * Real-exec canary. docker may not be installed (ENOENT) — that's fine.
 * The point is whether a LOCAL shell was spawned and interpreted the
 * payload BEFORE docker fired.
 */
describe('DockerTool — local-shell injection canary (real exec)', () => {
  let workDir: string;
  let originalCwd: string;

  before(() => {
    originalCwd = process.cwd();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row9-docker-canary-'));
    process.chdir(workDir);
  });

  after(() => {
    process.chdir(originalCwd);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('argv element with shell metacharacters does not run a local shell', async () => {
    const marker = path.join(workDir, 'PWNED_DOCKER_ARGV');
    const tool = new DockerTool(workDir);
    const payload = `$(node -e "require('fs').writeFileSync('${marker.replace(/\\/g, '\\\\')}','pwned')")`;
    await tool.execute({
      action: 'run',
      args: [payload, 'image'],
    });
    assert.strictEqual(fs.existsSync(marker), false,
      `LOCAL SHELL INJECTION REGRESSION: ${marker} was created. Tool reverted to execSync(string).`);
  });

  it('argv element with backticks does not run a local shell', async () => {
    const marker = path.join(workDir, 'PWNED_DOCKER_BACKTICK');
    const tool = new DockerTool(workDir);
    const payload = `\`node -e "require('fs').writeFileSync('${marker.replace(/\\/g, '\\\\')}','pwned')"\``;
    await tool.execute({
      action: 'inspect',
      args: [payload],
    });
    assert.strictEqual(fs.existsSync(marker), false,
      `LOCAL SHELL INJECTION REGRESSION via backticks: ${marker} was created.`);
  });
});
