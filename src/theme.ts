/**
 * CodeBot AI — Theme System (v2.3.0)
 *
 * Centralized color and symbol management. Supports dark, light, and mono themes.
 * Respects NO_COLOR env var and dumb terminal detection.
 *
 * ZERO external dependencies.
 */

import * as fs from 'fs';
import * as path from 'path';
import { codebotPath } from './paths';

// ── Theme Interface ──

export interface Theme {
  name: string;
  colors: {
    // Semantic roles
    primary: string;
    secondary: string;
    success: string;
    warning: string;
    danger: string;
    info: string;
    muted: string;

    // UI elements
    border: string;
    text: string;
    textDim: string;
    heading: string;
    highlight: string;

    // Syntax / diffs
    added: string;
    removed: string;
    changed: string;

    // Risk levels
    riskLow: string;
    riskMedium: string;
    riskHigh: string;
    riskCritical: string;

    // Formatting
    reset: string;
    bold: string;
    dim: string;
    italic: string;
  };
  symbols: {
    check: string;
    cross: string;
    warning: string;
    arrow: string;
    spinner: string[];
    border: {
      tl: string; tr: string; bl: string; br: string;
      h: string; v: string; lt: string; rt: string;
    };
  };
}

// ── Dark Theme (default — current CodeBot colors) ──

export const DARK_THEME: Theme = {
  name: 'dark',
  colors: {
    primary: '\x1b[36m',       // cyan
    secondary: '\x1b[34m',     // blue
    success: '\x1b[32m',       // green
    warning: '\x1b[33m',       // yellow
    danger: '\x1b[31m',        // red
    info: '\x1b[96m',          // bright cyan
    muted: '\x1b[90m',         // gray

    border: '\x1b[36m',        // cyan
    text: '\x1b[37m',          // white
    textDim: '\x1b[2m',        // dim
    heading: '\x1b[1m',        // bold
    highlight: '\x1b[35m',     // magenta

    added: '\x1b[32m',         // green
    removed: '\x1b[31m',       // red
    changed: '\x1b[33m',       // yellow

    riskLow: '\x1b[32m',       // green
    riskMedium: '\x1b[33m',    // yellow
    riskHigh: '\x1b[38;5;208m', // orange
    riskCritical: '\x1b[31m',  // red

    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    italic: '\x1b[3m',
  },
  symbols: {
    check: '\u2713',
    cross: '\u2717',
    warning: '\u26a0',
    arrow: '\u25b6',
    spinner: ['\u280b', '\u2819', '\u2839', '\u2838', '\u283c', '\u2834', '\u2826', '\u2827', '\u2807', '\u280f'],
    border: {
      tl: '\u250c', tr: '\u2510', bl: '\u2514', br: '\u2518',
      h: '\u2500', v: '\u2502', lt: '\u251c', rt: '\u2524',
    },
  },
};

// ── Light Theme (for light terminal backgrounds) ──

export const LIGHT_THEME: Theme = {
  name: 'light',
  colors: {
    primary: '\x1b[34m',       // blue (more visible on light bg)
    secondary: '\x1b[36m',     // cyan
    success: '\x1b[32m',       // green
    warning: '\x1b[33m',       // yellow
    danger: '\x1b[31m',        // red
    info: '\x1b[34m',          // blue
    muted: '\x1b[90m',         // gray

    border: '\x1b[34m',        // blue
    text: '\x1b[30m',          // black
    textDim: '\x1b[2m',        // dim
    heading: '\x1b[1m',        // bold
    highlight: '\x1b[35m',     // magenta

    added: '\x1b[32m',
    removed: '\x1b[31m',
    changed: '\x1b[33m',

    riskLow: '\x1b[32m',
    riskMedium: '\x1b[33m',
    riskHigh: '\x1b[38;5;208m',
    riskCritical: '\x1b[31m',

    reset: '\x1b[0m',
    bold: '\x1b[1m',
    dim: '\x1b[2m',
    italic: '\x1b[3m',
  },
  symbols: DARK_THEME.symbols, // same symbols
};

// ── Mono Theme (no color, ASCII borders — for CI, NO_COLOR, dumb terminals) ──

export const MONO_THEME: Theme = {
  name: 'mono',
  colors: {
    primary: '', secondary: '', success: '', warning: '', danger: '',
    info: '', muted: '', border: '', text: '', textDim: '', heading: '',
    highlight: '', added: '', removed: '', changed: '',
    riskLow: '', riskMedium: '', riskHigh: '', riskCritical: '',
    reset: '', bold: '', dim: '', italic: '',
  },
  symbols: {
    check: '[OK]',
    cross: '[FAIL]',
    warning: '[WARN]',
    arrow: '>',
    spinner: ['-', '\\', '|', '/'],
    border: {
      tl: '+', tr: '+', bl: '+', br: '+',
      h: '-', v: '|', lt: '+', rt: '+',
    },
  },
};

// ── Theme Management (Singleton) ──

const THEMES: Record<string, Theme> = {
  dark: DARK_THEME,
  light: LIGHT_THEME,
  mono: MONO_THEME,
};

let currentTheme: Theme = DARK_THEME;

/** Check if the environment requests no color */
function shouldUseMono(): boolean {
  // NO_COLOR standard: https://no-color.org/
  if (process.env.NO_COLOR !== undefined) return true;
  // Dumb terminal
  if (process.env.TERM === 'dumb') return true;
  // CI environments without color support
  if (!process.stdout.isTTY && !process.env.FORCE_COLOR) return true;
  return false;
}

/** Load a theme by name. Falls back to dark. Auto-detects mono. */
export function loadTheme(name?: string): Theme {
  if (shouldUseMono() && name !== 'dark' && name !== 'light') {
    return MONO_THEME;
  }
  if (name && THEMES[name]) {
    return THEMES[name];
  }
  // Try loading from config
  if (!name) {
    try {
      const configPath = codebotPath('config.json');
      if (fs.existsSync(configPath)) {
        const config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
        if (config.theme && THEMES[config.theme]) {
          return THEMES[config.theme];
        }
      }
    } catch {
      // Config read failed
    }
  }
  // Check env
  const envTheme = process.env.CODEBOT_THEME;
  if (envTheme && THEMES[envTheme]) {
    return THEMES[envTheme];
  }
  return DARK_THEME;
}

/** Set the current theme */
export function setTheme(theme: Theme): void {
  currentTheme = theme;
}

/** Get the current theme */
export function getTheme(): Theme {
  return currentTheme;
}

/** Apply a color from the current theme to text */
export function applyColor(text: string, color: string): string {
  if (!color) return text;
  return `${color}${text}${currentTheme.colors.reset}`;
}

/** Get list of available theme names */
export function getThemeNames(): string[] {
  return Object.keys(THEMES);
}

// Initialize theme on module load
if (shouldUseMono()) {
  currentTheme = MONO_THEME;
}
