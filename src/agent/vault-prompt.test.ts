import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { buildVaultSystemPrompt } from './vault-prompt';

/**
 * Vault-mode prompt tests. These are contract tests — they lock in
 * the specific behavioral commitments the prompt makes (citations,
 * read-only default, no-network default). Breaking one of these
 * silently regresses the Vault Mode promise.
 */
describe('buildVaultSystemPrompt', () => {
  const base = { vaultPath: '/Users/alice/notes', writable: false, networkAllowed: false };

  it('identifies as CodeBot in Vault Mode', () => {
    const p = buildVaultSystemPrompt(base);
    assert.match(p, /You are CodeBot AI .* in Vault Mode/);
    assert.match(p, /research assistant/i);
  });

  it('names the vault path verbatim so the agent stays in it', () => {
    const p = buildVaultSystemPrompt(base);
    assert.match(p, /Vault path: \/Users\/alice\/notes/);
    assert.match(p, /Never read files outside \/Users\/alice\/notes/);
  });

  it('requires citations at the end of every answer', () => {
    const p = buildVaultSystemPrompt(base);
    assert.match(p, /Sources:/);
    assert.match(p, /always end your answer with a "Sources:" line/i);
  });

  it('forbids citing files the agent did not read', () => {
    const p = buildVaultSystemPrompt(base);
    assert.match(p, /Cite only the files whose content informed what you said/);
  });

  it('READ-ONLY by default — refuses edits', () => {
    const p = buildVaultSystemPrompt({ ...base, writable: false });
    assert.match(p, /READ-ONLY/);
    assert.match(p, /must not create, edit, move, or delete/);
    assert.match(p, /--vault-writable/);
  });

  it('writable mode relaxes the read-only restriction', () => {
    const p = buildVaultSystemPrompt({ ...base, writable: true });
    assert.doesNotMatch(p, /READ-ONLY/);
    assert.match(p, /create or edit notes when the user explicitly asks/);
  });

  it('network off by default — refuses network tools', () => {
    const p = buildVaultSystemPrompt({ ...base, networkAllowed: false });
    assert.match(p, /MUST NOT make any network request/);
    assert.match(p, /--vault-allow-network/);
  });

  it('network-allowed mode relaxes the network restriction', () => {
    const p = buildVaultSystemPrompt({ ...base, networkAllowed: true });
    assert.doesNotMatch(p, /MUST NOT make any network request/);
    assert.match(p, /may use web_fetch or http_client/);
  });

  it('includes the vault structure block when provided', () => {
    const p = buildVaultSystemPrompt({
      ...base,
      vaultStructure: '- projects/\n- meetings/\n- reference/',
    });
    assert.match(p, /Vault structure \(top level\)/);
    assert.match(p, /- projects\//);
  });

  it('does NOT include the vault-structure block when not provided', () => {
    const p = buildVaultSystemPrompt(base);
    assert.doesNotMatch(p, /Vault structure \(top level\)/);
  });

  it('tells the agent to skip obsidian/git/node_modules internals', () => {
    const p = buildVaultSystemPrompt(base);
    assert.match(p, /\.obsidian\//);
    assert.match(p, /\.git\//);
    assert.match(p, /node_modules\//);
  });

  it('forbids invented content (the core anti-hallucination rule)', () => {
    const p = buildVaultSystemPrompt(base);
    assert.match(p, /Invent note content that isn't there/);
    assert.match(p, /Cite a file you didn't actually read/);
  });
});
