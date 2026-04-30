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

  it('parses --no-constitutional into args[\'no-constitutional\']=true', () => {
    const result = parseArgs(['--no-constitutional']);
    assert.strictEqual(result['no-constitutional'], true);
  });

  it('does not set no-constitutional when flag is absent', () => {
    const result = parseArgs([]);
    assert.strictEqual(result['no-constitutional'], undefined);
  });
});

describe('parseArgs — issue #7 fallback heuristic', () => {
  it('treats unknown --flag followed by short identifier as flag=value', () => {
    const result = parseArgs(['--corp-proxy', 'http://proxy.example.com']);
    assert.strictEqual(result['corp-proxy'], 'http://proxy.example.com');
    assert.strictEqual(result.message, undefined);
  });

  it('does NOT eat a long sentence after an unknown --flag (the message stays)', () => {
    // Real bug found tonight: --no-banner ate the SWE-bench problem statement.
    const result = parseArgs(['--no-banner', 'Fix the bug in foo.ts where the parser drops trailing commas']);
    assert.strictEqual(result['no-banner'], true);
    assert.ok(typeof result.message === 'string' && (result.message as string).startsWith('Fix the bug'));
  });

  it('does NOT eat anything containing whitespace after an unknown --flag', () => {
    const result = parseArgs(['--unknown', 'two words']);
    assert.strictEqual(result['unknown'], true);
    assert.strictEqual(result.message, 'two words');
  });

  it('treats unknown --flag with no following arg as flag=true', () => {
    const result = parseArgs(['--lone-flag']);
    assert.strictEqual(result['lone-flag'], true);
  });

  it('treats unknown --flag followed by another --flag as flag=true', () => {
    const result = parseArgs(['--first', '--second', 'value']);
    assert.strictEqual(result['first'], true);
    assert.strictEqual(result['second'], 'value');
  });

  it('still consumes legitimate short values (model names, paths, numbers)', () => {
    const r1 = parseArgs(['--xyz', 'gpt-4o-mini']);
    assert.strictEqual(r1['xyz'], 'gpt-4o-mini');
    const r2 = parseArgs(['--abc', '/Users/me/repo']);
    assert.strictEqual(r2['abc'], '/Users/me/repo');
    const r3 = parseArgs(['--qty', '42']);
    assert.strictEqual(r3['qty'], '42');
  });
});
