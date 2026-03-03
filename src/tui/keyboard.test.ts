import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { parseKeypress, keyToAction } from './keyboard';

describe('parseKeypress', () => {
  it('parses arrow keys', () => {
    assert.strictEqual(parseKeypress(Buffer.from('\x1b[A')).name, 'up');
    assert.strictEqual(parseKeypress(Buffer.from('\x1b[B')).name, 'down');
    assert.strictEqual(parseKeypress(Buffer.from('\x1b[C')).name, 'right');
    assert.strictEqual(parseKeypress(Buffer.from('\x1b[D')).name, 'left');
  });

  it('parses enter key', () => {
    assert.strictEqual(parseKeypress(Buffer.from('\r')).name, 'enter');
    assert.strictEqual(parseKeypress(Buffer.from('\n')).name, 'enter');
  });

  it('parses escape key', () => {
    assert.strictEqual(parseKeypress(Buffer.from('\x1b')).name, 'escape');
  });

  it('parses tab key', () => {
    assert.strictEqual(parseKeypress(Buffer.from('\t')).name, 'tab');
  });

  it('parses ctrl+c', () => {
    const event = parseKeypress(Buffer.from('\x03'));
    assert.strictEqual(event.name, 'ctrl-c');
    assert.strictEqual(event.ctrl, true);
  });

  it('parses regular characters', () => {
    assert.strictEqual(parseKeypress(Buffer.from('y')).name, 'y');
    assert.strictEqual(parseKeypress(Buffer.from('n')).name, 'n');
    assert.strictEqual(parseKeypress(Buffer.from('q')).name, 'q');
  });

  it('parses uppercase with shift flag', () => {
    const event = parseKeypress(Buffer.from('Y'));
    assert.strictEqual(event.name, 'y');
    assert.strictEqual(event.shift, true);
  });

  it('parses space', () => {
    assert.strictEqual(parseKeypress(Buffer.from(' ')).name, 'space');
  });

  it('parses backspace', () => {
    assert.strictEqual(parseKeypress(Buffer.from('\x7f')).name, 'backspace');
  });

  it('parses function keys', () => {
    assert.strictEqual(parseKeypress(Buffer.from('\x1bOP')).name, 'f1');
    assert.strictEqual(parseKeypress(Buffer.from('\x1bOQ')).name, 'f2');
  });

  it('parses alt+key combinations', () => {
    const event = parseKeypress(Buffer.from('\x1ba'));
    assert.strictEqual(event.name, 'alt-a');
    assert.strictEqual(event.alt, true);
  });

  it('parses page up/down', () => {
    assert.strictEqual(parseKeypress(Buffer.from('\x1b[5~')).name, 'pageup');
    assert.strictEqual(parseKeypress(Buffer.from('\x1b[6~')).name, 'pagedown');
  });

  it('parses home/end', () => {
    assert.strictEqual(parseKeypress(Buffer.from('\x1b[H')).name, 'home');
    assert.strictEqual(parseKeypress(Buffer.from('\x1b[F')).name, 'end');
  });
});

describe('keyToAction', () => {
  it('maps arrow keys to scroll actions', () => {
    assert.strictEqual(keyToAction(parseKeypress(Buffer.from('\x1b[A'))), 'scroll_up');
    assert.strictEqual(keyToAction(parseKeypress(Buffer.from('\x1b[B'))), 'scroll_down');
  });

  it('maps tab to focus_next', () => {
    assert.strictEqual(keyToAction(parseKeypress(Buffer.from('\t'))), 'focus_next');
  });

  it('maps y/n to approve/deny', () => {
    assert.strictEqual(keyToAction(parseKeypress(Buffer.from('y'))), 'approve');
    assert.strictEqual(keyToAction(parseKeypress(Buffer.from('n'))), 'deny');
  });

  it('maps q and ctrl-c to quit', () => {
    assert.strictEqual(keyToAction(parseKeypress(Buffer.from('q'))), 'quit');
    assert.strictEqual(keyToAction(parseKeypress(Buffer.from('\x03'))), 'quit');
  });

  it('maps ? to help', () => {
    assert.strictEqual(keyToAction(parseKeypress(Buffer.from('?'))), 'help');
  });

  it('maps space to toggle_expand', () => {
    assert.strictEqual(keyToAction(parseKeypress(Buffer.from(' '))), 'toggle_expand');
  });
});
