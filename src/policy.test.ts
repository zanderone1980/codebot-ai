import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { PolicyEnforcer, DEFAULT_POLICY, loadPolicy, generateDefaultPolicyFile } from './policy';

describe('PolicyEnforcer — tool access', () => {
  it('allows all tools by default', () => {
    const enforcer = new PolicyEnforcer(DEFAULT_POLICY);
    assert.deepStrictEqual(enforcer.isToolAllowed('execute'), { allowed: true });
    assert.deepStrictEqual(enforcer.isToolAllowed('write_file'), { allowed: true });
    assert.deepStrictEqual(enforcer.isToolAllowed('browser'), { allowed: true });
  });

  it('blocks tools in disabled list', () => {
    const policy = { ...DEFAULT_POLICY, tools: { disabled: ['browser', 'ssh_remote'], enabled: [], permissions: {} } };
    const enforcer = new PolicyEnforcer(policy);
    assert.strictEqual(enforcer.isToolAllowed('browser').allowed, false);
    assert.strictEqual(enforcer.isToolAllowed('ssh_remote').allowed, false);
    assert.strictEqual(enforcer.isToolAllowed('execute').allowed, true);
  });

  it('only allows tools in enabled list when specified', () => {
    const policy = { ...DEFAULT_POLICY, tools: { enabled: ['read_file', 'grep'], disabled: [], permissions: {} } };
    const enforcer = new PolicyEnforcer(policy);
    assert.strictEqual(enforcer.isToolAllowed('read_file').allowed, true);
    assert.strictEqual(enforcer.isToolAllowed('grep').allowed, true);
    assert.strictEqual(enforcer.isToolAllowed('execute').allowed, false);
    assert.strictEqual(enforcer.isToolAllowed('browser').allowed, false);
  });

  it('returns correct permission overrides', () => {
    const policy = { ...DEFAULT_POLICY, tools: { enabled: [], disabled: [], permissions: { execute: 'auto' as const, write_file: 'always-ask' as const } } };
    const enforcer = new PolicyEnforcer(policy);
    assert.strictEqual(enforcer.getToolPermission('execute'), 'auto');
    assert.strictEqual(enforcer.getToolPermission('write_file'), 'always-ask');
    assert.strictEqual(enforcer.getToolPermission('read_file'), null);
  });
});

describe('PolicyEnforcer — filesystem', () => {
  it('blocks denied paths', () => {
    const policy = { ...DEFAULT_POLICY, filesystem: { denied_paths: ['.env', '.env.local'], writable_paths: [], read_only_paths: [], allow_outside_project: false } };
    const enforcer = new PolicyEnforcer(policy, '/project');
    assert.strictEqual(enforcer.isPathWritable('/project/.env').allowed, false);
    assert.strictEqual(enforcer.isPathWritable('/project/.env.local').allowed, false);
    assert.strictEqual(enforcer.isPathWritable('/project/src/index.ts').allowed, true);
  });

  it('enforces read-only paths', () => {
    const policy = { ...DEFAULT_POLICY, filesystem: { read_only_paths: ['./config'], denied_paths: [], writable_paths: [], allow_outside_project: false } };
    const enforcer = new PolicyEnforcer(policy, '/project');
    assert.strictEqual(enforcer.isPathWritable('/project/config/app.json').allowed, false);
    assert.strictEqual(enforcer.isPathWritable('/project/src/index.ts').allowed, true);
  });

  it('restricts to writable paths when specified', () => {
    const policy = { ...DEFAULT_POLICY, filesystem: { writable_paths: ['./src', './tests'], read_only_paths: [], denied_paths: [], allow_outside_project: false } };
    const enforcer = new PolicyEnforcer(policy, '/project');
    assert.strictEqual(enforcer.isPathWritable('/project/src/index.ts').allowed, true);
    assert.strictEqual(enforcer.isPathWritable('/project/tests/foo.test.ts').allowed, true);
    assert.strictEqual(enforcer.isPathWritable('/project/docs/readme.md').allowed, false);
  });
});

describe('PolicyEnforcer — execution', () => {
  it('returns default sandbox mode', () => {
    const enforcer = new PolicyEnforcer(DEFAULT_POLICY);
    assert.strictEqual(enforcer.getSandboxMode(), 'auto');
  });

  it('returns configured sandbox mode', () => {
    const policy = { ...DEFAULT_POLICY, execution: { sandbox: 'docker' as const } };
    const enforcer = new PolicyEnforcer(policy);
    assert.strictEqual(enforcer.getSandboxMode(), 'docker');
  });

  it('returns network policy', () => {
    const policyNoNet = { ...DEFAULT_POLICY, execution: { network: false } };
    const enforcerNoNet = new PolicyEnforcer(policyNoNet);
    assert.strictEqual(enforcerNoNet.isNetworkAllowed(), false);

    const enforcerDefault = new PolicyEnforcer(DEFAULT_POLICY);
    assert.strictEqual(enforcerDefault.isNetworkAllowed(), true);
  });

  it('returns timeout in ms', () => {
    const policy = { ...DEFAULT_POLICY, execution: { timeout_seconds: 60 } };
    const enforcer = new PolicyEnforcer(policy);
    assert.strictEqual(enforcer.getTimeoutMs(), 60000);
  });
});

