import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { XTwitterConnector, isXAuthError } from './x-twitter';
import { validateConnectorContract } from './connector-contract';

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

  // Credential parsing — JSON bundle.
  //
  // PR 20 update: the connector's HTTP wrapper now throws
  // ConnectorReauthError on 401/auth-class 403 instead of returning
  // an error string. So a test that previously asserted on the
  // returned string now needs to catch the thrown error. The intent
  // is unchanged: prove that PARSING succeeded by showing we got past
  // parsing into the network layer (which then 401s on bogus creds).
  it('post_tweet accepts JSON credential bundle', async () => {
    const x = new XTwitterConnector();
    const action = x.actions.find(a => a.name === 'post_tweet')!;
    let result = '';
    try {
      result = await action.execute({ message: 'hello' }, JSON.stringify({
        apiKey: 'k', apiSecret: 's', accessToken: 't', accessSecret: 'as',
      }));
    } catch (err) {
      // ConnectorReauthError IS evidence that parsing succeeded — the
      // call made it to the X API and got 401. That's exactly what
      // we wanted to prove.
      assert.match((err as Error).message, /HTTP 401|HTTP 403/);
      return;
    }
    assert.ok(!result.includes('credentials incomplete'), 'Should parse JSON credentials');
  });

  // Credential parsing — env var fallback.
  it('falls back to env vars when credential is not JSON', async () => {
    process.env.X_API_KEY = 'ek';
    process.env.X_API_SECRET = 'es';
    process.env.X_ACCESS_TOKEN = 'et';
    process.env.X_ACCESS_SECRET = 'eas';
    try {
      const x = new XTwitterConnector();
      const action = x.actions.find(a => a.name === 'post_tweet')!;
      let result = '';
      try {
        result = await action.execute({ message: 'hello' }, 'env');
      } catch (err) {
        // Same reasoning as above — auth error proves parsing succeeded.
        assert.match((err as Error).message, /HTTP 401|HTTP 403/);
        return;
      }
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

// ── PR 20: §8 contract surface ─────────────────────────────────────────

describe('isXAuthError (PR 20)', () => {
  it('401 → reauth', () => {
    assert.strictEqual(isXAuthError(401, undefined), true);
  });

  it('429 → not reauth (rate limit, never reconnect)', () => {
    assert.strictEqual(isXAuthError(429, { detail: 'rate limit exceeded' }), false);
    assert.strictEqual(isXAuthError(429, undefined), false);
  });

  it('422 → not reauth (validation error)', () => {
    assert.strictEqual(isXAuthError(422, { title: 'Invalid Request' }), false);
  });

  it('403 with title=Unauthorized → reauth', () => {
    assert.strictEqual(isXAuthError(403, { title: 'Unauthorized', detail: 'Token revoked' }), true);
  });

  it('403 with title=Forbidden → reauth', () => {
    assert.strictEqual(isXAuthError(403, { title: 'Forbidden' }), true);
  });

  it('403 with detail "duplicate content" → NOT reauth (server dedup, not auth)', () => {
    assert.strictEqual(
      isXAuthError(403, { title: 'Forbidden', detail: 'You are not allowed to create a Tweet with duplicate content.' }),
      false,
    );
  });

  it('403 with rate-limit wording → NOT reauth', () => {
    assert.strictEqual(isXAuthError(403, { title: 'Forbidden', detail: 'rate limit exceeded' }), false);
    assert.strictEqual(isXAuthError(403, { title: 'Forbidden', detail: 'abuse detected' }), false);
  });

  it('403 with no recognizable title/detail → NOT reauth (fail closed)', () => {
    assert.strictEqual(isXAuthError(403, { title: 'Some Other Thing', detail: 'mystery' }), false);
    assert.strictEqual(isXAuthError(403, undefined), false);
  });

  it('200 / 404 / 500 → not reauth', () => {
    assert.strictEqual(isXAuthError(200, undefined), false);
    assert.strictEqual(isXAuthError(404, undefined), false);
    assert.strictEqual(isXAuthError(500, undefined), false);
  });
});

describe('XTwitterConnector — §8 contract surface (PR 20)', () => {
  const connector = new XTwitterConnector();

  it('declares vaultKeyName=x', () => {
    assert.strictEqual(connector.vaultKeyName, 'x');
  });

  it('per-action capability labels match the §8 spec', () => {
    const byName = Object.fromEntries(connector.actions.map(a => [a.name, a]));
    assert.deepStrictEqual(byName.get_me.capabilities, ['read-only', 'account-access', 'net-fetch']);
    assert.deepStrictEqual(byName.search_tweets.capabilities, ['read-only', 'account-access', 'net-fetch']);
    assert.deepStrictEqual(byName.post_tweet.capabilities, ['account-access', 'net-fetch', 'send-on-behalf']);
    assert.deepStrictEqual(byName.post_thread.capabilities, ['account-access', 'net-fetch', 'send-on-behalf']);
    assert.deepStrictEqual(byName.delete_tweet.capabilities, ['account-access', 'net-fetch', 'send-on-behalf', 'delete-data']);
  });

  it('idempotency declarations: all three writes are unsupported with explicit reasons', () => {
    const byName = Object.fromEntries(connector.actions.map(a => [a.name, a]));
    for (const name of ['post_tweet', 'post_thread', 'delete_tweet']) {
      const a = byName[name];
      assert.strictEqual(a.idempotency?.kind, 'unsupported', `${name} idempotency should be unsupported`);
      if (a.idempotency?.kind === 'unsupported') {
        assert.ok(a.idempotency.reason.length > 50, `${name} reason should be substantive`);
      }
    }
    // Check the specific failure modes are named:
    assert.match((byName.post_tweet.idempotency as { reason: string }).reason, /duplicate content/i);
    assert.match((byName.post_thread.idempotency as { reason: string }).reason, /NOT atomic/i);
    assert.match((byName.delete_tweet.idempotency as { reason: string }).reason, /404/);
  });

  it('preview: post_tweet shows full text + length + irreversibility note', async () => {
    const a = connector.actions.find(x => x.name === 'post_tweet')!;
    assert.ok(a.preview, 'preview required for send-on-behalf');
    const p = await a.preview!({ message: 'hello world test tweet' }, '');
    assert.match(p.summary, /Would post tweet on X \(PUBLIC\)/);
    assert.match(p.summary, /Text:\s+hello world test tweet/);
    assert.match(p.summary, /Length:\s+22\/280/);
    assert.match(p.summary, /sha256:[a-f0-9]{16}/);
    assert.match(p.summary, /irreversibly|irreversible|cannot un-post|Idempotency: NONE/i);
    assert.strictEqual(p.details?.lengthOk, true);
    assert.strictEqual(p.details?.fullText, 'hello world test tweet');
  });

  it('preview: post_tweet flags over-length tweets', async () => {
    const a = connector.actions.find(x => x.name === 'post_tweet')!;
    const long = 'x'.repeat(300);
    const p = await a.preview!({ message: long }, '');
    assert.match(p.summary, /OVER LIMIT/);
    assert.strictEqual(p.details?.lengthOk, false);
  });

  it('preview: post_thread enumerates all tweets + non-atomic warning', async () => {
    const a = connector.actions.find(x => x.name === 'post_thread')!;
    const p = await a.preview!({ tweets: 'first ||| second ||| third' }, '');
    assert.match(p.summary, /Count:\s+3 tweet/);
    assert.match(p.summary, /1\..*first/);
    assert.match(p.summary, /2\..*second/);
    assert.match(p.summary, /3\..*third/);
    assert.match(p.summary, /NOT atomic/);
    assert.match(p.summary, /partial threads/i);
    assert.strictEqual(p.details?.count, 3);
  });

  it('preview: delete_tweet names irreversibility + cached-versions caveat', async () => {
    const a = connector.actions.find(x => x.name === 'delete_tweet')!;
    const p = await a.preview!({ tweet_id: '1234567890' }, '');
    assert.match(p.summary, /Would DELETE tweet/);
    assert.match(p.summary, /1234567890/);
    assert.match(p.summary, /Cached versions on third-party indexes/);
  });

  it('redactArgsForAudit: post_tweet hashes message; reply_to preserved', () => {
    const a = connector.actions.find(x => x.name === 'post_tweet')!;
    const out = a.redactArgsForAudit!({
      message: 'sensitive draft text that may not get posted',
      reply_to: '999',
    });
    assert.match(out.message as string, /^<redacted sha256:[a-f0-9]{16} len:\d+>$/);
    assert.strictEqual(out.reply_to, '999');
    assert.ok(!JSON.stringify(out).includes('sensitive draft'));
  });

  it('redactArgsForAudit: post_thread hashes joined tweets + counts', () => {
    const a = connector.actions.find(x => x.name === 'post_thread')!;
    const out = a.redactArgsForAudit!({
      tweets: 'first private ||| second private ||| third private',
    });
    assert.match(out.tweets as string, /^<redacted 3 tweet\(s\), total \d+ chars sha256:[a-f0-9]{16} len:\d+>$/);
    assert.ok(!JSON.stringify(out).includes('private'));
  });

  it('redactArgsForAudit: delete_tweet preserves tweet_id (already public)', () => {
    const a = connector.actions.find(x => x.name === 'delete_tweet')!;
    const out = a.redactArgsForAudit!({ tweet_id: '12345' });
    assert.strictEqual(out.tweet_id, '12345');
  });

  it('contract validator passes with zero violations', () => {
    const violations = validateConnectorContract(connector);
    assert.strictEqual(violations.length, 0,
      `expected zero violations; got: ${JSON.stringify(violations)}`);
  });
});
