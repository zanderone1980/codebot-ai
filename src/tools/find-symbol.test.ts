import { describe, it, beforeEach, afterEach } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { FindSymbolTool } from './find-symbol';

describe('FindSymbolTool', () => {
  let tmp: string;

  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'fs-tool-'));
    // Minimal fixture: one Django-like, one TS-like
    fs.mkdirSync(path.join(tmp, 'django/contrib/admin'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'django/contrib/admin/filters.py'),
      [
        'class SimpleListFilter:',
        '    pass',
        '',
        'class RelatedFieldListFilter(SimpleListFilter):',
        '    def field_choices(self, field, request, model_admin):',
        '        return []',
        '',
        'class RelatedOnlyFieldListFilter(RelatedFieldListFilter):',
        '    pass',
      ].join('\n'),
    );
    fs.mkdirSync(path.join(tmp, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(tmp, 'src/config.ts'),
      [
        'export interface Config { provider: string; }',
        'export function loadConfig(): Config { return { provider: "" }; }',
        'export const DEFAULT_LIMIT = 50;',
      ].join('\n'),
    );
  });

  afterEach(() => {
    try { fs.rmSync(tmp, { recursive: true }); } catch { /* ignore */ }
  });

  it('exact match returns declaration sites only (not mentions in strings/docstrings)', async () => {
    fs.appendFileSync(
      path.join(tmp, 'django/contrib/admin/filters.py'),
      '\n# RelatedFieldListFilter mention in a comment\n',
    );
    const tool = new FindSymbolTool(tmp);
    const out = await tool.execute({ name: 'RelatedFieldListFilter' });
    const lines = out.split('\n').filter((l) => l.includes('RelatedFieldListFilter'));
    // Header + 1 declaration. Comment should NOT produce an entry.
    assert.match(out, /Found 1 symbol matching exact:"RelatedFieldListFilter"/);
    assert.strictEqual(lines.filter((l) => l.startsWith('  ')).length, 1);
    assert.match(out, /django\/contrib\/admin\/filters\.py:4/);
    assert.match(out, /\[class python\]/);
  });

  it('prefix match is case-insensitive and catches related names', async () => {
    const tool = new FindSymbolTool(tmp);
    const out = await tool.execute({ name: 'related', match: 'prefix' });
    assert.match(out, /RelatedFieldListFilter/);
    assert.match(out, /RelatedOnlyFieldListFilter/);
    assert.doesNotMatch(out, /SimpleListFilter/);
    assert.match(out, /Found 2 symbols matching prefix:/);
  });

  it('substring match catches names containing query anywhere', async () => {
    const tool = new FindSymbolTool(tmp);
    const out = await tool.execute({ name: 'Filter', match: 'substring' });
    assert.match(out, /SimpleListFilter/);
    assert.match(out, /RelatedFieldListFilter/);
    assert.match(out, /RelatedOnlyFieldListFilter/);
  });

  it('kind filter narrows by symbol kind', async () => {
    const tool = new FindSymbolTool(tmp);
    const out = await tool.execute({ name: 'field_choices' });
    // method of the Python class
    assert.match(out, /\[method python\]/);
    // Same name, but filter to class only — should return nothing
    const none = await tool.execute({ name: 'field_choices', kind: 'class' });
    assert.match(none, /No symbols found/);
  });

  it('returns helpful error when name is empty', async () => {
    const tool = new FindSymbolTool(tmp);
    assert.match(await tool.execute({ name: '' }), /Error: name is required/);
    assert.match(await tool.execute({ name: '   ' }), /Error: name is required/);
  });

  it('unknown match type returns a clear error', async () => {
    const tool = new FindSymbolTool(tmp);
    const out = await tool.execute({ name: 'X', match: 'fuzzy' });
    assert.match(out, /Error: unknown match type "fuzzy"/);
  });

  it('no matches returns message including total index size', async () => {
    const tool = new FindSymbolTool(tmp);
    const out = await tool.execute({ name: 'DoesNotExist' });
    assert.match(out, /No symbols found matching exact:"DoesNotExist"/);
    assert.match(out, /Index contains \d+ symbols total/);
  });

  it('limit parameter caps output with a "showing first N" hint', async () => {
    // Generate >25 symbols
    const many = Array.from({ length: 40 }, (_, i) => `def fn_${i}(): pass`).join('\n');
    fs.writeFileSync(path.join(tmp, 'many.py'), many);
    const tool = new FindSymbolTool(tmp);
    const out = await tool.execute({ name: 'fn_', match: 'prefix', limit: 10 });
    assert.match(out, /showing first 10/);
    const body = out.split('\n').slice(1).filter((l) => l.startsWith('  '));
    assert.strictEqual(body.length, 10);
  });

  it('finds TypeScript interface, function, and SCREAMING const', async () => {
    const tool = new FindSymbolTool(tmp);
    const iface = await tool.execute({ name: 'Config', kind: 'interface' });
    assert.match(iface, /Config/);
    assert.match(iface, /\[interface typescript\]/);
    const fn = await tool.execute({ name: 'loadConfig' });
    assert.match(fn, /\[function typescript\]/);
    const c = await tool.execute({ name: 'DEFAULT_LIMIT' });
    assert.match(c, /\[const typescript\]/);
  });

  it('results are sorted deterministically (file asc, then line asc)', async () => {
    fs.writeFileSync(path.join(tmp, 'a.py'), 'class Same: pass\n');
    fs.writeFileSync(path.join(tmp, 'b.py'), 'class Same: pass\n');
    fs.writeFileSync(path.join(tmp, 'c.py'), 'class Same: pass\n');
    const tool = new FindSymbolTool(tmp);
    const out = await tool.execute({ name: 'Same' });
    const bodyLines = out.split('\n').filter((l) => l.startsWith('  '));
    assert.deepStrictEqual(
      bodyLines.map((l) => l.trim().split(' ')[0]),
      ['a.py:1', 'b.py:1', 'c.py:1'],
    );
  });
});
