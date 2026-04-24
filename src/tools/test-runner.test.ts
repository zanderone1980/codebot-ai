import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { TestRunnerTool } from './test-runner';

/**
 * TestRunnerTool — injection and containment tests.
 *
 * Row 10 fix (2026-04-24): `runTests` used to assemble the framework
 * command by string concatenation and hand it to `execSync`, which
 * invokes `sh -c <cmd>` on Unix and `cmd.exe /d /s /c <cmd>` on Windows.
 * Agent-supplied `filter` and `path` went through raw, so
 *   `filter = '" && touch <marker> #'`
 * would execute the `touch` branch. These tests pin the argv-based fix
 * in place and fail loudly if anyone ever reverts to string interpolation.
 */

describe('TestRunnerTool — metadata', () => {
  const tool = new TestRunnerTool();

  it('has the expected tool name', () => {
    assert.strictEqual(tool.name, 'test_runner');
  });

  it('gates runs behind a user prompt', () => {
    assert.strictEqual(tool.permission, 'prompt');
  });
});

describe('TestRunnerTool — cwd containment', () => {
  const tool = new TestRunnerTool();

  it('rejects cwd that resolves outside the process root', async () => {
    // Use the real filesystem root — guaranteed outside process.cwd().
    const escapeTarget = process.platform === 'win32' ? 'C:\\' : '/etc';
    const result = await tool.execute({ action: 'detect', cwd: escapeTarget });
    assert.ok(
      result.startsWith('Error: cwd escapes project root'),
      `expected rejection, got: ${result}`,
    );
  });

  it('rejects parent-traversal cwd via ../', async () => {
    const result = await tool.execute({ action: 'detect', cwd: '../..' });
    assert.ok(
      result.startsWith('Error: cwd escapes project root'),
      `expected rejection, got: ${result}`,
    );
  });

  it('accepts cwd that resolves inside the process root', async () => {
    // process.cwd() itself is trivially inside process.cwd().
    const result = await tool.execute({ action: 'detect', cwd: process.cwd() });
    assert.ok(
      !result.startsWith('Error: cwd escapes project root'),
      `expected accept, got: ${result}`,
    );
  });
});

/**
 * Real integration test. We build a tiny fake jest project in an
 * isolated tmpdir, drive the tool with a filter that would spawn a
 * subprocess if — and only if — the shell interpreted it. Then we
 * assert the marker file never materialized.
 *
 * This is the canary. If a future refactor re-introduces string
 * interpolation, this test starts failing: the marker appears.
 */
