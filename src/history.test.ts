import { describe, it, before, after } from 'node:test';
import * as assert from 'node:assert';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { SessionManager } from './history';

// Override sessions dir for testing
const origHome = process.env.HOME;

describe('SessionManager', () => {
  const testDir = path.join(os.tmpdir(), 'codebot-test-sessions-' + Date.now());

  before(() => {
    process.env.HOME = testDir;
    fs.mkdirSync(path.join(testDir, '.codebot', 'sessions'), { recursive: true });
  });

  after(() => {
    process.env.HOME = origHome;
    fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('generates a session ID', () => {
    const sm = new SessionManager('test-model');
    assert.ok(sm.getId());
    assert.ok(sm.getId().length > 10);
  });

  it('uses provided session ID', () => {
    const sm = new SessionManager('test-model', 'custom-id-123');
    assert.strictEqual(sm.getId(), 'custom-id-123');
  });

  it('saves and loads messages', () => {
    const sm = new SessionManager('test-model');
    sm.save({ role: 'user', content: 'hello' });
    sm.save({ role: 'assistant', content: 'hi there' });

    const loaded = sm.load();
    assert.strictEqual(loaded.length, 2);
    assert.strictEqual(loaded[0].role, 'user');
    assert.strictEqual(loaded[0].content, 'hello');
    assert.strictEqual(loaded[1].role, 'assistant');
    assert.strictEqual(loaded[1].content, 'hi there');
  });

  it('saveAll overwrites', () => {
    const sm = new SessionManager('test-model');
    sm.save({ role: 'user', content: 'first' });
    sm.saveAll([
      { role: 'user', content: 'replaced' },
    ]);

    const loaded = sm.load();
    assert.strictEqual(loaded.length, 1);
    assert.strictEqual(loaded[0].content, 'replaced');
  });

  it('load returns empty for nonexistent session', () => {
    const sm = new SessionManager('test-model', 'nonexistent-id');
    const loaded = sm.load();
    assert.strictEqual(loaded.length, 0);
  });
});
