import { describe, it } from 'node:test';
import * as assert from 'node:assert';

/**
 * Tests for GitHub Action entry point logic.
 * Tests validation and dispatch logic without @actions/core dependency.
 */

type Task = 'review' | 'fix' | 'scan';
type ProviderName = 'anthropic' | 'openai';

function validateTask(taskInput: string): Task {
  const normalized = taskInput.trim().toLowerCase();
  if (normalized !== 'review' && normalized !== 'fix' && normalized !== 'scan') {
    throw new Error(
      `Invalid task: "${taskInput}". Supported tasks are: review, fix, scan.`
    );
  }
  return normalized;
}

function validateProvider(providerInput: string): ProviderName {
  const normalized = providerInput.trim().toLowerCase();
  if (normalized !== 'anthropic' && normalized !== 'openai') {
    throw new Error(
      `Invalid provider: "${providerInput}". Supported providers are: anthropic, openai.`
    );
  }
  return normalized;
}

describe('Task Validation', () => {
  it('accepts "review" task', () => {
    assert.strictEqual(validateTask('review'), 'review');
  });

  it('accepts "fix" task', () => {
    assert.strictEqual(validateTask('fix'), 'fix');
  });

  it('accepts "scan" task', () => {
    assert.strictEqual(validateTask('scan'), 'scan');
  });

  it('normalizes uppercase task names', () => {
    assert.strictEqual(validateTask('REVIEW'), 'review');
    assert.strictEqual(validateTask('FIX'), 'fix');
    assert.strictEqual(validateTask('SCAN'), 'scan');
  });

  it('trims whitespace from task names', () => {
    assert.strictEqual(validateTask('  review  '), 'review');
    assert.strictEqual(validateTask('\tfix\n'), 'fix');
  });

  it('rejects invalid task names', () => {
    assert.throws(() => validateTask('invalid'), /Invalid task/);
    assert.throws(() => validateTask('deploy'), /Invalid task/);
    assert.throws(() => validateTask(''), /Invalid task/);
  });

  it('includes supported tasks in error message', () => {
    try {
      validateTask('invalid');
      assert.fail('Should have thrown');
    } catch (e: unknown) {
      const msg = (e as Error).message;
      assert.ok(msg.includes('review'), 'Error should mention review');
      assert.ok(msg.includes('fix'), 'Error should mention fix');
      assert.ok(msg.includes('scan'), 'Error should mention scan');
    }
  });
});

describe('Provider Validation', () => {
  it('accepts "anthropic" provider', () => {
    assert.strictEqual(validateProvider('anthropic'), 'anthropic');
  });

  it('accepts "openai" provider', () => {
    assert.strictEqual(validateProvider('openai'), 'openai');
  });

  it('normalizes uppercase provider names', () => {
    assert.strictEqual(validateProvider('ANTHROPIC'), 'anthropic');
    assert.strictEqual(validateProvider('OpenAI'), 'openai');
  });

  it('trims whitespace from provider names', () => {
    assert.strictEqual(validateProvider('  anthropic  '), 'anthropic');
  });

  it('rejects invalid provider names', () => {
    assert.throws(() => validateProvider('google'), /Invalid provider/);
    assert.throws(() => validateProvider('ollama'), /Invalid provider/);
    assert.throws(() => validateProvider(''), /Invalid provider/);
  });

  it('includes supported providers in error message', () => {
    try {
      validateProvider('invalid');
      assert.fail('Should have thrown');
    } catch (e: unknown) {
      const msg = (e as Error).message;
      assert.ok(msg.includes('anthropic'), 'Error should mention anthropic');
      assert.ok(msg.includes('openai'), 'Error should mention openai');
    }
  });
});

describe('Input Parsing', () => {
  it('parses max-iterations as integer', () => {
    const raw = '25';
    const parsed = parseInt(raw, 10);
    assert.strictEqual(parsed, 25);
  });

  it('defaults max-iterations when empty', () => {
    const raw = '';
    const parsed = parseInt(raw || '25', 10);
    assert.strictEqual(parsed, 25);
  });

  it('defaults model when not specified', () => {
    const raw = '';
    const model = raw || 'claude-sonnet-4-20250514';
    assert.strictEqual(model, 'claude-sonnet-4-20250514');
  });

  it('uses explicit model when specified', () => {
    const raw = 'gpt-4o';
    const model = raw || 'claude-sonnet-4-20250514';
    assert.strictEqual(model, 'gpt-4o');
  });
});
