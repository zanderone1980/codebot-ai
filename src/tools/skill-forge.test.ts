import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SkillForgeTool } from './skill-forge';

describe('SkillForge Tool', () => {
  const tmpDir = path.join(os.tmpdir(), 'codebot-forge-test-' + Date.now());
  const skillsDir = path.join(tmpDir, 'skills');
  let forge: SkillForgeTool;

  before(() => {
    process.env.CODEBOT_HOME = tmpDir;
    fs.mkdirSync(skillsDir, { recursive: true });
    forge = new SkillForgeTool();
  });

  after(() => {
    delete process.env.CODEBOT_HOME;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('has correct tool metadata', () => {
    assert.strictEqual(forge.name, 'skill_forge');
    assert.strictEqual(forge.permission, 'prompt');
    assert.ok(forge.description.includes('reusable'));
  });

  it('creates a valid skill', async () => {
    const result = await forge.execute({
      action: 'create',
      name: 'test-skill',
      description: 'A test skill for unit testing',
      steps: [
        { tool: 'think', args: { thought: 'step 1' } },
        { tool: 'grep', args: { pattern: 'TODO', path: '.' } },
      ],
    });

    assert.ok(result.includes('created'));
    assert.ok(result.includes('skill_test-skill'));

    // Verify file was written
    const skillPath = path.join(skillsDir, 'test-skill.json');
    assert.ok(fs.existsSync(skillPath));

    const skill = JSON.parse(fs.readFileSync(skillPath, 'utf-8'));
    assert.strictEqual(skill.name, 'test-skill');
    assert.strictEqual(skill.author, 'codebot');
    assert.strictEqual(skill.confidence, 0.5);
    assert.strictEqual(skill.use_count, 0);
    assert.strictEqual(skill.origin, 'forged');
    assert.strictEqual(skill.steps.length, 2);
    assert.ok(skill.created_at);
    assert.ok(skill.updated_at);
  });

  it('rejects duplicate skill names', async () => {
    const result = await forge.execute({
      action: 'create',
      name: 'test-skill',
      description: 'Duplicate',
      steps: [{ tool: 'think', args: { thought: 'dup' } }],
    });
    assert.ok(result.includes('already exists'));
  });

  it('validates skill name characters', async () => {
    const result = await forge.execute({
      action: 'create',
      name: 'bad name!',
      description: 'Invalid name',
      steps: [{ tool: 'think', args: { thought: 'test' } }],
    });
    assert.ok(result.includes('Validation error'));
  });

  it('validates skill must have steps', async () => {
    const result = await forge.execute({
      action: 'create',
      name: 'no-steps',
      description: 'Missing steps',
      steps: [],
    });
    assert.ok(result.includes('at least one step'));
  });

  it('validates step must have tool and args', async () => {
    const result = await forge.execute({
      action: 'create',
      name: 'bad-step',
      description: 'Bad step',
      steps: [{ tool: '', args: {} }],
    });
    assert.ok(result.includes('Validation error'));
  });

  it('lists skills in shared store', async () => {
    const result = await forge.execute({ action: 'list' });
    assert.ok(result.includes('test-skill'));
    assert.ok(result.includes('author=codebot'));
    assert.ok(result.includes('confidence=0.50'));
  });

  it('inspects a specific skill', async () => {
    const result = await forge.execute({ action: 'inspect', name: 'test-skill' });
    assert.ok(result.includes('Name: test-skill'));
    assert.ok(result.includes('Author: codebot'));
    assert.ok(result.includes('Origin: forged'));
    assert.ok(result.includes('Steps (2)'));
  });

  it('reinforces skill on success (increases confidence)', async () => {
    const result = await forge.execute({
      action: 'reinforce',
      name: 'test-skill',
      success: true,
    });
    assert.ok(result.includes('reinforced'));
    assert.ok(result.includes('confidence=0.55'));
    assert.ok(result.includes('use_count=1'));
  });

  it('reinforces skill on failure (decreases confidence)', async () => {
    const result = await forge.execute({
      action: 'reinforce',
      name: 'test-skill',
      success: false,
    });
    assert.ok(result.includes('reinforced'));
    // Was 0.55 after success, now -0.1 = 0.45
    assert.ok(result.includes('confidence=0.45'));
    assert.ok(result.includes('use_count=2'));
  });

  it('creates skill with trigger and parameters', async () => {
    const result = await forge.execute({
      action: 'create',
      name: 'deploy-check',
      description: 'Run deployment checks',
      trigger: 'deploy|ship|release',
      parameters: {
        type: 'object',
        properties: {
          env: { type: 'string', description: 'Target environment' },
        },
        required: ['env'],
      },
      steps: [
        { tool: 'execute', args: { command: 'npm test' } },
        { tool: 'execute', args: { command: 'npm run build' }, condition: '{{prev.success}}' },
      ],
    });

    assert.ok(result.includes('created'));

    const skill = JSON.parse(fs.readFileSync(path.join(skillsDir, 'deploy-check.json'), 'utf-8'));
    assert.strictEqual(skill.trigger, 'deploy|ship|release');
    assert.deepStrictEqual(skill.parameters.required, ['env']);
  });

  it('deletes a skill', async () => {
    const result = await forge.execute({ action: 'delete', name: 'deploy-check' });
    assert.ok(result.includes('deleted'));
    assert.ok(!fs.existsSync(path.join(skillsDir, 'deploy-check.json')));
  });

  it('returns error for non-existent skill operations', async () => {
    const inspectResult = await forge.execute({ action: 'inspect', name: 'nonexistent' });
    assert.ok(inspectResult.includes('not found'));

    const deleteResult = await forge.execute({ action: 'delete', name: 'nonexistent' });
    assert.ok(deleteResult.includes('not found'));

    const reinforceResult = await forge.execute({ action: 'reinforce', name: 'nonexistent' });
    assert.ok(reinforceResult.includes('not found'));
  });

  it('returns error for unknown action', async () => {
    const result = await forge.execute({ action: 'unknown' });
    assert.ok(result.includes('Unknown action'));
  });

  it('creates skills dir if it does not exist', async () => {
    // Remove skills dir
    fs.rmSync(skillsDir, { recursive: true, force: true });

    const result = await forge.execute({
      action: 'create',
      name: 'auto-dir',
      description: 'Test auto-creation of skills directory',
      steps: [{ tool: 'think', args: { thought: 'test' } }],
    });

    assert.ok(result.includes('created'));
    assert.ok(fs.existsSync(skillsDir));
  });
});

describe('SkillForge — shared metadata compatibility', () => {
  const tmpDir = path.join(os.tmpdir(), 'codebot-forge-compat-' + Date.now());
  const skillsDir = path.join(tmpDir, 'skills');
  let forge: SkillForgeTool;

  before(() => {
    process.env.CODEBOT_HOME = tmpDir;
    fs.mkdirSync(skillsDir, { recursive: true });
    forge = new SkillForgeTool();

    // Write a skill that looks like it came from CodeAGI
    const codeagiSkill = {
      name: 'codeagi_search_logs',
      description: 'Search logs procedure for debugging',
      trigger: 'find errors in logs',
      steps: [
        { tool: 'grep', args: { pattern: 'ERROR|FATAL', path: '/var/log' } },
        { tool: 'think', args: { thought: 'Analyze error patterns from {{prev.output}}' } },
      ],
      author: 'codeagi',
      confidence: 0.85,
      use_count: 5,
      origin: 'promoted',
      source_procedure_id: 'procedure_abc123',
      created_at: '2026-03-15T10:00:00Z',
      updated_at: '2026-03-15T10:00:00Z',
    };
    fs.writeFileSync(
      path.join(skillsDir, 'codeagi_search_logs.json'),
      JSON.stringify(codeagiSkill, null, 2),
    );
  });

  after(() => {
    delete process.env.CODEBOT_HOME;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('lists CodeAGI-authored skills with correct metadata', async () => {
    const result = await forge.execute({ action: 'list' });
    assert.ok(result.includes('codeagi_search_logs'));
    assert.ok(result.includes('author=codeagi'));
    assert.ok(result.includes('origin=promoted'));
    assert.ok(result.includes('confidence=0.85'));
    assert.ok(result.includes('uses=5'));
  });

  it('can reinforce CodeAGI-authored skills', async () => {
    const result = await forge.execute({
      action: 'reinforce',
      name: 'codeagi_search_logs',
      success: true,
    });
    assert.ok(result.includes('reinforced'));
    assert.ok(result.includes('confidence=0.90'));
    assert.ok(result.includes('use_count=6'));
  });

  it('inspects CodeAGI-authored skills with full metadata', async () => {
    const result = await forge.execute({ action: 'inspect', name: 'codeagi_search_logs' });
    assert.ok(result.includes('Author: codeagi'));
    assert.ok(result.includes('Origin: promoted'));
  });
});

// ── 2026-04-23 sweep: path-traversal regression tests ──────────────────
//
// Before this sweep, only _create validated the skill name against
// /^[a-zA-Z0-9_-]+$/. reinforceSkill / _delete / _inspect accepted any
// string and did `path.join(skillsDir, \`${name}.json\`)` — so a name of
// `../../../tmp/pwn` let the agent unlink, read, or overwrite .json
// files outside the skills dir. These tests prove every op now rejects
// traversal before touching the filesystem.
describe('SkillForge Tool — path-traversal protection (2026-04-23)', () => {
  const tmpDir = path.join(os.tmpdir(), 'codebot-forge-trav-' + Date.now());
  const skillsDir = path.join(tmpDir, 'skills');
  // A canary file OUTSIDE the skills dir — the traversal, if it worked,
  // would target something like this.
  const canaryOutside = path.join(tmpDir, 'should-stay-safe.json');
  let forge: SkillForgeTool;

  before(() => {
    process.env.CODEBOT_HOME = tmpDir;
    fs.mkdirSync(skillsDir, { recursive: true });
    fs.writeFileSync(canaryOutside, '{"canary":"do not touch"}');
    forge = new SkillForgeTool();
  });

  after(() => {
    delete process.env.CODEBOT_HOME;
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  const traversalNames = [
    '../should-stay-safe',           // one level up, existing file
    '../../etc/passwd',              // classic
    '..\\windows\\traversal',        // backslash variant
    'a/b',                           // embedded slash
    'a.b',                           // dot (would let ".json" land mid-name)
    ' ',                             // whitespace only
  ];

  for (const bad of traversalNames) {
    it(`rejects traversal on reinforce: "${bad}"`, async () => {
      const before = fs.existsSync(canaryOutside) ? fs.readFileSync(canaryOutside, 'utf-8') : null;
      const result = await forge.execute({ action: 'reinforce', name: bad, success: true });
      assert.match(result, /invalid skill name|Must provide|not found/i, `got: ${result}`);
      if (before !== null) {
        assert.strictEqual(fs.readFileSync(canaryOutside, 'utf-8'), before, 'canary must not be overwritten');
      }
    });

    it(`rejects traversal on delete: "${bad}"`, async () => {
      const canaryExisted = fs.existsSync(canaryOutside);
      const result = await forge.execute({ action: 'delete', name: bad });
      assert.match(result, /invalid skill name|Must provide|not found/i, `got: ${result}`);
      if (canaryExisted) {
        assert.ok(fs.existsSync(canaryOutside), 'canary must not be unlinked');
      }
    });

    it(`rejects traversal on inspect: "${bad}"`, async () => {
      const result = await forge.execute({ action: 'inspect', name: bad });
      assert.match(result, /invalid skill name|Must provide|not found/i, `got: ${result}`);
    });
  }
});
