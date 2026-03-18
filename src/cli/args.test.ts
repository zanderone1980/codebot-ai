import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { parseArgs } from './args';

describe('parseArgs', () => {
  it('sets version=true for --version flag', () => {
    const result = parseArgs(['--version']);
    assert.strictEqual(result.version, true);
  });

  it('sets version=true for -v shorthand', () => {
    const result = parseArgs(['-v']);
    assert.strictEqual(result.version, true);
  });

  it('does not set version when flag is absent', () => {
    const result = parseArgs([]);
    assert.strictEqual(result.version, undefined);
  });

  it('sets help=true for --help flag', () => {
    const result = parseArgs(['--help']);
  assert.strictEqual(result.help, true);
  });

  it('sets help=true for -h shorthand', () => {
    const result = parseArgs(['-h']);
    assert.strictEqual(result.help, true);
  });
});
