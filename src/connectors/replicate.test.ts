import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { ReplicateConnector, isReplicateAuthError } from './replicate';
import { validateConnectorContract } from './connector-contract';

describe('ReplicateConnector', () => {
  it('has correct metadata', () => {
    const c = new ReplicateConnector();
    assert.strictEqual(c.name, 'replicate');
    assert.strictEqual(c.displayName, 'Replicate');
    assert.strictEqual(c.envKey, 'REPLICATE_API_TOKEN');
    assert.strictEqual(c.authType, 'api_key');
  });

  it('has all expected actions', () => {
    const c = new ReplicateConnector();
    const names = c.actions.map(a => a.name);
    assert.ok(names.includes('generate'));
    assert.ok(names.includes('list_models'));
    assert.ok(names.includes('upscale'));
    assert.ok(names.includes('remove_background'));
    assert.strictEqual(c.actions.length, 4);
  });

  it('generate requires prompt', async () => {
    const c = new ReplicateConnector();
    const action = c.actions.find(a => a.name === 'generate')!;
    const result = await action.execute({ prompt: '' }, 'fake-token');
    assert.ok(result.includes('Error:'));
  });

  it('upscale requires image path', async () => {
    const c = new ReplicateConnector();
    const action = c.actions.find(a => a.name === 'upscale')!;
    const result = await action.execute({}, 'fake-token');
    assert.ok(result.includes('Error:'));
  });

  it('remove_background requires image path', async () => {
    const c = new ReplicateConnector();
    const action = c.actions.find(a => a.name === 'remove_background')!;
    const result = await action.execute({}, 'fake-token');
    assert.ok(result.includes('Error:'));
  });
});

// ── PR 24: §8 contract surface (paid-action specifics) ────────────────

describe('isReplicateAuthError', () => {
  it('401 → reauth', () => {
    assert.strictEqual(isReplicateAuthError(401, undefined), true);
  });

  it('402 → NOT reauth (out of credits / card declined)', () => {
    assert.strictEqual(isReplicateAuthError(402, { detail: 'Payment Required' }), false);
  });

  it('429 → NOT reauth (rate limit)', () => {
    assert.strictEqual(isReplicateAuthError(429, undefined), false);
  });

  it('200 / 404 / 500 → NOT reauth', () => {
    assert.strictEqual(isReplicateAuthError(200, undefined), false);
    assert.strictEqual(isReplicateAuthError(404, undefined), false);
    assert.strictEqual(isReplicateAuthError(500, undefined), false);
  });
});

describe('ReplicateConnector — §8 contract surface (PR 24)', () => {
  const connector = new ReplicateConnector();

  it('declares vaultKeyName=replicate', () => {
    assert.strictEqual(connector.vaultKeyName, 'replicate');
  });

  it('list_models is the only read-only action', () => {
    const byName = Object.fromEntries(connector.actions.map(a => [a.name, a]));
    assert.deepStrictEqual(byName.list_models.capabilities, ['read-only', 'account-access', 'net-fetch']);
  });

  it('all three paid verbs carry spend-money + write-fs', () => {
    const byName = Object.fromEntries(connector.actions.map(a => [a.name, a]));
    for (const name of ['generate', 'upscale', 'remove_background']) {
      const caps = byName[name].capabilities!;
      assert.ok(caps.includes('spend-money'), `${name} must declare spend-money (§7 paid action)`);
      assert.ok(caps.includes('write-fs'), `${name} must declare write-fs (saves output locally)`);
      assert.ok(caps.includes('account-access'), `${name} must declare account-access`);
      assert.ok(caps.includes('net-fetch'), `${name} must declare net-fetch`);
      assert.ok(!caps.includes('send-on-behalf'), `${name} must NOT declare send-on-behalf — Replicate isn't social posting`);
    }
  });

  it('all three paid verbs declare unsupported idempotency citing Prefer: wait + bill-twice', () => {
    const byName = Object.fromEntries(connector.actions.map(a => [a.name, a]));
    for (const name of ['generate', 'upscale', 'remove_background']) {
      const a = byName[name];
      assert.strictEqual(a.idempotency?.kind, 'unsupported');
      if (a.idempotency?.kind === 'unsupported') {
        assert.match(a.idempotency.reason, /Prefer:\s+wait/);
        assert.match(a.idempotency.reason, /bill twice/);
      }
    }
  });

  it('preview: generate names the cost surface explicitly', async () => {
    const a = connector.actions.find(x => x.name === 'generate')!;
    const p = await a.preview!({
      prompt: 'a serene mountain landscape',
      model: 'flux-pro',
      width: 1024,
      height: 768,
      num_outputs: 2,
    }, '');
    assert.match(p.summary, /PAID/);
    assert.match(p.summary, /Model:\s+flux-pro/);
    assert.match(p.summary, /1024x768/);
    assert.match(p.summary, /Outputs:\s+2/);
    assert.match(p.summary, /Cost:/);
    assert.match(p.summary, /BILLED/);
    assert.match(p.summary, /Idempotency:\s+NONE/);
    assert.match(p.summary, /retrying after a partial failure bills again/);
  });

  it('preview: upscale names the model + cost', async () => {
    const a = connector.actions.find(x => x.name === 'upscale')!;
    const p = await a.preview!({ image: '/tmp/in.png', scale: 4 }, '');
    assert.match(p.summary, /Would upscale image on Replicate \(PAID\)/);
    assert.match(p.summary, /Image:\s+\/tmp\/in\.png/);
    assert.match(p.summary, /Scale:\s+4x/);
    assert.match(p.summary, /real-esrgan/);
    assert.match(p.summary, /BILLED/);
  });

  it('preview: remove_background names cost', async () => {
    const a = connector.actions.find(x => x.name === 'remove_background')!;
    const p = await a.preview!({ image: '/tmp/in.png' }, '');
    assert.match(p.summary, /PAID/);
    assert.match(p.summary, /rembg/);
    assert.match(p.summary, /BILLED/);
  });

  it('redactArgsForAudit: generate hashes prompt + negative_prompt', () => {
    const a = connector.actions.find(x => x.name === 'generate')!;
    const out = a.redactArgsForAudit!({
      prompt: 'sensitive proprietary art direction',
      negative_prompt: 'no blur, no artifacts',
      width: 1024,
      model: 'flux-pro',
    });
    assert.strictEqual(out.width, 1024);
    assert.strictEqual(out.model, 'flux-pro');
    assert.match(out.prompt as string, /^<redacted sha256:[a-f0-9]{16} len:\d+>$/);
    assert.match(out.negative_prompt as string, /^<redacted sha256:[a-f0-9]{16} len:\d+>$/);
    assert.ok(!JSON.stringify(out).includes('proprietary'));
  });

  it('redactArgsForAudit: upscale + remove_background pass image path through', () => {
    const upscaleAction = connector.actions.find(x => x.name === 'upscale')!;
    const out1 = upscaleAction.redactArgsForAudit!({ image: '/tmp/x.png', scale: 2 });
    assert.strictEqual(out1.image, '/tmp/x.png');
    assert.strictEqual(out1.scale, 2);

    const rmAction = connector.actions.find(x => x.name === 'remove_background')!;
    const out2 = rmAction.redactArgsForAudit!({ image: '/tmp/x.png' });
    assert.strictEqual(out2.image, '/tmp/x.png');
  });

  it('contract validator passes with zero violations', () => {
    const violations = validateConnectorContract(connector);
    assert.strictEqual(violations.length, 0,
      `expected zero violations; got: ${JSON.stringify(violations)}`);
  });
});
