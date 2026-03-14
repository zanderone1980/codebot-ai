import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { XTwitterConnector } from './x-twitter';

describe('XTwitterConnector', () => {
  it('has correct metadata', () => {
    const x = new XTwitterConnector();
    assert.strictEqual(x.name, 'x');
    assert.strictEqual(x.displayName, 'X (Twitter)');
    assert.strictEqual(x.authType, 'api_key');
    assert.strictEqual(x.envKey, 'X_API_KEY');
    assert.deepStrictEqual(x.requiredEnvKeys, [
      'X_API_KEY', 'X_API_SECRET', 'X_ACCESS_TOKEN', 'X_ACCESS_SECRET',
    ]);
  });

  it('has all expected actions', () => {
    const x = new XTwitterConnector();
    const names = x.actions.map(a => a.name);
    assert.ok(names.includes('post_tweet'));
    assert.ok(names.includes('post_thread'));
    assert.ok(names.includes('delete_tweet'));
    assert.ok(names.includes('get_me'));
    assert.ok(names.includes('search_tweets'));
    assert.strictEqual(x.actions.length, 5);
  });

  // Credential parsing — JSON bundle
  it('post_tweet accepts JSON credential bundle', async () => {
    const x = new XTwitterConnector();
    const action = x.actions.find(a => a.name === 'post_tweet')!;
    // The fetch will fail but credential parsing should succeed (error won't be about credentials)
    const result = await action.execute({ message: 'hello' }, JSON.stringify({
      apiKey: 'k', apiSecret: 's', accessToken: 't', accessSecret: 'as',
    }));
    // Should not complain about credentials — should fail at network level
    assert.ok(!result.includes('credentials incomplete'), 'Should parse JSON credentials');
  });

  // Credential parsing — env var fallback
  it('falls back to env vars when credential is not JSON', async () => {
    const orig = { ...process.env };
    process.env.X_API_KEY = 'ek';
    process.env.X_API_SECRET = 'es';
    process.env.X_ACCESS_TOKEN = 'et';
    process.env.X_ACCESS_SECRET = 'eas';
    try {
      const x = new XTwitterConnector();
      const action = x.actions.find(a => a.name === 'post_tweet')!;
      const result = await action.execute({ message: 'hello' }, 'env');
      assert.ok(!result.includes('credentials incomplete'), 'Should use env vars');
    } finally {
      delete process.env.X_API_KEY;
      delete process.env.X_API_SECRET;
      delete process.env.X_ACCESS_TOKEN;
      delete process.env.X_ACCESS_SECRET;
    }
  });

  // Credential parsing — incomplete
  it('rejects incomplete credentials', async () => {
    const x = new XTwitterConnector();
    const action = x.actions.find(a => a.name === 'post_tweet')!;
    const result = await action.execute({ message: 'hello' }, 'bad');
    assert.ok(result.includes('credentials incomplete') || result.includes('X credentials incomplete'),
      'Should reject incomplete credentials');
  });

  // Tweet length validation
  it('rejects tweets over 280 characters', async () => {
    const x = new XTwitterConnector();
    const action = x.actions.find(a => a.name === 'post_tweet')!;
    const longMsg = 'x'.repeat(281);
    const cred = JSON.stringify({ apiKey: 'k', apiSecret: 's', accessToken: 't', accessSecret: 'as' });
    const result = await action.execute({ message: longMsg }, cred);
    assert.ok(result.includes('281 characters'), 'Should report character count');
    assert.ok(result.includes('max 280'), 'Should mention the limit');
  });

  it('post_tweet requires a message', async () => {
    const x = new XTwitterConnector();
    const action = x.actions.find(a => a.name === 'post_tweet')!;
    const result = await action.execute({ message: '' }, 'fake');
    assert.ok(result.includes('Error:'));
  });

  // Thread splitting
  it('post_thread splits on ||| separator', async () => {
    const x = new XTwitterConnector();
    const action = x.actions.find(a => a.name === 'post_thread')!;
    // Single tweet (no |||) should error
    const result = await action.execute({ tweets: 'just one tweet' }, 'fake');
    assert.ok(result.includes('at least 2 tweets'), 'Should require multiple tweets');
  });

  it('post_thread rejects over-length individual tweets', async () => {
    const x = new XTwitterConnector();
    const action = x.actions.find(a => a.name === 'post_thread')!;
    const longTweet = 'x'.repeat(281);
    const cred = JSON.stringify({ apiKey: 'k', apiSecret: 's', accessToken: 't', accessSecret: 'as' });
    const result = await action.execute({ tweets: `short ||| ${longTweet}` }, cred);
    assert.ok(result.includes('tweet 2'), 'Should identify which tweet is too long');
    assert.ok(result.includes('281 chars'), 'Should report the character count');
  });

  it('post_thread requires tweets parameter', async () => {
    const x = new XTwitterConnector();
    const action = x.actions.find(a => a.name === 'post_thread')!;
    const result = await action.execute({ tweets: '' }, 'fake');
    assert.ok(result.includes('Error:'));
  });
});
