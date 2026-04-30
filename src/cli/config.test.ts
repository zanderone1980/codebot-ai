import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { resolveConfig } from './config';

describe('resolveConfig — disableConstitutional wiring (Bug 2 regression)', () => {
  it('sets disableConstitutional=true when --no-constitutional is in args', async () => {
    const config = await resolveConfig({
      'no-constitutional': true,
      // Force a known model + base url so no auto-detect runs.
      model: 'claude-3-5-sonnet-20241022',
      'base-url': 'https://api.anthropic.com',
      'api-key': 'sk-test',
    });
    assert.strictEqual(config.disableConstitutional, true);
  });

  it('leaves disableConstitutional false when flag is absent', async () => {
    const config = await resolveConfig({
      model: 'claude-3-5-sonnet-20241022',
      'base-url': 'https://api.anthropic.com',
      'api-key': 'sk-test',
    });
    assert.strictEqual(!!config.disableConstitutional, false);
  });
});
