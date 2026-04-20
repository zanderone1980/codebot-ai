import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import * as path from 'path';
import { augmentedPath, envWithAugmentedPath } from './path-augment';

/**
 * These tests guard the Finder-launched-Electron PATH fix. If augmentedPath
 * ever stops appending /opt/homebrew/bin, CodeBot's execute tool regresses
 * to "python3 not found" on Apple Silicon macs. That's the whole point.
 */

describe('augmentedPath', () => {
  it('appends /opt/homebrew/bin when missing', () => {
    const out = augmentedPath('/usr/bin:/bin');
    assert.ok(
      out.split(path.delimiter).includes('/opt/homebrew/bin'),
      `expected /opt/homebrew/bin in output: ${out}`,
    );
  });

  it('appends /usr/local/bin when missing', () => {
    const out = augmentedPath('/usr/bin:/bin');
    assert.ok(out.split(path.delimiter).includes('/usr/local/bin'));
  });

  it('preserves existing PATH entries and their order', () => {
    const input = '/custom/tool/bin:/usr/bin:/bin';
    const out = augmentedPath(input);
    const parts = out.split(path.delimiter);
    assert.strictEqual(parts[0], '/custom/tool/bin');
    assert.strictEqual(parts[1], '/usr/bin');
    assert.strictEqual(parts[2], '/bin');
  });

  it('does not duplicate entries already present', () => {
    const input = '/opt/homebrew/bin:/usr/bin:/bin';
    const out = augmentedPath(input);
    const parts = out.split(path.delimiter);
    const count = parts.filter((p) => p === '/opt/homebrew/bin').length;
    assert.strictEqual(count, 1, `expected exactly 1 /opt/homebrew/bin, got ${count}: ${out}`);
  });

  it('handles empty PATH gracefully', () => {
    const out = augmentedPath('');
    assert.ok(out.split(path.delimiter).includes('/opt/homebrew/bin'));
    assert.ok(out.split(path.delimiter).includes('/usr/bin'));
  });

  it('handles undefined PATH gracefully', () => {
    const out = augmentedPath(undefined);
    assert.ok(out.length > 0);
    assert.ok(out.split(path.delimiter).includes('/opt/homebrew/bin'));
  });
});

describe('envWithAugmentedPath', () => {
  it('returns a new object (does not mutate input)', () => {
    const input = { PATH: '/usr/bin', FOO: 'bar' };
    const out = envWithAugmentedPath(input);
    assert.notStrictEqual(out, input);
    assert.strictEqual(input.PATH, '/usr/bin', 'input must not be mutated');
  });

  it('preserves all non-PATH env vars', () => {
    const input = { PATH: '/usr/bin', FOO: 'bar', BAZ: 'qux' };
    const out = envWithAugmentedPath(input);
    assert.strictEqual(out.FOO, 'bar');
    assert.strictEqual(out.BAZ, 'qux');
  });

  it('augments PATH with standard bin dirs', () => {
    const out = envWithAugmentedPath({ PATH: '/usr/bin' });
    assert.ok((out.PATH || '').includes('/opt/homebrew/bin'));
  });
});