describe('PolicyEnforcer — git', () => {
  it('defaults to not always branching', () => {
    const enforcer = new PolicyEnforcer(DEFAULT_POLICY);
    assert.strictEqual(enforcer.shouldAlwaysBranch(), false);
  });

  it('respects always_branch setting', () => {
    const policy = { ...DEFAULT_POLICY, git: { always_branch: true, branch_prefix: 'cb/', never_push_main: true, require_tests_before_commit: false } };
    const enforcer = new PolicyEnforcer(policy);
    assert.strictEqual(enforcer.shouldAlwaysBranch(), true);
    assert.strictEqual(enforcer.getBranchPrefix(), 'cb/');
  });

  it('blocks main push by default', () => {
    const enforcer = new PolicyEnforcer(DEFAULT_POLICY);
    assert.strictEqual(enforcer.isMainPushBlocked(), true);
  });
});

describe('PolicyEnforcer — secrets', () => {
  it('does not block secrets by default', () => {
    const enforcer = new PolicyEnforcer(DEFAULT_POLICY);
    assert.strictEqual(enforcer.shouldBlockSecrets(), false);
  });

  it('scans secrets by default', () => {
    const enforcer = new PolicyEnforcer(DEFAULT_POLICY);
    assert.strictEqual(enforcer.shouldScanSecrets(), true);
  });

  it('respects block_on_detect', () => {
    const policy = { ...DEFAULT_POLICY, secrets: { block_on_detect: true, scan_on_write: true } };
    const enforcer = new PolicyEnforcer(policy);
    assert.strictEqual(enforcer.shouldBlockSecrets(), true);
  });
});

describe('PolicyEnforcer — MCP', () => {
  it('allows all MCP servers by default', () => {
    const enforcer = new PolicyEnforcer(DEFAULT_POLICY);
    assert.strictEqual(enforcer.isMcpServerAllowed('anything').allowed, true);
  });

  it('blocks servers in blocked list', () => {
    const policy = { ...DEFAULT_POLICY, mcp: { blocked_servers: ['risky-server'], allowed_servers: [] } };
    const enforcer = new PolicyEnforcer(policy);
    assert.strictEqual(enforcer.isMcpServerAllowed('risky-server').allowed, false);
    assert.strictEqual(enforcer.isMcpServerAllowed('safe-server').allowed, true);
  });

  it('restricts to allowed list when specified', () => {
    const policy = { ...DEFAULT_POLICY, mcp: { allowed_servers: ['filesystem', 'github'], blocked_servers: [] } };
    const enforcer = new PolicyEnforcer(policy);
    assert.strictEqual(enforcer.isMcpServerAllowed('filesystem').allowed, true);
    assert.strictEqual(enforcer.isMcpServerAllowed('github').allowed, true);
    assert.strictEqual(enforcer.isMcpServerAllowed('unknown').allowed, false);
  });
});

describe('PolicyEnforcer — limits', () => {
  it('returns default limits', () => {
    const enforcer = new PolicyEnforcer(DEFAULT_POLICY);
    assert.strictEqual(enforcer.getMaxIterations(), 50);
    assert.strictEqual(enforcer.getMaxFileSizeBytes(), 500 * 1024);
    assert.strictEqual(enforcer.getCostLimitUsd(), 0);
  });

  it('returns configured limits', () => {
    const policy = { ...DEFAULT_POLICY, limits: { max_iterations: 10, max_file_size_kb: 100, cost_limit_usd: 1.50 } };
    const enforcer = new PolicyEnforcer(policy);
    assert.strictEqual(enforcer.getMaxIterations(), 10);
    assert.strictEqual(enforcer.getMaxFileSizeBytes(), 100 * 1024);
    assert.strictEqual(enforcer.getCostLimitUsd(), 1.50);
  });
});

describe('loadPolicy', () => {
  const testDir = path.join(os.homedir(), '.codebot', `test-policy-${Date.now()}`);

  beforeEach(() => {
    fs.mkdirSync(path.join(testDir, '.codebot'), { recursive: true });
  });

  afterEach(() => {
    try { fs.rmSync(testDir, { recursive: true, force: true }); } catch { /* ok */ }
  });

  it('returns defaults when no policy files exist', () => {
    const policy = loadPolicy(testDir);
    assert.strictEqual(policy.version, '1.0');
    assert.strictEqual(policy.execution?.sandbox, 'auto');
  });

  it('loads project policy file', () => {
    const policyContent = JSON.stringify({ version: '1.0', limits: { max_iterations: 5 } });
    fs.writeFileSync(path.join(testDir, '.codebot', 'policy.json'), policyContent);
    const policy = loadPolicy(testDir);
    assert.strictEqual(policy.limits?.max_iterations, 5);
  });
});

describe('generateDefaultPolicyFile', () => {
  it('generates valid JSON', () => {
    const content = generateDefaultPolicyFile();
    const parsed = JSON.parse(content);
    assert.strictEqual(parsed.version, '1.0');
    assert.ok(parsed.execution);
    assert.ok(parsed.filesystem);
    assert.ok(parsed.tools);
  });
});
