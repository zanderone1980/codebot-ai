import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { SshRemoteTool } from './ssh-remote';

/**
 * SshRemoteTool tests — validates host injection blocking, input validation,
 * action routing, metadata, and error messages.
 * Tests do NOT require SSH access to any remote server.
 */

describe('SshRemoteTool — metadata', () => {
  const tool = new SshRemoteTool();

  it('has correct tool name', () => {
    assert.strictEqual(tool.name, 'ssh_remote');
  });

  it('has always-ask permission level (highest security)', () => {
    assert.strictEqual(tool.permission, 'always-ask');
  });

  it('requires action and host parameters', () => {
    const required = tool.parameters.required as string[];
    assert.ok(required.includes('action'));
    assert.ok(required.includes('host'));
  });

  it('has description mentioning SSH and SCP', () => {
    assert.ok(tool.description.includes('SSH'));
    assert.ok(tool.description.includes('SCP'));
  });
});

describe('SshRemoteTool — input validation', () => {
  const tool = new SshRemoteTool();

  it('returns error when action is missing', async () => {
    const result = await tool.execute({ host: 'example.com' });
    assert.ok(result.includes('Error: action is required'));
  });

  it('returns error when host is missing', async () => {
    const result = await tool.execute({ action: 'exec' });
    assert.ok(result.includes('Error: host is required'));
  });

  it('returns error for unknown action', async () => {
    const result = await tool.execute({ action: 'hack', host: 'example.com' });
    assert.ok(result.includes('Error: unknown action'));
    assert.ok(result.includes('hack'));
    assert.ok(result.includes('exec, upload, download'));
  });

  it('returns error when command is missing for exec action', async () => {
    const result = await tool.execute({ action: 'exec', host: 'example.com' });
    assert.ok(result.includes('Error: command is required for exec'));
  });

  it('returns error when paths are missing for upload action', async () => {
    const result = await tool.execute({
      action: 'upload',
      host: 'example.com',
    });
    assert.ok(result.includes('Error: local_path and remote_path are required'));
  });

  it('returns error when paths are missing for download action', async () => {
    const result = await tool.execute({
      action: 'download',
      host: 'example.com',
    });
    assert.ok(result.includes('Error: local_path and remote_path are required'));
  });
});

describe('SshRemoteTool — host injection blocking', () => {
  const tool = new SshRemoteTool();

  it('blocks semicolon injection in host', async () => {
    const result = await tool.execute({
      action: 'exec',
      host: 'example.com; rm -rf /',
      command: 'ls',
    });
    assert.ok(result.includes('Error: host contains invalid characters'));
    assert.ok(result.includes('injection'));
  });

  it('blocks pipe injection in host', async () => {
    const result = await tool.execute({
      action: 'exec',
      host: 'example.com | cat /etc/passwd',
      command: 'ls',
    });
    assert.ok(result.includes('Error: host contains invalid characters'));
  });

  it('blocks backtick injection in host', async () => {
    const result = await tool.execute({
      action: 'exec',
      host: 'example.com`whoami`',
      command: 'ls',
    });
    assert.ok(result.includes('Error: host contains invalid characters'));
  });

  it('blocks dollar sign injection in host', async () => {
    const result = await tool.execute({
      action: 'exec',
      host: 'example.com$(whoami)',
      command: 'ls',
    });
    assert.ok(result.includes('Error: host contains invalid characters'));
  });

  it('blocks ampersand injection in host', async () => {
    const result = await tool.execute({
      action: 'exec',
      host: 'example.com && rm -rf /',
      command: 'ls',
    });
    assert.ok(result.includes('Error: host contains invalid characters'));
  });

  it('blocks single quote injection in host', async () => {
    const result = await tool.execute({
      action: 'exec',
      host: "example.com' ; rm -rf / '",
      command: 'ls',
    });
    assert.ok(result.includes('Error: host contains invalid characters'));
  });

  it('blocks newline injection in host', async () => {
    const result = await tool.execute({
      action: 'exec',
      host: 'example.com\nrm -rf /',
      command: 'ls',
    });
    assert.ok(result.includes('Error: host contains invalid characters'));
  });

  it('allows valid hostname', async () => {
    // This will fail on SSH connection but should pass host validation
    const result = await tool.execute({
      action: 'exec',
      host: 'user@example.com',
      command: 'ls',
    });
    assert.ok(!result.includes('invalid characters'));
  });

  it('allows hostname with port-style colon', async () => {
    const result = await tool.execute({
      action: 'exec',
      host: 'user@example.com:2222',
      command: 'ls',
    });
    assert.ok(!result.includes('invalid characters'));
  });

  it('allows IP address as host', async () => {
    const result = await tool.execute({
      action: 'exec',
      host: '192.168.1.100',
      command: 'ls',
    });
    assert.ok(!result.includes('invalid characters'));
  });

  it('allows hostname with dots and hyphens', async () => {
    const result = await tool.execute({
      action: 'exec',
      host: 'my-server.internal.example.com',
      command: 'ls',
    });
    assert.ok(!result.includes('invalid characters'));
  });
});

