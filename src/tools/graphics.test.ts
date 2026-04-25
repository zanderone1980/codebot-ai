import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { GraphicsTool, __resetMagickCache, __setMagickFlavorForTest } from './graphics';

/**
 * GraphicsTool — injection, containment, validation, and flavor-aware
 * planning tests (Row 12).
 *
 * Pre-fix, every exec sink used execSync(string) with user-supplied paths,
 * format, numeric dimensions, and watermark text pasted straight in. A
 * malicious `output = 'x"; touch /tmp/pwned; echo "'` broke out of the
 * quote and executed the second branch.
 *
 * These tests pin the argv-based fix plus two post-review patches:
 *   P2 — plans carry a `command` field. `info` and `combine grid` dispatch
 *        `identify` / `montage` as their own binaries on ImageMagick v6
 *        and via `magick <subcmd>` on v7. Pre-patch, v6 hosts silently
 *        ran `convert identify -verbose <file>`.
 *   P3 — numeric fields require `typeof v === 'number'`. Strings are
 *        rejected. Favicon `sizes` is a deliberately-string field and
 *        uses a separate digits-only parser.
 */

describe('GraphicsTool — metadata', () => {
  const tool = new GraphicsTool();

  it('has the expected tool name', () => {
    assert.strictEqual(tool.name, 'graphics');
  });

  it('gates runs behind a user prompt', () => {
    assert.strictEqual(tool.permission, 'prompt');
  });

  it('returns error for unknown action', async () => {
    const result = await tool.execute({ action: 'explode' });
    assert.ok(result.includes('Error: unknown action'));
  });
});

/**
 * Argv-shape tests. We call buildMagickPlan() directly — it returns the
 * planned (command, argv) without executing. If anyone reverts to string
 * interpolation, these fail loudly.
 */
