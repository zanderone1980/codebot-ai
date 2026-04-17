/**
 * Minimal leveled logger for library-internal diagnostics.
 *
 * Why this exists: the codebase had 20+ `console.warn(...)` calls in
 * library init paths (agent.ts, plugins.ts, mcp.ts, tools/index.ts,
 * policy.ts, history.ts) that fire on every CLI invocation when any
 * subsystem is misconfigured. Users can't silence them, can't redirect
 * them, and they pollute script output.
 *
 * Solution: route them through a single module that honours
 * `CODEBOT_LOG_LEVEL`. Default is `warn` (current behavior preserved).
 * `CODEBOT_LOG_LEVEL=error` quiets init warnings. `silent` kills
 * everything including errors (for CI/piped output). `debug` adds
 * verbose traces.
 *
 * CLI-facing output (banners, status lines, command results) stays on
 * `console.log` — that's UX, not noise, and `--quiet` in the CLI layer
 * handles it separately.
 */

export type LogLevel = 'silent' | 'error' | 'warn' | 'info' | 'debug';

const LEVELS: Record<LogLevel, number> = {
  silent: 0,
  error: 1,
  warn: 2,
  info: 3,
  debug: 4,
};

function readLevel(): LogLevel {
  const raw = (process.env.CODEBOT_LOG_LEVEL || '').toLowerCase();
  if (raw in LEVELS) return raw as LogLevel;
  return 'warn'; // default preserves pre-logger behavior
}

let currentLevel: LogLevel = readLevel();

export function setLogLevel(level: LogLevel): void {
  currentLevel = level;
}

export function getLogLevel(): LogLevel {
  return currentLevel;
}

function shouldLog(level: LogLevel): boolean {
  return LEVELS[level] <= LEVELS[currentLevel];
}

/** Re-read CODEBOT_LOG_LEVEL (useful if env changes mid-process). */
export function refreshLogLevel(): void {
  currentLevel = readLevel();
}

export const log = {
  debug(...args: unknown[]): void {
    if (shouldLog('debug')) console.error('[CodeBot:debug]', ...args);
  },
  info(...args: unknown[]): void {
    if (shouldLog('info')) console.error('[CodeBot]', ...args);
  },
  warn(...args: unknown[]): void {
    if (shouldLog('warn')) console.warn(...args);
  },
  error(...args: unknown[]): void {
    if (shouldLog('error')) console.error(...args);
  },
};
