import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SymbolIndexer } from './symbol-indexer';

/**
 * Tests use a real tmpdir with fixture files. No mocks — we need the
 * filesystem walk + regex match to actually work together.
 */
describe('SymbolIndexer', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sym-test-'));
  });

  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true }); } catch { /* ignore */ }
  });

  function write(rel: string, content: string): void {
    const abs = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }

  it('finds Python class + top-level function, distinguishes methods from functions', () => {
    write('mod/a.py', [
      'class RelatedFieldListFilter:',
      '    def field_choices(self, field):',
      '        return []',
      '    async def async_helper(self):',
      '        pass',
      '',
      'def top_level_func(x):',
      '    return x',
    ].join('\n'));
    const idx = new SymbolIndexer(tmp);
    const hits = idx.findByName('RelatedFieldListFilter');
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].kind, 'class');
    assert.strictEqual(hits[0].lang, 'python');
    assert.strictEqual(hits[0].file, 'mod/a.py');
    assert.strictEqual(hits[0].line, 1);

    const method = idx.findByName('field_choices')[0];
    assert.strictEqual(method.kind, 'method');

    const top = idx.findByName('top_level_func')[0];
    assert.strictEqual(top.kind, 'function');

    const asyncMethod = idx.findByName('async_helper')[0];
    assert.strictEqual(asyncMethod.kind, 'method');
  });

  it('finds TypeScript class / interface / type / function / enum', () => {
    write('src/thing.ts', [
      'export class MyClass {',
      '  foo() {}',
      '}',
      'export interface MyIface {',
      '  x: number;',
      '}',
      'export type MyType = string | number;',
      'export enum MyEnum { A, B }',
      'export function topLevel(x: number): number { return x; }',
    ].join('\n'));
    const idx = new SymbolIndexer(tmp);
    assert.strictEqual(idx.findByName('MyClass')[0].kind, 'class');
    assert.strictEqual(idx.findByName('MyIface')[0].kind, 'interface');
    assert.strictEqual(idx.findByName('MyType')[0].kind, 'type');
    assert.strictEqual(idx.findByName('MyEnum')[0].kind, 'enum');
    assert.strictEqual(idx.findByName('topLevel')[0].kind, 'function');
  });

  it('finds Go func + type', () => {
    write('main.go', [
      'package main',
      '',
      'type Server struct {',
      '    addr string',
      '}',
      '',
      'func (s *Server) Listen() error { return nil }',
      'func main() {}',
    ].join('\n'));
    const idx = new SymbolIndexer(tmp);
    assert.strictEqual(idx.findByName('Server')[0].kind, 'struct');
    assert.strictEqual(idx.findByName('Listen')[0].kind, 'function');
    assert.strictEqual(idx.findByName('main')[0].kind, 'function');
  });

  it('skips node_modules, .git, __pycache__', () => {
    write('node_modules/pkg/index.js', 'export function ghost() {}');
    write('.git/hooks/pre-commit', 'class ShouldNotBeIndexed {}');
    write('__pycache__/cached.py', 'class CachedClass: pass');
    write('real/a.py', 'def real_func(): pass');
    const idx = new SymbolIndexer(tmp);
    assert.strictEqual(idx.findByName('ghost').length, 0);
    assert.strictEqual(idx.findByName('ShouldNotBeIndexed').length, 0);
    assert.strictEqual(idx.findByName('CachedClass').length, 0);
    assert.strictEqual(idx.findByName('real_func').length, 1);
  });

  it('prefix and substring search work', () => {
    write('a.ts', [
      'export class RelatedFieldListFilter {}',
      'export class RelatedOnlyFieldListFilter {}',
      'export class UnrelatedThing {}',
    ].join('\n'));
    const idx = new SymbolIndexer(tmp);
    const byPrefix = idx.findByPrefix('related');
    assert.strictEqual(byPrefix.length, 2);
    const bySub = idx.findBySubstring('filter');
    assert.strictEqual(bySub.length, 2);
    const byExact = idx.findByName('RelatedFieldListFilter');
    assert.strictEqual(byExact.length, 1);
  });

  it('empty project returns empty but does not crash', () => {
    const idx = new SymbolIndexer(tmp);
    const all = idx.build();
    assert.deepStrictEqual(all, []);
    assert.deepStrictEqual(idx.findByName('anything'), []);
  });

  it('stats() returns a breakdown by lang and kind', () => {
    write('a.py', 'class A: pass\ndef f(): pass');
    write('b.ts', 'export class B {}\nexport interface I {}');
    const idx = new SymbolIndexer(tmp);
    const s = idx.stats();
    assert.strictEqual(s.totalSymbols, 4);
    assert.strictEqual(s.byLang.python, 2);
    assert.strictEqual(s.byLang.typescript, 2);
    assert.strictEqual(s.byKind.class, 2);
    assert.ok(s.byKind.function === 1 || s.byKind.method === 1);
    assert.strictEqual(s.byKind.interface, 1);
  });

  it('same-name symbols in different files each get an entry', () => {
    write('a.py', 'class Thing: pass');
    write('b.py', 'class Thing: pass');
    const idx = new SymbolIndexer(tmp);
    const hits = idx.findByName('Thing');
    assert.strictEqual(hits.length, 2);
    assert.notStrictEqual(hits[0].file, hits[1].file);
  });

  /**
   * Issue #11 contract test. SymbolEntry.file is exposed to the agent,
   * the dashboard, and the find-symbol tool — it MUST be POSIX-style
   * regardless of host OS. On Windows pre-fix this would have been
   * `deeply\nested\folder\thing.py` and downstream regex matchers and
   * model-readable output broke. The boundary normalization in
   * walkDir() makes the wire format platform-independent.
   */
  it('SymbolEntry.file is always POSIX-style (forward slashes), even on Windows', () => {
    write('deeply/nested/folder/thing.py', 'class DeepThing: pass');
    const idx = new SymbolIndexer(tmp);
    const hits = idx.findByName('DeepThing');
    assert.strictEqual(hits.length, 1);
    assert.strictEqual(hits[0].file, 'deeply/nested/folder/thing.py',
      'file must use forward slashes regardless of os.platform()');
    assert.ok(!hits[0].file.includes('\\'),
      `file must contain no backslashes; got ${hits[0].file}`);
  });

  it('respects MAX_FILE_SIZE_BYTES (skips huge files)', () => {
    // 3 MB file should be skipped; 1 KB should be scanned
    const big = 'class Big: pass\n' + 'x'.repeat(3 * 1024 * 1024);
    write('big.py', big);
    write('small.py', 'class Small: pass');
    const idx = new SymbolIndexer(tmp);
    assert.strictEqual(idx.findByName('Big').length, 0);
    assert.strictEqual(idx.findByName('Small').length, 1);
  });

  it('rebuilds after staleness window', () => {
    write('a.py', 'class Original: pass');
    const idx = new SymbolIndexer(tmp);
    assert.strictEqual(idx.findByName('Original').length, 1);
    // Simulate stale cache
    (idx as unknown as { indexedAt: number }).indexedAt = 0;
    write('b.py', 'class NewlyAdded: pass');
    assert.strictEqual(idx.findByName('NewlyAdded').length, 1);
  });
});
