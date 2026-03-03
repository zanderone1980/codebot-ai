import { describe, it } from 'node:test';
import * as assert from 'node:assert';
import { DARK_THEME, LIGHT_THEME, MONO_THEME, loadTheme, setTheme, getTheme, applyColor, getThemeNames } from './theme';

describe('Theme System', () => {
  it('DARK_THEME has all required color keys', () => {
    const requiredKeys = ['primary', 'secondary', 'success', 'warning', 'danger', 'info', 'muted',
      'border', 'text', 'textDim', 'heading', 'highlight', 'added', 'removed', 'changed',
      'riskLow', 'riskMedium', 'riskHigh', 'riskCritical', 'reset', 'bold', 'dim', 'italic'];
    for (const key of requiredKeys) {
      assert.ok(key in DARK_THEME.colors, `DARK_THEME missing color: ${key}`);
      assert.strictEqual(typeof (DARK_THEME.colors as Record<string, string>)[key], 'string');
    }
  });

  it('MONO_THEME has no ANSI escape codes', () => {
    for (const [key, value] of Object.entries(MONO_THEME.colors)) {
      assert.ok(!value.includes('\x1b'), `MONO_THEME color ${key} should have no ANSI: "${value}"`);
    }
  });

  it('MONO_THEME uses ASCII borders', () => {
    assert.strictEqual(MONO_THEME.symbols.border.tl, '+');
    assert.strictEqual(MONO_THEME.symbols.border.h, '-');
    assert.strictEqual(MONO_THEME.symbols.border.v, '|');
  });

  it('setTheme and getTheme round-trip', () => {
    const original = getTheme();
    setTheme(LIGHT_THEME);
    assert.strictEqual(getTheme().name, 'light');
    setTheme(DARK_THEME);
    assert.strictEqual(getTheme().name, 'dark');
    setTheme(original); // restore
  });

  it('loadTheme returns dark by default', () => {
    const theme = loadTheme('dark');
    assert.strictEqual(theme.name, 'dark');
  });

  it('loadTheme returns light theme', () => {
    const theme = loadTheme('light');
    assert.strictEqual(theme.name, 'light');
  });

  it('applyColor wraps text with color codes in dark mode', () => {
    setTheme(DARK_THEME);
    const result = applyColor('hello', DARK_THEME.colors.success);
    assert.ok(result.includes('\x1b[32m'), 'Should include green ANSI code');
    assert.ok(result.includes('hello'), 'Should include text');
    assert.ok(result.includes('\x1b[0m'), 'Should include reset');
  });

  it('applyColor returns raw text when color is empty', () => {
    setTheme(MONO_THEME);
    const result = applyColor('hello', MONO_THEME.colors.success);
    assert.strictEqual(result, 'hello');
  });

  it('getThemeNames returns all available themes', () => {
    const names = getThemeNames();
    assert.ok(names.includes('dark'));
    assert.ok(names.includes('light'));
    assert.ok(names.includes('mono'));
  });

  it('LIGHT_THEME uses dark colors for light backgrounds', () => {
    assert.ok(LIGHT_THEME.colors.primary.includes('\x1b'), 'Should have ANSI codes');
    assert.strictEqual(LIGHT_THEME.name, 'light');
  });
});
