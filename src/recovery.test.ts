import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { getRecoverySuggestion, formatRecoveryHint } from './recovery';

describe('getRecoverySuggestion', () => {
  it('matches 401/403 auth errors', () => {
    const r = getRecoverySuggestion('Error: 401 Unauthorized');
    assert.ok(r);
    assert.ok(r.suggestion.includes('API key'));
    assert.strictEqual(r.command, 'codebot --setup');
  });

  it('matches forbidden text', () => {
    const r = getRecoverySuggestion('authentication failed for endpoint');
    assert.ok(r);
    assert.ok(r.suggestion.includes('API key'));
  });

  it('matches Ollama ECONNREFUSED on port 11434', () => {
    const r = getRecoverySuggestion('connect ECONNREFUSED 127.0.0.1:11434');
    assert.ok(r);
    assert.ok(r.suggestion.includes('Ollama'));
    assert.strictEqual(r.command, 'ollama serve');
  });

  it('matches LM Studio ECONNREFUSED on port 1234', () => {
    const r = getRecoverySuggestion('connect ECONNREFUSED localhost:1234');
    assert.ok(r);
    assert.ok(r.suggestion.includes('LM Studio'));
  });

  it('matches 429 rate limit', () => {
    const r = getRecoverySuggestion('Error 429: too many requests');
    assert.ok(r);
    assert.ok(r.suggestion.toLowerCase().includes('rate limit'));
  });

  it('matches DNS errors', () => {
    const r = getRecoverySuggestion('getaddrinfo ENOTFOUND api.example.com');
    assert.ok(r);
    assert.ok(r.suggestion.includes('DNS') || r.suggestion.includes('internet'));
  });

  it('matches model not found errors', () => {
    const r = getRecoverySuggestion('Error: model "llama3" not found');
    assert.ok(r);
    assert.ok(r.suggestion.includes('Model'));
    assert.ok(r.command?.includes('ollama pull'));
  });

  it('matches billing/quota errors', () => {
    const r = getRecoverySuggestion('insufficient_quota: you exceeded your billing limit');
    assert.ok(r);
    assert.ok(r.suggestion.includes('billing'));
  });

  it('matches context length errors', () => {
    const r = getRecoverySuggestion('maximum context length exceeded, too many tokens');
    assert.ok(r);
    assert.ok(r.suggestion.includes('Context') || r.suggestion.includes('context'));
  });

  it('matches disk full errors', () => {
    const r = getRecoverySuggestion('ENOSPC: no space left on device');
    assert.ok(r);
    assert.ok(r.suggestion.includes('Disk') || r.suggestion.includes('space'));
  });

  it('matches permission denied errors', () => {
    const r = getRecoverySuggestion('EACCES: permission denied, open /etc/secret');
    assert.ok(r);
    assert.ok(r.suggestion.includes('permission'));
  });

  it('returns null for unrecognized errors', () => {
    const r = getRecoverySuggestion('something completely random happened');
    assert.strictEqual(r, null);
  });
});

describe('formatRecoveryHint', () => {
  it('formats suggestion with command', () => {
    const hint = formatRecoveryHint({
      pattern: 'some error',
      suggestion: 'Do the thing.',
      command: 'fix-it',
    });
    assert.ok(hint.includes('Hint: Do the thing.'));
    assert.ok(hint.includes('Try:  fix-it'));
  });

  it('formats suggestion without command', () => {
    const hint = formatRecoveryHint({
      pattern: 'some error',
      suggestion: 'Check your network.',
    });
    assert.ok(hint.includes('Hint: Check your network.'));
    assert.ok(!hint.includes('Try:'));
  });
});
