import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { isDockerAvailable, getSandboxInfo, resetDockerCheck } from './sandbox';

describe('Sandbox — Docker detection', () => {
  it('isDockerAvailable returns a boolean', () => {
    resetDockerCheck();
    const result = isDockerAvailable();
    assert.strictEqual(typeof result, 'boolean');
  });

  it('getSandboxInfo returns correct structure', () => {
    const info = getSandboxInfo();
    assert.strictEqual(typeof info.available, 'boolean');
    assert.strictEqual(typeof info.image, 'string');
    assert.ok(info.defaults);
    assert.strictEqual(typeof info.defaults.cpus, 'number');
    assert.strictEqual(typeof info.defaults.memoryMb, 'number');
    assert.strictEqual(typeof info.defaults.network, 'boolean');
  });

  it('caches Docker availability check', () => {
    resetDockerCheck();
    const first = isDockerAvailable();
    const second = isDockerAvailable();
    assert.strictEqual(first, second);
  });
});