describe('GraphicsTool — argv shape (via buildMagickPlan)', () => {
  let workDir: string;
  let originalCwd: string;

  before(() => {
    // Force v7 flavor so planning hits the magick branch on CI hosts that
    // don't have ImageMagick installed. These tests are about argv shape,
    // not about whether the host binary exists; the flavor-aware suite
    // below exercises v7 vs v6 explicitly.
    __setMagickFlavorForTest('v7');
    originalCwd = process.cwd();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row12-argv-'));
    process.chdir(workDir);
  });

  after(() => {
    __setMagickFlavorForTest(null);
    process.chdir(originalCwd);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('resize: input/output resolved absolute, geometry built from validated ints', () => {
    const tool = new GraphicsTool();
    fs.writeFileSync(path.join(workDir, 'in.png'), 'not-a-real-png');
    const plan = tool.buildMagickPlan('resize',
      { action: 'resize', input: 'in.png', width: 100, height: 50, output: 'out.png' },
      workDir,
    );
    assert.ok(!('error' in plan), `expected plan, got: ${'error' in plan ? plan.error : ''}`);
    if ('error' in plan) return;

    for (const el of plan.argv) {
      assert.ok(!el.includes('"'), `argv element should have no embedded quote: ${el}`);
    }
    if (plan.backend === 'magick') {
      // command is 'magick' (v7) or 'convert' (v6). argv shape is identical.
      assert.ok(['magick', 'convert'].includes(plan.command),
        `expected magick or convert, got ${plan.command}`);
      assert.deepStrictEqual(plan.argv, [
        path.resolve(workDir, 'in.png'),
        '-resize', '100x50!',
        path.resolve(workDir, 'out.png'),
      ]);
    } else {
      assert.strictEqual(plan.command, 'sips');
      assert.deepStrictEqual(plan.argv, [
        '-z', '50', '100', path.resolve(workDir, 'out.png'),
      ]);
    }
  });

  it('resize: rejects string "100; rm -rf ~" as width (not a number)', () => {
    const tool = new GraphicsTool();
    const plan = tool.buildMagickPlan('resize',
      { action: 'resize', input: 'in.png', width: '100; rm -rf ~', output: 'out.png' },
      workDir,
    );
    assert.ok('error' in plan);
    if ('error' in plan) assert.match(plan.error, /width must be a number/);
  });

  it('resize: rejects string "100" as width (P3: strict number, no coercion)', () => {
    const tool = new GraphicsTool();
    const plan = tool.buildMagickPlan('resize',
      { action: 'resize', input: 'in.png', width: '100', height: 50 },
      workDir,
    );
    assert.ok('error' in plan, 'string "100" must be rejected even though it parses to 100');
    if ('error' in plan) assert.match(plan.error, /width must be a number/);
  });

  it('resize: rejects "1e3" as width (P3: no exponential coercion)', () => {
    const tool = new GraphicsTool();
    const plan = tool.buildMagickPlan('resize',
      { action: 'resize', input: 'in.png', width: '1e3', height: 50 },
      workDir,
    );
    assert.ok('error' in plan);
  });

  it('resize: rejects non-integer number as width', () => {
    const tool = new GraphicsTool();
    const plan = tool.buildMagickPlan('resize',
      { action: 'resize', input: 'in.png', width: 100.5, height: 50 },
      workDir,
    );
    assert.ok('error' in plan);
  });

  it('resize: rejects output that escapes cwd', () => {
    const tool = new GraphicsTool();
    const plan = tool.buildMagickPlan('resize',
      { action: 'resize', input: 'in.png', width: 50, output: '../../etc/passwd' },
      workDir,
    );
    assert.ok('error' in plan);
    if ('error' in plan) assert.match(plan.error, /output escapes project root/);
  });

  it('resize: rejects sibling-prefix output (not true containment)', () => {
    const tool = new GraphicsTool();
    const sibling = workDir + '-evil';
    const plan = tool.buildMagickPlan('resize',
      { action: 'resize', input: 'in.png', width: 50, output: sibling },
      workDir,
    );
    assert.ok('error' in plan, 'sibling-prefix must be rejected');
    if ('error' in plan) assert.match(plan.error, /output escapes project root/);
  });

  it('watermark: text is one argv element, never pre-quoted', () => {
    const tool = new GraphicsTool();
    const payload = 'hi"; touch /tmp/should-not-happen; echo "';
    const plan = tool.buildMagickPlan('watermark',
      { action: 'watermark', input: 'in.png', text: payload, output: 'wm.png' },
      workDir,
    );
    if ('error' in plan) {
      assert.match(plan.error, /ImageMagick not found|input|text/);
      return;
    }
    assert.ok(plan.argv.includes(payload),
      `text must be its own argv element; got argv: ${JSON.stringify(plan.argv)}`);
    assert.ok(!plan.argv.some(a => a.startsWith('-annotate +') && a.includes(';')),
      'text must NOT be pre-joined into a flag argument');
    const annotateIdx = plan.argv.indexOf('-annotate');
    assert.ok(annotateIdx >= 0);
    assert.strictEqual(plan.argv[annotateIdx + 1], '+10+10');
    assert.strictEqual(plan.argv[annotateIdx + 2], payload);
  });

  it('crop: validates width/height/x/y as non-negative finite ints', () => {
    const tool = new GraphicsTool();
    fs.writeFileSync(path.join(workDir, 'cr.png'), 'x');
    const plan = tool.buildMagickPlan('crop',
      { action: 'crop', input: 'cr.png', width: 100, height: 50, x: 10, y: 20, output: 'cr-out.png' },
      workDir,
    );
    assert.ok(!('error' in plan));
    if ('error' in plan) return;
    if (plan.backend === 'magick') {
      assert.deepStrictEqual(plan.argv, [
        path.resolve(workDir, 'cr.png'),
        '-crop', '100x50+10+20',
        '+repage',
        path.resolve(workDir, 'cr-out.png'),
      ]);
    } else {
      assert.deepStrictEqual(plan.argv, [
        '-c', '50', '100',
        '--cropOffset', '20', '10',
        path.resolve(workDir, 'cr-out.png'),
      ]);
    }
  });

  it('crop: rejects malicious width string', () => {
    const tool = new GraphicsTool();
    const plan = tool.buildMagickPlan('crop',
      { action: 'crop', input: 'cr.png', width: '100; touch /tmp/pwned;#', height: 50 },
      workDir,
    );
    assert.ok('error' in plan);
    if ('error' in plan) assert.match(plan.error, /width must be a number/);
  });

  it('convert: rejects malicious format string', () => {
    const tool = new GraphicsTool();
    const plan = tool.buildMagickPlan('convert',
      { action: 'convert', input: 'in.png', format: 'jpg; ls' },
      workDir,
    );
    assert.ok('error' in plan);
    if ('error' in plan) assert.match(plan.error, /format must be one of/);
  });

  it('convert: accepts the allowed format list', () => {
    const tool = new GraphicsTool();
    for (const fmt of ['png', 'jpg', 'jpeg', 'webp', 'gif', 'svg', 'ico']) {
      const plan = tool.buildMagickPlan('convert',
        { action: 'convert', input: 'in.png', format: fmt, output: `out.${fmt}` },
        workDir,
      );
      assert.ok(!('error' in plan), `format ${fmt} must be accepted; got ${'error' in plan ? plan.error : ''}`);
    }
  });

  it('info: input must be inside cwd (no /etc read primitive)', () => {
    const tool = new GraphicsTool();
    const escapeTarget = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd';
    const plan = tool.buildMagickPlan('info',
      { action: 'info', input: escapeTarget },
      workDir,
    );
    assert.ok('error' in plan);
    if ('error' in plan) assert.match(plan.error, /input escapes project root/);
  });

  it('combine: every comma-split input is resolved and contained', () => {
    const tool = new GraphicsTool();
    fs.writeFileSync(path.join(workDir, 'a.png'), 'x');
    fs.writeFileSync(path.join(workDir, 'b.png'), 'x');
    const plan = tool.buildMagickPlan('combine',
      { action: 'combine', inputs: 'a.png, b.png', direction: 'horizontal', output: 'ab.png' },
      workDir,
    );
    if ('error' in plan) {
      assert.match(plan.error, /ImageMagick not found/);
      return;
    }
    assert.ok(['magick', 'convert'].includes(plan.command));
    assert.deepStrictEqual(plan.argv, [
      path.resolve(workDir, 'a.png'),
      path.resolve(workDir, 'b.png'),
      '+append',
      path.resolve(workDir, 'ab.png'),
    ]);
  });

  it('combine: rejects an input that escapes cwd', () => {
    const tool = new GraphicsTool();
    const escapeTarget = process.platform === 'win32' ? 'C:\\Windows\\win.ini' : '/etc/passwd';
    const plan = tool.buildMagickPlan('combine',
      { action: 'combine', inputs: `a.png,${escapeTarget}`, output: 'out.png' },
      workDir,
    );
    assert.ok('error' in plan);
    if ('error' in plan) {
      assert.ok(
        /input escapes project root|ImageMagick not found/.test(plan.error),
        `expected containment or no-magick error, got: ${plan.error}`,
      );
    }
  });
});

/**
 * P2 — flavor-aware planning. Under ImageMagick v7, `info` dispatches via
 * `magick identify …` and `combine grid` via `magick montage …`. Under
 * v6, those are their own binaries — plans must carry `command:
 * 'identify'` / `command: 'montage'` directly.
 *
 * Pre-patch, on a v6 host (only `convert`, `identify`, `montage` installed,
 * no `magick`), the runner executed `convert identify -verbose <file>` —
 * silently broken because `convert` doesn't dispatch subcommands.
 */
describe('GraphicsTool — flavor-aware planning (P2)', () => {
  let workDir: string;
  let originalCwd: string;

  before(() => {
    originalCwd = process.cwd();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row12-flavor-'));
    process.chdir(workDir);
    fs.writeFileSync(path.join(workDir, 'f.png'), 'x');
    fs.writeFileSync(path.join(workDir, 'a.png'), 'x');
    fs.writeFileSync(path.join(workDir, 'b.png'), 'x');
  });

  after(() => {
    __setMagickFlavorForTest(null);
    process.chdir(originalCwd);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('planInfo under v7: command="magick", argv starts with "identify"', () => {
    __setMagickFlavorForTest('v7');
    const tool = new GraphicsTool();
    const plan = tool.buildMagickPlan('info',
      { action: 'info', input: 'f.png' }, workDir);
    assert.ok(!('error' in plan));
    if ('error' in plan) return;
    assert.strictEqual(plan.command, 'magick');
    assert.deepStrictEqual(plan.argv, ['identify', '-verbose', path.resolve(workDir, 'f.png')]);
  });

  it('planInfo under v6: command="identify" directly (not "convert identify")', () => {
    __setMagickFlavorForTest('v6');
    const tool = new GraphicsTool();
    const plan = tool.buildMagickPlan('info',
      { action: 'info', input: 'f.png' }, workDir);
    assert.ok(!('error' in plan));
    if ('error' in plan) return;
    // This is the P2 fix. Pre-patch, command would have been 'convert' and
    // argv[0] would have been 'identify' — which breaks on v6 hosts.
    assert.strictEqual(plan.command, 'identify',
      'under v6, info MUST exec identify directly, not convert');
    assert.deepStrictEqual(plan.argv, ['-verbose', path.resolve(workDir, 'f.png')]);
  });

  it('planCombine grid under v7: command="magick", argv starts with "montage"', () => {
    __setMagickFlavorForTest('v7');
    const tool = new GraphicsTool();
    const plan = tool.buildMagickPlan('combine',
      { action: 'combine', inputs: 'a.png,b.png', direction: 'grid', output: 'g.png' },
      workDir);
    assert.ok(!('error' in plan));
    if ('error' in plan) return;
    assert.strictEqual(plan.command, 'magick');
    assert.strictEqual(plan.argv[0], 'montage');
  });

  it('planCombine grid under v6: command="montage" directly', () => {
    __setMagickFlavorForTest('v6');
    const tool = new GraphicsTool();
    const plan = tool.buildMagickPlan('combine',
      { action: 'combine', inputs: 'a.png,b.png', direction: 'grid', output: 'g.png' },
      workDir);
    assert.ok(!('error' in plan));
    if ('error' in plan) return;
    assert.strictEqual(plan.command, 'montage',
      'under v6, combine grid MUST exec montage directly');
    assert.notStrictEqual(plan.argv[0], 'montage',
      'argv must NOT double-prefix montage when command is already montage');
  });

  it('planCombine horizontal under v6: command="convert", argv has no subcommand prefix', () => {
    __setMagickFlavorForTest('v6');
    const tool = new GraphicsTool();
    const plan = tool.buildMagickPlan('combine',
      { action: 'combine', inputs: 'a.png,b.png', direction: 'horizontal', output: 'h.png' },
      workDir);
    assert.ok(!('error' in plan));
    if ('error' in plan) return;
    assert.strictEqual(plan.command, 'convert');
    assert.deepStrictEqual(plan.argv, [
      path.resolve(workDir, 'a.png'),
      path.resolve(workDir, 'b.png'),
      '+append',
      path.resolve(workDir, 'h.png'),
    ]);
  });

  it('planResize under v7 uses command="magick"; under v6 uses "convert"', () => {
    const tool = new GraphicsTool();

    __setMagickFlavorForTest('v7');
    let plan = tool.buildMagickPlan('resize',
      { action: 'resize', input: 'f.png', width: 32, output: 'o.png' }, workDir);
    assert.ok(!('error' in plan));
    if (!('error' in plan)) assert.strictEqual(plan.command, 'magick');

    __setMagickFlavorForTest('v6');
    plan = tool.buildMagickPlan('resize',
      { action: 'resize', input: 'f.png', width: 32, output: 'o.png' }, workDir);
    assert.ok(!('error' in plan));
    if (!('error' in plan)) assert.strictEqual(plan.command, 'convert');
  });
});

/**
 * Favicon sizes uses a separate string-to-int parser on purpose — that
 * field is comma-separated by design. Make sure the parser still rejects
 * anything that isn't pure digits.
 */
describe('GraphicsTool — favicon sizes parser (P3 carve-out)', () => {
  let workDir: string;
  let originalCwd: string;

  before(() => {
    originalCwd = process.cwd();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row12-sizes-'));
    process.chdir(workDir);
  });

  after(() => {
    process.chdir(originalCwd);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('rejects a non-digit token in sizes', async () => {
    const tool = new GraphicsTool();
    fs.writeFileSync(path.join(workDir, 'src.png'), 'x');
    const result = await tool.execute({
      action: 'favicon', input: 'src.png', sizes: '16,32,bad',
    });
    assert.match(result, /sizes entry "bad" must be a positive integer/);
  });

  it('rejects "16; ls" injection attempt in sizes', async () => {
    const tool = new GraphicsTool();
    fs.writeFileSync(path.join(workDir, 'src.png'), 'x');
    const result = await tool.execute({
      action: 'favicon', input: 'src.png', sizes: '16; ls',
    });
    assert.match(result, /sizes entry .* must be a positive integer/);
  });
});

/**
 * Color/svg validation: hostile hex colors must be rejected, not silently
 * replaced.
 */
describe('GraphicsTool — color/text validation (svg + og_image)', () => {
  let workDir: string;
  let originalCwd: string;

  before(() => {
    originalCwd = process.cwd();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row12-color-'));
    process.chdir(workDir);
  });

  after(() => {
    process.chdir(originalCwd);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('svg: rejects non-hex bg_color (no silent fallback)', async () => {
    const tool = new GraphicsTool();
    const result = await tool.execute({
      action: 'svg',
      svg_type: 'icon',
      text: 'CB',
      bg_color: '"/><script>alert(1)</script><rect fill="',
      output: 'icon.svg',
    });
    assert.match(result, /bg_color must be a hex color/);
    assert.ok(!fs.existsSync(path.join(workDir, 'icon.svg')),
      'no file should be written when validation fails');
  });

  it('svg: rejects non-hex accent_color', async () => {
    const tool = new GraphicsTool();
    const result = await tool.execute({
      action: 'svg',
      svg_type: 'logo',
      text: 'AI',
      accent_color: 'red',
      output: 'logo.svg',
    });
    assert.match(result, /accent_color must be a hex color/);
  });

  it('og_image: rejects non-hex bg_color', async () => {
    const tool = new GraphicsTool();
    const result = await tool.execute({
      action: 'og_image',
      title: 'Hi',
      bg_color: 'not-a-color',
      output: 'og.svg',
    });
    assert.match(result, /bg_color must be a hex color/);
  });

  it('svg: text with XML metacharacters is escaped into the document', async () => {
    const tool = new GraphicsTool();
    const result = await tool.execute({
      action: 'svg',
      svg_type: 'icon',
      text: '</text><script>alert(1)</script>',
      output: 'hostile.svg',
    });
    assert.match(result, /SVG \(icon\) saved/);
    const written = fs.readFileSync(path.join(workDir, 'hostile.svg'), 'utf-8');
    assert.ok(!written.includes('<script>'),
      `SVG must not contain raw <script>; got: ${written}`);
    assert.ok(written.includes('&lt;script&gt;'),
      'SVG text must be XML-escaped');
  });

  it('svg_content (raw): output outside cwd is rejected', async () => {
    const tool = new GraphicsTool();
    const escapeTarget = process.platform === 'win32' ? 'C:\\Windows\\evil.svg' : '/etc/cron.d/evil';
    const result = await tool.execute({
      action: 'svg',
      svg_content: '<svg/>',
      output: escapeTarget,
    });
    assert.match(result, /output escapes project root/);
    assert.ok(!fs.existsSync(escapeTarget));
  });
});

/**
 * Canary real-exec tests. Even if ImageMagick/sips aren't installed on
 * the test host, the code path reaches the exec call and errors via
 * ENOENT — a shell is NEVER spawned. So the marker file stays absent
 * either way. If a future refactor re-introduces execSync(string), the
 * malicious output/text breaks out and the marker appears → test fails.
 */
describe('GraphicsTool — shell-injection canaries (real exec)', () => {
  let workDir: string;
  let originalCwd: string;

  before(() => {
    originalCwd = process.cwd();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row12-canary-'));
    process.chdir(workDir);
    fs.writeFileSync(path.join(workDir, 'in.png'), 'not-a-real-png');
  });

  after(() => {
    process.chdir(originalCwd);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('resize/output: shell metacharacters in output are NEVER interpreted', async () => {
    const marker = path.join(workDir, 'PWNED_RESIZE');
    const tool = new GraphicsTool();
    const malicious = `${path.join(workDir, 'out.png')}"; node -e "require('fs').writeFileSync('${marker.replace(/\\/g, '\\\\')}','pwned')" #`;

    await tool.execute({
      action: 'resize',
      input: 'in.png',
      width: 10,
      output: malicious,
    });

    assert.strictEqual(
      fs.existsSync(marker),
      false,
      `SHELL INJECTION REGRESSION: ${marker} was created via output. Tool is back to concatenating into execSync.`,
    );
  });

  it('watermark/text: shell metacharacters in text are NEVER interpreted', async () => {
    const marker = path.join(workDir, 'PWNED_WATERMARK');
    const tool = new GraphicsTool();
    const maliciousText = `hi"; node -e "require('fs').writeFileSync('${marker.replace(/\\/g, '\\\\')}','pwned')" #`;

    await tool.execute({
      action: 'watermark',
      input: 'in.png',
      text: maliciousText,
      output: 'wm.png',
    });

    assert.strictEqual(
      fs.existsSync(marker),
      false,
      `SHELL INJECTION REGRESSION: ${marker} was created via watermark text.`,
    );
  });

  it('combine/output: shell metacharacters in output are NEVER interpreted', async () => {
    const marker = path.join(workDir, 'PWNED_COMBINE');
    const tool = new GraphicsTool();
    fs.writeFileSync(path.join(workDir, 'c1.png'), 'x');
    fs.writeFileSync(path.join(workDir, 'c2.png'), 'x');
    const malicious = `${path.join(workDir, 'out.png')}"; node -e "require('fs').writeFileSync('${marker.replace(/\\/g, '\\\\')}','pwned')" #`;

    await tool.execute({
      action: 'combine',
      inputs: 'c1.png,c2.png',
      output: malicious,
    });

    assert.strictEqual(
      fs.existsSync(marker),
      false,
      `SHELL INJECTION REGRESSION: ${marker} was created via combine output.`,
    );
  });

  it('convert/format: shell metacharacters in format are NEVER interpreted', async () => {
    const marker = path.join(workDir, 'PWNED_CONVERT');
    const tool = new GraphicsTool();
    await tool.execute({
      action: 'convert',
      input: 'in.png',
      format: `png; node -e "require('fs').writeFileSync('${marker.replace(/\\/g, '\\\\')}','pwned')" #`,
    });

    assert.strictEqual(
      fs.existsSync(marker),
      false,
      `SHELL INJECTION REGRESSION: ${marker} was created via format.`,
    );
  });
});

/**
 * Happy-path regression: the non-exec actions (svg, og_image) still work
 * end-to-end.
 */
describe('GraphicsTool — happy-path regression', () => {
  let workDir: string;
  let originalCwd: string;

  before(() => {
    originalCwd = process.cwd();
    workDir = fs.mkdtempSync(path.join(os.tmpdir(), 'codebot-row12-happy-'));
    process.chdir(workDir);
  });

  after(() => {
    process.chdir(originalCwd);
    try { fs.rmSync(workDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('svg action creates SVG icon with escaped text', async () => {
    const tool = new GraphicsTool();
    const result = await tool.execute({
      action: 'svg',
      svg_type: 'icon',
      text: 'CB',
      output: 'icon.svg',
    });
    assert.match(result, /SVG/);
    const full = path.resolve(workDir, 'icon.svg');
    assert.ok(fs.existsSync(full));
    const content = fs.readFileSync(full, 'utf-8');
    assert.ok(content.includes('<svg'));
    assert.ok(content.includes('CB'));
  });

  it('svg action creates badge with valid color', async () => {
    const tool = new GraphicsTool();
    const result = await tool.execute({
      action: 'svg',
      svg_type: 'badge',
      text: 'v2.5',
      bg_color: '#123456',
      output: 'badge.svg',
    });
    assert.match(result, /SVG/);
    const content = fs.readFileSync(path.resolve(workDir, 'badge.svg'), 'utf-8');
    assert.ok(content.includes('#123456'));
  });

  it('svg action creates logo with valid accent color', async () => {
    const tool = new GraphicsTool();
    const result = await tool.execute({
      action: 'svg',
      svg_type: 'logo',
      text: 'AI',
      accent_color: '#ff6b6b',
      output: 'logo.svg',
    });
    assert.match(result, /SVG/);
    const content = fs.readFileSync(path.resolve(workDir, 'logo.svg'), 'utf-8');
    assert.ok(content.includes('#ff6b6b'));
  });

  it('svg action saves raw svg_content inside cwd', async () => {
    const tool = new GraphicsTool();
    const svgContent = '<svg xmlns="http://www.w3.org/2000/svg" width="10" height="10"><rect width="10" height="10" fill="red"/></svg>';
    const result = await tool.execute({
      action: 'svg',
      svg_content: svgContent,
      output: 'raw.svg',
    });
    assert.match(result, /SVG saved/);
    assert.strictEqual(fs.readFileSync(path.resolve(workDir, 'raw.svg'), 'utf-8'), svgContent);
  });

  it('og_image generates Open Graph SVG with escaped title', async () => {
    const tool = new GraphicsTool();
    const result = await tool.execute({
      action: 'og_image',
      title: 'CodeBot & <friends>',
      subtitle: 'Your autonomous coding assistant',
      output: 'og.svg',
    });
    assert.match(result, /OG image/);
    assert.match(result, /1200x630/);
    const content = fs.readFileSync(path.resolve(workDir, 'og.svg'), 'utf-8');
    assert.ok(content.includes('CodeBot'));
    assert.ok(content.includes('&amp;'), 'ampersand must be XML-escaped');
    assert.ok(content.includes('&lt;friends&gt;'), 'angle brackets must be XML-escaped');
    assert.ok(!content.includes('<friends>'));
  });

  it('info: missing file returns a clean error, no exec', async () => {
    const tool = new GraphicsTool();
    const result = await tool.execute({ action: 'info', input: 'missing.png' });
    assert.match(result, /file not found|no image introspection tool/);
  });
});
