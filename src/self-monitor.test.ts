import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import {
  SelfMonitor,
  BuildHealthCheck,
  TestHealthCheck,
  DiskSpaceCheck,
  APIHealthCheck,
  MemoryUsageCheck,
  HealthReport,
} from './self-monitor';

describe('SelfMonitor', () => {
  const tmpDir = path.join(os.tmpdir(), 'codebot-health-test-' + Date.now());

  before(() => {
    process.env.CODEBOT_HOME = tmpDir;
    fs.mkdirSync(path.join(tmpDir, 'health'), { recursive: true });
  });

  after(() => {
    delete process.env.CODEBOT_HOME;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('runAll returns a health report', () => {
    const monitor = new SelfMonitor();
    const report = monitor.runAll();

    assert.ok(report.overall);
    assert.ok(Array.isArray(report.checks));
    assert.ok(Array.isArray(report.fixActions));
    assert.ok(report.timestamp);
  });

  it('report has valid overall status', () => {
    const monitor = new SelfMonitor();
    const report = monitor.runAll();

    assert.ok(['healthy', 'degraded', 'critical'].includes(report.overall));
  });

  it('each check has required fields', () => {
    const monitor = new SelfMonitor();
    const report = monitor.runAll();

    for (const check of report.checks) {
      assert.ok(check.name);
      assert.ok(check.status);
      assert.ok(check.message);
      assert.ok(check.checkedAt);
    }
  });

  it('formatReport produces readable output', () => {
    const monitor = new SelfMonitor();
    const report = monitor.runAll();
    const formatted = SelfMonitor.formatReport(report);

    assert.ok(formatted.includes('Health:'));
    assert.ok(typeof formatted === 'string');
  });

  it('getHistory returns accumulated reports', () => {
    const monitor = new SelfMonitor();
    monitor.runAll();
    monitor.runAll();
    const history = monitor.getHistory();
    // First runAll sets lastRun, second may skip due to intervals
    assert.ok(history.length >= 1);
  });

  it('recordTestResult persists to disk', () => {
    const monitor = new SelfMonitor();
    monitor.recordTestResult(100, 3);

    const resultFile = path.join(tmpDir, 'health', 'last-test-result.json');
    assert.ok(fs.existsSync(resultFile));

    const data = JSON.parse(fs.readFileSync(resultFile, 'utf-8'));
    assert.strictEqual(data.total, 100);
    assert.strictEqual(data.failures, 3);
  });
});

describe('BuildHealthCheck', () => {
  it('returns healthy when no src/dist dirs exist', () => {
    const check = new BuildHealthCheck('/nonexistent/path');
    const result = check.check();
    assert.strictEqual(result.name, 'build');
    assert.strictEqual(result.status, 'healthy');
  });
});

describe('TestHealthCheck', () => {
  const tmpDir = path.join(os.tmpdir(), 'codebot-test-health-' + Date.now());

  before(() => {
    process.env.CODEBOT_HOME = tmpDir;
    fs.mkdirSync(path.join(tmpDir, 'health'), { recursive: true });
  });

  after(() => {
    delete process.env.CODEBOT_HOME;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns healthy with no cached results', () => {
    const check = new TestHealthCheck();
    const result = check.check();
    assert.strictEqual(result.status, 'healthy');
  });

  it('returns degraded when tests are failing', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'health', 'last-test-result.json'),
      JSON.stringify({ total: 50, failures: 3 }),
    );
    const check = new TestHealthCheck();
    const result = check.check();
    assert.strictEqual(result.status, 'degraded');
    assert.ok(result.message.includes('3'));
    assert.ok(result.fixAction);
  });

  it('returns healthy when all tests pass', () => {
    fs.writeFileSync(
      path.join(tmpDir, 'health', 'last-test-result.json'),
      JSON.stringify({ total: 50, failures: 0 }),
    );
    const check = new TestHealthCheck();
    const result = check.check();
    assert.strictEqual(result.status, 'healthy');
    assert.ok(result.message.includes('50'));
  });
});

describe('DiskSpaceCheck', () => {
  it('returns a valid result', () => {
    const check = new DiskSpaceCheck();
    const result = check.check();
    assert.strictEqual(result.name, 'disk_space');
    assert.ok(['healthy', 'degraded', 'critical'].includes(result.status));
  });
});

describe('APIHealthCheck', () => {
  const tmpDir = path.join(os.tmpdir(), 'codebot-api-health-' + Date.now());

  before(() => {
    process.env.CODEBOT_HOME = tmpDir;
    fs.mkdirSync(path.join(tmpDir, 'health'), { recursive: true });
  });

  after(() => {
    delete process.env.CODEBOT_HOME;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('returns healthy with no errors', () => {
    const check = new APIHealthCheck();
    const result = check.check();
    assert.strictEqual(result.status, 'healthy');
  });

  it('recordError writes to disk', () => {
    const check = new APIHealthCheck();
    check.recordError('Connection refused');
    check.recordError('Timeout');

    const errorFile = path.join(tmpDir, 'health', 'api-errors.json');
    assert.ok(fs.existsSync(errorFile));

    const errors = JSON.parse(fs.readFileSync(errorFile, 'utf-8'));
    assert.strictEqual(errors.length, 2);
  });

  it('detects degraded state with recent errors', () => {
    const check = new APIHealthCheck();
    // Write recent errors
    const errors = Array.from({ length: 3 }, (_, i) => ({
      timestamp: new Date().toISOString(),
      error: `Error ${i}`,
    }));
    fs.writeFileSync(
      path.join(tmpDir, 'health', 'api-errors.json'),
      JSON.stringify(errors),
    );

    const result = check.check();
    assert.ok(['degraded', 'critical'].includes(result.status));
  });
});

describe('MemoryUsageCheck', () => {
  it('returns a valid result with memory stats', () => {
    const check = new MemoryUsageCheck();
    const result = check.check();
    assert.strictEqual(result.name, 'memory');
    assert.ok(result.message.includes('MB'));
    assert.ok(['healthy', 'degraded', 'critical'].includes(result.status));
  });
});
