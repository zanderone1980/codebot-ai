/**
 * CodeBot AI — TUI Screen Abstraction
 *
 * Raw ANSI escape code helpers for terminal manipulation.
 * Provides cursor control, alternate screen buffer, and styled writing.
 *
 * ZERO external dependencies — uses only Node.js built-in modules.
 */

const ESC = '\x1b';
const CSI = `${ESC}[`;

/** Move cursor to absolute position (1-based) */
export function moveTo(row: number, col: number): string {
  return `${CSI}${row};${col}H`;
}

/** Move cursor up N rows */
export function moveUp(n: number = 1): string {
  return `${CSI}${n}A`;
}

/** Move cursor down N rows */
export function moveDown(n: number = 1): string {
  return `${CSI}${n}B`;
}

/** Move cursor right N columns */
export function moveRight(n: number = 1): string {
  return `${CSI}${n}C`;
}

/** Move cursor left N columns */
export function moveLeft(n: number = 1): string {
  return `${CSI}${n}D`;
}

/** Clear entire screen */
export function clearScreen(): string {
  return `${CSI}2J`;
}

/** Clear from cursor to end of line */
export function clearLine(): string {
  return `${CSI}K`;
}

/** Clear entire line */
export function clearFullLine(): string {
  return `${CSI}2K`;
}

/** Hide the cursor */
export function hideCursor(): string {
  return `${CSI}?25l`;
}

/** Show the cursor */
export function showCursor(): string {
  return `${CSI}?25h`;
}

/** Enter alternate screen buffer (preserves main terminal) */
export function enterAltScreen(): string {
  return `${CSI}?1049h`;
}

/** Exit alternate screen buffer (restores main terminal) */
export function exitAltScreen(): string {
  return `${CSI}?1049l`;
}

/** Save cursor position */
export function saveCursor(): string {
  return `${ESC}7`;
}

/** Restore cursor position */
export function restoreCursor(): string {
  return `${ESC}8`;
}

/** Enable mouse tracking (button events) */
export function enableMouse(): string {
  return `${CSI}?1000h${CSI}?1006h`;
}

/** Disable mouse tracking */
export function disableMouse(): string {
  return `${CSI}?1000l${CSI}?1006l`;
}

/** Strip ANSI escape codes to get visual width */
export function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Get terminal dimensions */
export function getTerminalSize(): { rows: number; cols: number } {
  return {
    rows: process.stdout.rows || 24,
    cols: process.stdout.columns || 80,
  };
}

/**
 * Screen class — buffered writing to terminal.
 * Collects output operations and flushes them all at once
 * to avoid flickering.
 */
export class Screen {
  private buffer: string[] = [];

  /** Queue a write at an absolute position */
  writeAt(row: number, col: number, text: string): void {
    this.buffer.push(`${moveTo(row, col)}${text}`);
  }

  /** Queue a raw string write */
  write(text: string): void {
    this.buffer.push(text);
  }

  /** Queue a clear + move to top-left */
  clear(): void {
    this.buffer.push(clearScreen());
    this.buffer.push(moveTo(1, 1));
  }

  /** Flush all queued writes to stdout at once */
  flush(): void {
    if (this.buffer.length > 0) {
      process.stdout.write(this.buffer.join(''));
      this.buffer = [];
    }
  }

  /** Enter alt screen and hide cursor */
  enter(): void {
    process.stdout.write(enterAltScreen() + hideCursor());
  }

  /** Exit alt screen and show cursor */
  exit(): void {
    process.stdout.write(showCursor() + exitAltScreen());
  }

  /** Get terminal size */
  size(): { rows: number; cols: number } {
    return getTerminalSize();
  }
}
