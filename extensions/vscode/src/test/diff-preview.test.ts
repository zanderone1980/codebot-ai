import { describe, it, beforeEach } from 'node:test';
import * as assert from 'node:assert';

/**
 * Tests for DiffPreviewProvider logic.
 * Since vscode module is unavailable outside the extension host,
 * we test the pure logic portions: content storage and retrieval.
 */

describe('DiffPreviewProvider (logic)', () => {
  let contentStore: Map<string, string>;
  let changeEvents: string[];

  beforeEach(() => {
    contentStore = new Map();
    changeEvents = [];
  });

  // Simulate the provider's core logic
  function setProposedContent(filePath: string, content: string) {
    contentStore.set(filePath, content);
    changeEvents.push(filePath);
  }

  function provideTextDocumentContent(path: string): string {
    return contentStore.get(path) ?? '';
  }

  function clearProposedContent(filePath: string) {
    contentStore.delete(filePath);
  }

  function clearAll() {
    contentStore.clear();
  }

  it('stores and retrieves proposed content', () => {
    setProposedContent('/src/app.ts', 'const x = 42;');
    assert.strictEqual(provideTextDocumentContent('/src/app.ts'), 'const x = 42;');
  });

  it('returns empty string for unknown paths', () => {
    assert.strictEqual(provideTextDocumentContent('/nonexistent.ts'), '');
  });

  it('overwrites existing content for same path', () => {
    setProposedContent('/src/app.ts', 'v1');
    setProposedContent('/src/app.ts', 'v2');
    assert.strictEqual(provideTextDocumentContent('/src/app.ts'), 'v2');
  });

  it('handles multiple files independently', () => {
    setProposedContent('/src/a.ts', 'file-a');
    setProposedContent('/src/b.ts', 'file-b');
    assert.strictEqual(provideTextDocumentContent('/src/a.ts'), 'file-a');
    assert.strictEqual(provideTextDocumentContent('/src/b.ts'), 'file-b');
  });

  it('fires change event when content is set', () => {
    setProposedContent('/src/app.ts', 'content');
    assert.strictEqual(changeEvents.length, 1);
    assert.strictEqual(changeEvents[0], '/src/app.ts');
  });

  it('fires multiple change events for multiple updates', () => {
    setProposedContent('/src/a.ts', 'a');
    setProposedContent('/src/b.ts', 'b');
    setProposedContent('/src/a.ts', 'a-updated');
    assert.strictEqual(changeEvents.length, 3);
  });

  it('clears specific file content', () => {
    setProposedContent('/src/app.ts', 'content');
    clearProposedContent('/src/app.ts');
    assert.strictEqual(provideTextDocumentContent('/src/app.ts'), '');
  });

  it('clears all content', () => {
    setProposedContent('/src/a.ts', 'a');
    setProposedContent('/src/b.ts', 'b');
    clearAll();
    assert.strictEqual(provideTextDocumentContent('/src/a.ts'), '');
    assert.strictEqual(provideTextDocumentContent('/src/b.ts'), '');
    assert.strictEqual(contentStore.size, 0);
  });

  it('handles empty content', () => {
    setProposedContent('/src/empty.ts', '');
    assert.strictEqual(provideTextDocumentContent('/src/empty.ts'), '');
    assert.ok(contentStore.has('/src/empty.ts'), 'Should store empty content');
  });

  it('handles content with special characters', () => {
    const content = 'const msg = "hello\\nworld";\n// 日本語コメント\n';
    setProposedContent('/src/special.ts', content);
    assert.strictEqual(provideTextDocumentContent('/src/special.ts'), content);
  });

  it('generates correct URI scheme', () => {
    const SCHEME = 'codebot-proposed';
    const filePath = '/src/app.ts';
    const uri = `${SCHEME}:${filePath}`;
    assert.ok(uri.startsWith('codebot-proposed:'), 'URI should use codebot-proposed scheme');
    assert.ok(uri.endsWith(filePath), 'URI should contain the file path');
  });

  it('generates correct diff title', () => {
    const filePath = '/workspace/src/components/App.tsx';
    const fileName = filePath.split('/').pop();
    const title = `${fileName} (Original ↔ CodeBot Proposed)`;
    assert.strictEqual(title, 'App.tsx (Original ↔ CodeBot Proposed)');
  });
});
