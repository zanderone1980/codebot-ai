import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { runDoctor, formatDoctorReport } from './doctor';

describe('doctor', () => {
  it('runDoctor returns a valid DoctorReport', async () => {
    const report = await runDoctor();
    assert.ok(Array.isArray(report.checks), 'checks should be an array');
    assert.ok(report.checks.length >= 10, `Should have 10+ checks, got ${report.checks.length}`);
    assert.strictEqual(typeof report.passed, 'number');
    assert.strictEqual(typeof report.warned, 'number');
    assert.strictEqual(typeof report.failed, 'number');
    assert.strictEqual(report.passed + report.warned + report.failed, report.checks.length);
  });

  it('each check has required fields', async () => {
    const report = await runDoctor();
    for (const check of report.checks) {
      assert.strictEqual(typeof check.name, 'string', `Check name should be string: ${JSON.stringify(check)}`);
      assert.ok(['pass', 'warn', 'fail'].includes(check.status), `Invalid status: ${check.status}`);
      assert.strictEqual(typeof check.message, 'string', `Check message should be string: ${check.name}`);
    }
  });

  it('nodeVersion check passes on supported Node', async () => {
    const report = await runDoctor();
    const nodeCheck = report.checks.find(c => c.name === 'nodeVersion');
    assert.ok(nodeCheck, 'nodeVersion check should exist');
    assert.strictEqual(nodeCheck!.status, 'pass', `Node ${process.version} should pass`);
  });

  it('gitAvailable check returns pass or warn', async () => {
    const report = await runDoctor();
    const gitCheck = report.checks.find(c => c.name === 'gitAvailable');
    assert.ok(gitCheck, 'gitAvailable check should exist');
    assert.ok(['pass', 'warn'].includes(gitCheck!.status));
  });

  it('configExists check returns valid status', async () => {
    const report = await runDoctor();
    const configCheck = report.checks.find(c => c.name === 'configExists');
    assert.ok(configCheck, 'configExists check should exist');
    assert.ok(['pass', 'warn', 'fail'].includes(configCheck!.status));
  });

  it('cloudApiKeys check returns valid status', async () => {
    const report = await runDoctor();
    const keysCheck = report.checks.find(c => c.name === 'cloudApiKeys');
    assert.ok(keysCheck, 'cloudApiKeys check should exist');
    assert.ok(['pass', 'warn'].includes(keysCheck!.status));
  });

  it('diskSpace check returns valid status', async () => {
    const report = await runDoctor();
    const diskCheck = report.checks.find(c => c.name === 'diskSpace');
    assert.ok(diskCheck, 'diskSpace check should exist');
    assert.ok(['pass', 'warn', 'fail'].includes(diskCheck!.status));
  });

  it('sessionsDir check returns valid status', async () => {
    const report = await runDoctor();
    const sessionsCheck = report.checks.find(c => c.name === 'sessionsDir');
    assert.ok(sessionsCheck, 'sessionsDir check should exist');
    assert.ok(['pass', 'warn', 'fail'].includes(sessionsCheck!.status));
  });

  it('auditIntegrity check does not crash', async () => {
    const report = await runDoctor();
    const auditCheck = report.checks.find(c => c.name === 'auditIntegrity');
    assert.ok(auditCheck, 'auditIntegrity check should exist');
    assert.ok(['pass', 'warn', 'fail'].includes(auditCheck!.status));
  });

  it('doctor never throws', async () => {
    // Should complete without throwing even in unusual environments
    const report = await runDoctor();
    assert.ok(report, 'Should return a report');
  });

  it('formatDoctorReport returns a string', async () => {
    const report = await runDoctor();
    const formatted = formatDoctorReport(report);
    assert.strictEqual(typeof formatted, 'string');
    assert.ok(formatted.length > 0, 'Formatted report should not be empty');
    assert.ok(formatted.includes('CodeBot Doctor'), 'Should include title');
  });

  it('formatDoctorReport includes pass/warn/fail counts', async () => {
    const report = await runDoctor();
    const formatted = formatDoctorReport(report);
    assert.ok(formatted.includes('passed'), 'Should include passed count');
  });
});