describe('TestRunnerTool — shell-injection canary (real exec)', () => {
  let workDir: string;
  let originalCwd: string;
  let markerPath: string;

  before(() => {
    originalCwd = process.cwd();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row10-'));
    markerPath = path.join(workDir, 'PWNED');

    // Fake jest project. Script is the classifier — detect() will see
    // `jest` in scripts.test and pick the safe argv {command:'npx', args:['jest']}.
    fs.writeFileSync(
      path.join(workDir, 'package.json'),
      JSON.stringify({ name: 'row10-canary', scripts: { test: 'jest' } }, null, 2),
    );

    // Process cwd must be INSIDE or EQUAL to the workDir for cwd
    // containment to accept it. We chdir in for the duration of the test.
    process.chdir(workDir);
  });

  after(() => {
    process.chdir(originalCwd);
    // Best-effort cleanup.
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('does not execute shell metacharacters in filter (the Row 10 bug)', async () => {
    const tool = new TestRunnerTool();
    const maliciousFilter = `" && node -e "require('fs').writeFileSync('${markerPath.replace(/\\/g, '\\\\')}', 'pwned')" #`;

    // The tool WILL try to run `npx jest -t <filter>`, which will almost
    // certainly fail (no jest installed in the tmpdir, no tests, etc.).
    // We don't care — we care whether the shell interpreted the filter.
    await tool.execute({ action: 'run', cwd: workDir, filter: maliciousFilter });

    // The canary: if interpolation happened, the `node -e` branch ran and
    // created the marker. If argv isolation is intact, jest just sees the
    // filter as a literal test-name pattern and the marker never exists.
    assert.strictEqual(
      fs.existsSync(markerPath),
      false,
      `SHELL INJECTION REGRESSION: marker ${markerPath} was created, meaning the filter was interpreted by a shell. The tool is back to concatenating into execSync.`,
    );
  });

  it('does not execute shell metacharacters in path (target)', async () => {
    const tool = new TestRunnerTool();
    const marker2 = path.join(workDir, 'PWNED2');
    const maliciousPath = `some/test.js; node -e "require('fs').writeFileSync('${marker2.replace(/\\/g, '\\\\')}', 'pwned')"`;

    await tool.execute({ action: 'run', cwd: workDir, path: maliciousPath });

    assert.strictEqual(
      fs.existsSync(marker2),
      false,
      `SHELL INJECTION REGRESSION: marker ${marker2} was created via path arg.`,
    );
  });
});

/**
 * Argv-shape tests. We call `buildCommand()` directly — it returns the
 * planned (command, argv) without executing — and pin the contract. If
 * anyone reverts to string interpolation or re-introduces raw
 * `pkg.scripts.test` copying, these fail loudly.
 *
 * We don't stub execFileSync (child_process exports are read-only getters
 * in modern Node, and the tool holds a direct reference from its own
 * import anyway). buildCommand() is the seam.
 */
describe('TestRunnerTool — argv shape (via buildCommand)', () => {
  let workDir: string;

  before(() => {
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row10-argv-'));
    fs.writeFileSync(
      path.join(workDir, 'package.json'),
      JSON.stringify({ name: 'row10-argv', scripts: { test: 'jest' } }, null, 2),
    );
  });

  after(() => {
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('passes filter as a single argv element, never interpolated', () => {
    const tool = new TestRunnerTool();
    const payload = '" && touch /tmp/should-not-happen #';
    const plan = tool.buildCommand(workDir, { action: 'run', filter: payload });

    assert.ok(!('error' in plan), `expected plan, got error: ${'error' in plan ? plan.error : ''}`);
    if ('error' in plan) return;

    assert.strictEqual(plan.command, 'npx');
    assert.deepStrictEqual(plan.argv, ['jest', '-t', payload]);
    // No element in argv should be a pre-quoted shell fragment.
    assert.ok(
      !plan.argv.some((a) => a.includes('-t "')),
      'filter must be its own argv element, not pre-quoted into a single string',
    );
  });

  it('passes target as a single argv element, resolved absolute, contained to cwd', () => {
    const tool = new TestRunnerTool();
    const plan = tool.buildCommand(workDir, { action: 'run', path: 'some/test.js' });

    assert.ok(!('error' in plan));
    if ('error' in plan) return;
    assert.strictEqual(plan.command, 'npx');
    assert.strictEqual(plan.argv[0], 'jest');
    assert.strictEqual(plan.argv[1], path.resolve(workDir, 'some/test.js'));
  });

  it('rejects target that resolves outside cwd (no exec planned)', () => {
    const tool = new TestRunnerTool();
    const plan = tool.buildCommand(workDir, { action: 'run', path: '../../../etc/passwd' });

    assert.ok('error' in plan);
    if ('error' in plan) {
      assert.ok(plan.error.startsWith('Error: test path escapes cwd'));
    }
  });

  it('rejects target that is a sibling-prefix of cwd (not true containment)', () => {
    // Classic startsWith bug: /tmp/foo vs /tmp/foobar. path.relative catches
    // it; startsWith(root + sep) would too, but startsWith(root) alone would not.
    const tool = new TestRunnerTool();
    const sibling = workDir + '-evil'; // same prefix, different directory
    const plan = tool.buildCommand(workDir, { action: 'run', path: sibling });

    assert.ok('error' in plan, 'sibling-prefix target must be rejected');
    if ('error' in plan) {
      assert.ok(plan.error.startsWith('Error: test path escapes cwd'));
    }
  });

  it('never copies pkg.scripts.test verbatim into argv (malicious script fixture)', () => {
    // Rewrite package.json with a malicious script. detect() uses
    // scripts.test only as a classifier. The hardcoded argv table must
    // still be what actually runs — the raw string must NOT appear.
    const malWorkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row10-mal-'));
    try {
      fs.writeFileSync(
        path.join(malWorkDir, 'package.json'),
        JSON.stringify({
          name: 'row10-malicious',
          scripts: { test: 'node --test && rm -rf ~' },
        }, null, 2),
      );

      const tool = new TestRunnerTool();
      const plan = tool.buildCommand(malWorkDir, { action: 'run' });

      assert.ok(!('error' in plan), 'expected a plan, not an error');
      if ('error' in plan) return;

      const flat = [plan.command, ...plan.argv].join(' ');
      assert.ok(!flat.includes('rm -rf'), `argv must not contain raw scripts.test fragments — got: ${flat}`);
      assert.ok(!flat.includes('&&'), `argv must not contain shell operators from scripts.test — got: ${flat}`);
      // The classifier saw 'node --test' and should have picked node:test,
      // which we execute via ['npm', ['test']] — npm is the binary, not our
      // shell. Confirm the shape.
      assert.strictEqual(plan.command, 'npm');
      assert.deepStrictEqual(plan.argv, ['test']);
    } finally {
      try { fs.rmSync(malWorkDir, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  });
});