describe('SshRemoteTool — command injection via host (regression)', () => {
  const tool = new SshRemoteTool();

  it('blocks space in host (prevents argument injection)', async () => {
    const result = await tool.execute({
      action: 'exec',
      host: '-o ProxyCommand=evil example.com',
      command: 'ls',
    });
    assert.ok(result.includes('Error: host contains invalid characters'));
  });
});

/**
 * Row 8 fix (2026-04-24): pre-fix, every action used `execSync(string)`
 * with agent-supplied `command`, `local_path`, and `remote_path`
 * concatenated raw. The `JSON.stringify(cmd)` wrapper looked like
 * quoting, but it produces double-quoted strings — and bash expands
 * `$(...)`, backticks, and `${...}` INSIDE double quotes. So:
 *
 *   command = '$(touch /tmp/pwned)'
 *   →  ssh ... "$(touch /tmp/pwned)"
 *   →  bash expands $(...) LOCALLY before ssh fires.
 *
 * Security claim of these tests:
 *   - argv-based exec removes the LOCAL shell from the loop. Hostile
 *     metacharacters in command/local_path/remote_path cannot create
 *     a marker file on the agent's machine.
 *   - The remote command (when ssh succeeds) still goes through the
 *     remote shell by SSH protocol design — that's a feature, not a
 *     bug, and not the threat model here.
 *   - `local_path` is contained under `projectRoot`. Pre-fix the agent
 *     could read /etc/shadow via download or write any path via upload.
 */

