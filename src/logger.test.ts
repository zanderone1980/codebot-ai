import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import { log, setLogLevel, getLogLevel, refreshLogLevel } from './logger';

/**
 * These tests capture the logger's core contract:
 *   - default level is `warn` (preserves pre-logger behavior)
 *   - CODEBOT_LOG_LEVEL env var controls it
 *   - `silent` kills everything including errors
 *   - higher levels emit lower-level messages too
 */
describe('logger', () => {
  let origEnv: string | undefined;
  let calls: { stream: 'stdout' | 'stderr'; args: unknown[] }[] = [];
  const origWarn = console.warn;
  const origError = console.error;

  beforeEach(() => {
    origEnv = process.env.CODEBOT_LOG_LEVEL;
    calls = [];
    console.warn = (...args: unknown[]) => { calls.push({ stream: 'stderr', args }); };
    console.error = (...args: unknown[]) => { calls.push({ stream: 'stderr', args }); };
  });

  afterEach(() => {
    console.warn = origWarn;
    console.error = origError;
    if (origEnv === undefined) delete process.env.CODEBOT_LOG_LEVEL;
    else process.env.CODEBOT_LOG_LEVEL = origEnv;
    refreshLogLevel();
  });

  it('default level is warn (warns emit, debug/info do not)', () => {
    setLogLevel('warn');
    log.warn('W');
    log.error('E');
    log.info('I');
    log.debug('D');
    const msgs = calls.map(c => c.args[0]);
    assert.ok(msgs.includes('W'), 'warn should emit at warn level');
    assert.ok(msgs.includes('E'), 'error should emit at warn level');
    assert.ok(!msgs.includes('I'), 'info should NOT emit at warn level');
    assert.ok(!msgs.includes('D'), 'debug should NOT emit at warn level');
  });

  it('silent suppresses everything including errors', () => {
    setLogLevel('silent');
    log.error('E');
    log.warn('W');
    log.info('I');
    log.debug('D');
    assert.strictEqual(calls.length, 0);
  });

  it('error level allows errors but not warns', () => {
    setLogLevel('error');
    log.error('E');
    log.warn('W');
    const msgs = calls.map(c => c.args[0]);
    assert.ok(msgs.includes('E'));
    assert.ok(!msgs.includes('W'));
  });

  it('debug level is the firehose — all 4 emit', () => {
    setLogLevel('debug');
    log.error('E'); log.warn('W'); log.info('I'); log.debug('D');
    const msgs = calls.flatMap(c => c.args);
    assert.ok(msgs.includes('E'));
    assert.ok(msgs.includes('W'));
    assert.ok(msgs.includes('I'));
    assert.ok(msgs.includes('D'));
  });

  it('refreshLogLevel re-reads CODEBOT_LOG_LEVEL', () => {
    process.env.CODEBOT_LOG_LEVEL = 'silent';
    refreshLogLevel();
    assert.strictEqual(getLogLevel(), 'silent');

    process.env.CODEBOT_LOG_LEVEL = 'debug';
    refreshLogLevel();
    assert.strictEqual(getLogLevel(), 'debug');
  });

  it('invalid CODEBOT_LOG_LEVEL falls back to default warn', () => {
    process.env.CODEBOT_LOG_LEVEL = 'bogus-value';
    refreshLogLevel();
    assert.strictEqual(getLogLevel(), 'warn');
  });

  it('info prefixes messages with [CodeBot]', () => {
    setLogLevel('info');
    log.info('hello');
    const lastCall = calls[calls.length - 1];
    assert.strictEqual(lastCall.args[0], '[CodeBot]');
    assert.strictEqual(lastCall.args[1], 'hello');
  });

  it('debug prefixes messages with [CodeBot:debug]', () => {
    setLogLevel('debug');
    log.debug('trace');
    const lastCall = calls[calls.length - 1];
    assert.strictEqual(lastCall.args[0], '[CodeBot:debug]');
    assert.strictEqual(lastCall.args[1], 'trace');
  });
});
