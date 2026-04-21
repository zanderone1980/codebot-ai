import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as os from 'os';
import * as path from 'path';
import { isPathSafe, isCwdSafe } from './security';

const HOME = os.homedir();
const PROJECT = path.join(HOME, 'projects', 'my-app');

describe('isPathSafe', () => {
  it('blocks writes to /etc/passwd', () => {
    const result = isPathSafe('/etc/passwd', PROJECT);
    assert.strictEqual(result.safe, false);
    assert.ok(result.reason?.includes('etc'), `Reason should mention etc: ${result.reason}`);
  });

  it('blocks writes to /etc/shadow', () => {
    const result = isPathSafe('/etc/shadow', PROJECT);
    assert.strictEqual(result.safe, false);
  });

  it('blocks writes to /usr/bin/', () => {
    const result = isPathSafe('/usr/bin/malicious', PROJECT);
    assert.strictEqual(result.safe, false);
  });

  it('blocks writes to ~/.ssh/', () => {
    const result = isPathSafe(path.join(HOME, '.ssh', 'authorized_keys'), PROJECT);
    assert.strictEqual(result.safe, false);
    assert.ok(result.reason?.includes('.ssh'), `Reason should mention .ssh: ${result.reason}`);
  });

  it('blocks writes to ~/.gnupg/', () => {
    const result = isPathSafe(path.join(HOME, '.gnupg', 'private-keys'), PROJECT);
    assert.strictEqual(result.safe, false);
  });

  it('blocks writes to ~/.aws/credentials', () => {
    const result = isPathSafe(path.join(HOME, '.aws', 'credentials'), PROJECT);
    assert.strictEqual(result.safe, false);
  });

  it('blocks path traversal (../../etc/passwd)', () => {
    const result = isPathSafe(path.join(PROJECT, '..', '..', '..', 'etc', 'passwd'), PROJECT);
    assert.strictEqual(result.safe, false);
  });

  it('allows project-relative paths', () => {
    const result = isPathSafe(path.join(PROJECT, 'src', 'index.ts'), PROJECT);
    assert.strictEqual(result.safe, true);
  });

  it('allows paths under user home', () => {
    const result = isPathSafe(path.join(HOME, 'Documents', 'file.txt'), PROJECT);
    assert.strictEqual(result.safe, true);
  });

  it('allows /tmp scratch paths (safe dev workflow)', () => {
    const result = isPathSafe('/tmp/demo/file.txt', PROJECT);
    assert.strictEqual(result.safe, true, `Reason: ${result.reason}`);
  });

  it('allows /var/tmp scratch paths', () => {
    const result = isPathSafe('/var/tmp/demo.py', PROJECT);
    assert.strictEqual(result.safe, true, `Reason: ${result.reason}`);
  });

  it('allows os.tmpdir() scratch paths', () => {
    const result = isPathSafe(path.join(os.tmpdir(), 'demo.txt'), PROJECT);
    assert.strictEqual(result.safe, true, `Reason: ${result.reason}`);
  });

  it('still blocks non-tmp paths outside project and home', () => {
    const result = isPathSafe('/opt/random/file.txt', PROJECT);
    assert.strictEqual(result.safe, false);
    assert.ok(result.reason?.includes('outside'), `Reason should mention outside: ${result.reason}`);
  });
});

describe('isCwdSafe', () => {
  it('allows project root as CWD', () => {
    // Use a real directory that exists
    const result = isCwdSafe(HOME, HOME);
    assert.strictEqual(result.safe, true);
  });

  it('rejects non-existent directory', () => {
    const result = isCwdSafe('/nonexistent/path/xyz', PROJECT);
    assert.strictEqual(result.safe, false);
    assert.ok(result.reason?.includes('does not exist'), `Reason: ${result.reason}`);
  });

  it('allows /tmp as CWD (safe scratch dir)', () => {
    const result = isCwdSafe('/tmp', PROJECT);
    assert.strictEqual(result.safe, true, `Reason: ${result.reason}`);
  });

  it('allows os.tmpdir() as CWD', () => {
    const result = isCwdSafe(os.tmpdir(), PROJECT);
    assert.strictEqual(result.safe, true, `Reason: ${result.reason}`);
  });
});
