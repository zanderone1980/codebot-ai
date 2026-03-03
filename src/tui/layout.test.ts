import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { LayoutEngine } from './layout';

describe('LayoutEngine', () => {
  it('starts with zero panels', () => {
    const engine = new LayoutEngine();
    assert.strictEqual(engine.panelCount, 0);
  });

  it('addPanel increases panel count', () => {
    const engine = new LayoutEngine();
    engine.addPanel('plan', 'Plan');
    assert.strictEqual(engine.panelCount, 1);
    engine.addPanel('logs', 'Logs');
    assert.strictEqual(engine.panelCount, 2);
  });

  it('removePanel decreases panel count', () => {
    const engine = new LayoutEngine();
    engine.addPanel('plan', 'Plan');
    engine.addPanel('logs', 'Logs');
    engine.removePanel('plan');
    assert.strictEqual(engine.panelCount, 1);
  });

  it('getPanel returns the correct panel', () => {
    const engine = new LayoutEngine();
    engine.addPanel('plan', 'Plan');
    const panel = engine.getPanel('plan');
    assert.ok(panel);
    assert.strictEqual(panel.id, 'plan');
    assert.strictEqual(panel.title, 'Plan');
  });

  it('getPanel returns undefined for unknown ID', () => {
    const engine = new LayoutEngine();
    assert.strictEqual(engine.getPanel('nope'), undefined);
  });

  it('first panel gets focus by default', () => {
    const engine = new LayoutEngine();
    engine.addPanel('plan', 'Plan');
    engine.addPanel('logs', 'Logs');
    assert.strictEqual(engine.getFocusedId(), 'plan');
  });

  it('focusNext cycles through panels', () => {
    const engine = new LayoutEngine();
    engine.addPanel('plan', 'Plan');
    engine.addPanel('logs', 'Logs');
    engine.addPanel('diff', 'Diff');
    assert.strictEqual(engine.getFocusedId(), 'plan');
    engine.focusNext();
    assert.strictEqual(engine.getFocusedId(), 'logs');
    engine.focusNext();
    assert.strictEqual(engine.getFocusedId(), 'diff');
    engine.focusNext();
    assert.strictEqual(engine.getFocusedId(), 'plan'); // wraps
  });

  it('focusPrev cycles backwards', () => {
    const engine = new LayoutEngine();
    engine.addPanel('plan', 'Plan');
    engine.addPanel('logs', 'Logs');
    engine.focusPrev();
    assert.strictEqual(engine.getFocusedId(), 'logs');
  });

  it('updateContent replaces panel content', () => {
    const engine = new LayoutEngine();
    engine.addPanel('plan', 'Plan');
    engine.updateContent('plan', ['Step 1', 'Step 2', 'Step 3']);
    const panel = engine.getPanel('plan')!;
    assert.strictEqual(panel.content.length, 3);
    assert.strictEqual(panel.content[0], 'Step 1');
  });

  it('appendLine adds a single line', () => {
    const engine = new LayoutEngine();
    engine.addPanel('logs', 'Logs');
    engine.appendLine('logs', 'First line');
    engine.appendLine('logs', 'Second line');
    const panel = engine.getPanel('logs')!;
    assert.strictEqual(panel.content.length, 2);
    assert.strictEqual(panel.content[1], 'Second line');
  });

  it('scroll changes offset within bounds', () => {
    const engine = new LayoutEngine();
    engine.addPanel('logs', 'Logs');
    // Add many lines
    for (let i = 0; i < 100; i++) {
      engine.appendLine('logs', `Line ${i}`);
    }
    const panel = engine.getPanel('logs')!;
    const offsetBefore = panel.scrollOffset;
    engine.scroll('logs', -5);
    assert.ok(panel.scrollOffset <= offsetBefore);
    assert.ok(panel.scrollOffset >= 0);
  });

  it('scroll does not go below zero', () => {
    const engine = new LayoutEngine();
    engine.addPanel('logs', 'Logs');
    engine.appendLine('logs', 'One line');
    engine.scroll('logs', -100);
    const panel = engine.getPanel('logs')!;
    assert.strictEqual(panel.scrollOffset, 0);
  });

  it('render returns a string', () => {
    const engine = new LayoutEngine();
    engine.addPanel('plan', 'Plan');
    engine.appendLine('plan', 'Step 1: analyze');
    const output = engine.render();
    assert.ok(typeof output === 'string');
    assert.ok(output.length > 0);
  });

  it('render includes panel title', () => {
    const engine = new LayoutEngine();
    engine.addPanel('plan', 'My Plan');
    const output = engine.render();
    assert.ok(output.includes('My Plan'));
  });

  it('setStatus sets the status bar text', () => {
    const engine = new LayoutEngine();
    engine.addPanel('plan', 'Plan');
    engine.setStatus('Custom status');
    const output = engine.render();
    assert.ok(output.includes('Custom status'));
  });

  it('getPanelIds returns all panel IDs', () => {
    const engine = new LayoutEngine();
    engine.addPanel('plan', 'Plan');
    engine.addPanel('logs', 'Logs');
    const ids = engine.getPanelIds();
    assert.deepStrictEqual(ids, ['plan', 'logs']);
  });
});