describe('SshRemoteTool — argv shape (Row 8: via buildPlan)', () => {
  it('exec: command stays as a single argv element, never interpolated', () => {
    const tool = new SshRemoteTool();
    const payload = '$(touch /tmp/should-not-happen)';
    const plan = tool.buildPlan({
      action: 'exec', host: 'alice@host', command: payload,
    });
    assert.ok(!('error' in plan));
    if ('error' in plan) return;
    assert.strictEqual(plan.command, 'ssh');
    assert.strictEqual(plan.argv[plan.argv.length - 2], 'alice@host');
    assert.strictEqual(plan.argv[plan.argv.length - 1], payload,
      'command must be the last argv element, literal');
  });

  it('exec: -p flag only added for non-default port', () => {
    const tool = new SshRemoteTool();
    const planDefault = tool.buildPlan({
      action: 'exec', host: 'h', command: 'ls',
    });
    const plan2222 = tool.buildPlan({
      action: 'exec', host: 'h', command: 'ls', port: 2222,
    });
    if ('error' in planDefault || 'error' in plan2222) {
      throw new Error('expected both to plan');
    }
    assert.ok(!planDefault.argv.includes('-p'));
    assert.ok(plan2222.argv.includes('-p'));
    assert.strictEqual(plan2222.argv[plan2222.argv.indexOf('-p') + 1], '2222');
  });

  it('port: rejects non-number (Row 8 P3-style strict typing)', () => {
    const tool = new SshRemoteTool();
    const plan = tool.buildPlan({
      action: 'exec', host: 'h', command: 'ls',
      port: '22; rm -rf ~' as unknown as number,
    });
    assert.ok('error' in plan);
    if ('error' in plan) assert.match(plan.error, /port must be an integer/);
  });

  it('port: rejects out-of-range', () => {
    const tool = new SshRemoteTool();
    const plan = tool.buildPlan({
      action: 'exec', host: 'h', command: 'ls', port: 99999,
    });
    assert.ok('error' in plan);
  });

  it('upload: local resolved absolute, host:remote stays one argv element', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row8-ssh-'));
    try {
      fs.writeFileSync(path.join(workDir, 'src.txt'), 'hi');
      const t = new SshRemoteTool(workDir);
      const plan = t.buildPlan({
        action: 'upload', host: 'h', local_path: 'src.txt', remote_path: '/dst/file',
      });
      assert.ok(!('error' in plan));
      if ('error' in plan) return;
      assert.strictEqual(plan.command, 'scp');
      assert.ok(plan.argv.includes(path.resolve(workDir, 'src.txt')),
        'local must be resolved absolute');
      assert.ok(plan.argv.includes('h:/dst/file'),
        'remote target must be one argv element of form host:remote');
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('download: argv order is (..opts.., remote, local)', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row8-ssh-'));
    try {
      const t = new SshRemoteTool(workDir);
      const plan = t.buildPlan({
        action: 'download', host: 'h', local_path: 'dst.txt', remote_path: '/src/file',
      });
      assert.ok(!('error' in plan));
      if ('error' in plan) return;
      const remoteIdx = plan.argv.findIndex(a => a === 'h:/src/file');
      const localIdx = plan.argv.findIndex(a => a === path.resolve(workDir, 'dst.txt'));
      assert.ok(remoteIdx >= 0 && localIdx >= 0 && remoteIdx < localIdx,
        'scp download argv must be (..opts.., remote, local)');
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});

describe('SshRemoteTool — local_path containment (Row 8)', () => {
  it('upload rejects local_path that escapes projectRoot', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row8-ssh-'));
    try {
      const t = new SshRemoteTool(workDir);
      const plan = t.buildPlan({
        action: 'upload', host: 'h', local_path: '../../../etc/passwd', remote_path: '/dst',
      });
      assert.ok('error' in plan);
      if ('error' in plan) assert.match(plan.error, /local_path escapes project root/);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('download rejects absolute local_path outside projectRoot', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row8-ssh-'));
    try {
      const t = new SshRemoteTool(workDir);
      const escapeTarget = process.platform === 'win32' ? 'C:\\Windows\\evil.txt' : '/etc/cron.d/evil';
      const plan = t.buildPlan({
        action: 'download', host: 'h', local_path: escapeTarget, remote_path: '/src',
      });
      assert.ok('error' in plan);
      if ('error' in plan) assert.match(plan.error, /local_path escapes project root/);
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });

  it('upload: sibling-prefix local_path rejected (not true containment)', () => {
    const workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row8-ssh-'));
    try {
      const sibling = workDir + '-evil'; // shares prefix but is a different dir
      const t = new SshRemoteTool(workDir);
      const plan = t.buildPlan({
        action: 'upload', host: 'h', local_path: sibling, remote_path: '/dst',
      });
      assert.ok('error' in plan, 'sibling-prefix must be rejected');
    } finally {
      fs.rmSync(workDir, { recursive: true, force: true });
    }
  });
});

/**
 * Real-exec canaries. ssh/scp will fail (ENOENT, dns-error, auth-error)
 * — that's fine. We only care whether a LOCAL shell was spawned and
 * interpreted the metacharacters before that. If a future refactor
 * reverts to `execSync(string)`, the marker file appears.
 */
describe('SshRemoteTool — local-shell injection canaries (real exec)', () => {
  let workDir: string;
  let originalCwd: string;

  before(() => {
    originalCwd = process.cwd();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row8-ssh-canary-'));
    process.chdir(workDir);
  });

  after(() => {
    process.chdir(originalCwd);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('exec: $(...) in command does not run locally', async () => {
    const marker = path.join(workDir, 'PWNED_SSH_EXEC');
    const tool = new SshRemoteTool(workDir);
    const payload = `$(node -e "require('fs').writeFileSync('${marker.replace(/\\/g, '\\\\')}','pwned')")`;
    await tool.execute({
      action: 'exec',
      host: '127.0.0.1',
      port: 1,
      command: payload,
    });
    assert.strictEqual(fs.existsSync(marker), false,
      `LOCAL SHELL INJECTION REGRESSION: ${marker} was created via command. Tool reverted to execSync(string).`);
  });

  it('exec: backticks in command do not run locally', async () => {
    const marker = path.join(workDir, 'PWNED_SSH_BACKTICK');
    const tool = new SshRemoteTool(workDir);
    const payload = `\`node -e "require('fs').writeFileSync('${marker.replace(/\\/g, '\\\\')}','pwned')"\``;
    await tool.execute({
      action: 'exec',
      host: '127.0.0.1',
      port: 1,
      command: payload,
    });
    assert.strictEqual(fs.existsSync(marker), false,
      `LOCAL SHELL INJECTION REGRESSION via backticks: ${marker} was created.`);
  });

  it('upload: shell metacharacters in remote_path do not run locally', async () => {
    const marker = path.join(workDir, 'PWNED_SCP_REMOTE');
    fs.writeFileSync(path.join(workDir, 'src.txt'), 'hi');
    const tool = new SshRemoteTool(workDir);
    const evilRemote = `/dst"; node -e "require('fs').writeFileSync('${marker.replace(/\\/g, '\\\\')}','pwned')" #`;
    await tool.execute({
      action: 'upload',
      host: '127.0.0.1',
      port: 1,
      local_path: 'src.txt',
      remote_path: evilRemote,
    });
    assert.strictEqual(fs.existsSync(marker), false,
      `LOCAL SHELL INJECTION REGRESSION via remote_path: ${marker} was created.`);
  });

  it('download: shell metacharacters in remote_path do not run locally', async () => {
    const marker = path.join(workDir, 'PWNED_SCP_DOWNLOAD');
    const tool = new SshRemoteTool(workDir);
    const evilRemote = `/src"; node -e "require('fs').writeFileSync('${marker.replace(/\\/g, '\\\\')}','pwned')" #`;
    await tool.execute({
      action: 'download',
      host: '127.0.0.1',
      port: 1,
      local_path: 'dst.txt',
      remote_path: evilRemote,
    });
    assert.strictEqual(fs.existsSync(marker), false,
      `LOCAL SHELL INJECTION REGRESSION via download remote_path: ${marker} was created.`);
  });
});
