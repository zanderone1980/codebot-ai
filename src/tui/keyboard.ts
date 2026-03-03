/**
 * CodeBot AI — TUI Keyboard Input Handler
 *
 * Parses raw terminal input into structured key events.
 * Handles arrow keys, function keys, ctrl combos, and common shortcuts.
 *
 * ZERO external dependencies — uses only Node.js built-in modules.
 */

export interface KeyEvent {
  name: string;          // Human-readable key name
  sequence: string;      // Raw escape sequence
  ctrl: boolean;
  shift: boolean;
  alt: boolean;
}

/** Map of escape sequences to key names */
const ESCAPE_MAP: Record<string, string> = {
  '\x1b[A': 'up',
  '\x1b[B': 'down',
  '\x1b[C': 'right',
  '\x1b[D': 'left',
  '\x1b[H': 'home',
  '\x1b[F': 'end',
  '\x1b[5~': 'pageup',
  '\x1b[6~': 'pagedown',
  '\x1b[2~': 'insert',
  '\x1b[3~': 'delete',
  '\x1bOP': 'f1',
  '\x1bOQ': 'f2',
  '\x1bOR': 'f3',
  '\x1bOS': 'f4',
  '\x1b[15~': 'f5',
  '\x1b[17~': 'f6',
  '\x1b[18~': 'f7',
  '\x1b[19~': 'f8',
  '\x1b[20~': 'f9',
  '\x1b[21~': 'f10',
  '\x1b[23~': 'f11',
  '\x1b[24~': 'f12',
  '\x1b[1;2A': 'shift-up',
  '\x1b[1;2B': 'shift-down',
  '\x1b[1;2C': 'shift-right',
  '\x1b[1;2D': 'shift-left',
  '\x1b[1;5A': 'ctrl-up',
  '\x1b[1;5B': 'ctrl-down',
  '\x1b[1;5C': 'ctrl-right',
  '\x1b[1;5D': 'ctrl-left',
};

/** Parse a raw buffer from stdin into a KeyEvent */
export function parseKeypress(data: Buffer): KeyEvent {
  const seq = data.toString('utf-8');

  // Check escape sequence map
  const mapped = ESCAPE_MAP[seq];
  if (mapped) {
    return {
      name: mapped,
      sequence: seq,
      ctrl: mapped.startsWith('ctrl-'),
      shift: mapped.startsWith('shift-'),
      alt: false,
    };
  }

  // Single escape = escape key
  if (seq === '\x1b') {
    return { name: 'escape', sequence: seq, ctrl: false, shift: false, alt: false };
  }

  // Alt+key (escape + printable character)
  if (seq.length === 2 && seq[0] === '\x1b' && seq.charCodeAt(1) >= 32) {
    return { name: `alt-${seq[1]}`, sequence: seq, ctrl: false, shift: false, alt: true };
  }

  // Enter
  if (seq === '\r' || seq === '\n') {
    return { name: 'enter', sequence: seq, ctrl: false, shift: false, alt: false };
  }

  // Tab
  if (seq === '\t') {
    return { name: 'tab', sequence: seq, ctrl: false, shift: false, alt: false };
  }

  // Backspace
  if (seq === '\x7f' || seq === '\x08') {
    return { name: 'backspace', sequence: seq, ctrl: false, shift: false, alt: false };
  }

  // Ctrl+C
  if (seq === '\x03') {
    return { name: 'ctrl-c', sequence: seq, ctrl: true, shift: false, alt: false };
  }

  // Ctrl+D
  if (seq === '\x04') {
    return { name: 'ctrl-d', sequence: seq, ctrl: true, shift: false, alt: false };
  }

  // Ctrl+Z
  if (seq === '\x1a') {
    return { name: 'ctrl-z', sequence: seq, ctrl: true, shift: false, alt: false };
  }

  // Ctrl+L (clear screen)
  if (seq === '\x0c') {
    return { name: 'ctrl-l', sequence: seq, ctrl: true, shift: false, alt: false };
  }

  // Space
  if (seq === ' ') {
    return { name: 'space', sequence: seq, ctrl: false, shift: false, alt: false };
  }

  // Other ctrl characters (a=1, b=2, ..., z=26)
  if (seq.length === 1 && seq.charCodeAt(0) >= 1 && seq.charCodeAt(0) <= 26) {
    const letter = String.fromCharCode(seq.charCodeAt(0) + 96);
    return { name: `ctrl-${letter}`, sequence: seq, ctrl: true, shift: false, alt: false };
  }

  // Regular printable character
  if (seq.length === 1 && seq.charCodeAt(0) >= 32 && seq.charCodeAt(0) < 127) {
    const isUpper = seq >= 'A' && seq <= 'Z';
    return {
      name: seq.toLowerCase(),
      sequence: seq,
      ctrl: false,
      shift: isUpper,
      alt: false,
    };
  }

  // Unknown sequence
  return { name: 'unknown', sequence: seq, ctrl: false, shift: false, alt: false };
}

/** TUI action names for common shortcuts */
export type TuiAction =
  | 'scroll_up' | 'scroll_down' | 'scroll_left' | 'scroll_right'
  | 'focus_next' | 'focus_prev'
  | 'approve' | 'deny' | 'skip' | 'retry'
  | 'quit' | 'help' | 'toggle_expand'
  | 'enter' | 'escape' | 'unknown';

/** Map a KeyEvent to a TUI action */
export function keyToAction(event: KeyEvent): TuiAction {
  switch (event.name) {
    case 'up': return 'scroll_up';
    case 'down': return 'scroll_down';
    case 'left': return 'scroll_left';
    case 'right': return 'scroll_right';
    case 'tab': return 'focus_next';
    case 'shift-tab': return 'focus_prev';
    case 'y': return 'approve';
    case 'n': return 'deny';
    case 's': return 'skip';
    case 'r': return 'retry';
    case 'q': return 'quit';
    case 'ctrl-c': return 'quit';
    case 'ctrl-d': return 'quit';
    case '?': return 'help';
    case 'h': return 'help';
    case 'space': return 'toggle_expand';
    case 'enter': return 'enter';
    case 'escape': return 'escape';
    default: return 'unknown';
  }
}

/**
 * Create a keyboard listener that reads from raw stdin.
 * Returns an async generator of KeyEvents.
 * Call cleanup() to restore terminal state.
 */
export function createKeyboardListener(): {
  events: AsyncGenerator<KeyEvent>;
  cleanup: () => void;
} {
  const stdin = process.stdin;
  let wasRaw = false;

  // Enable raw mode for character-at-a-time input
  if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
    wasRaw = stdin.isRaw || false;
    stdin.setRawMode(true);
  }
  stdin.resume();

  // Event queue for the async generator
  let resolveNext: ((value: IteratorResult<KeyEvent>) => void) | null = null;
  const queue: KeyEvent[] = [];
  let done = false;

  const onData = (data: Buffer) => {
    const event = parseKeypress(data);
    if (resolveNext) {
      const resolve = resolveNext;
      resolveNext = null;
      resolve({ value: event, done: false });
    } else {
      queue.push(event);
    }
  };

  stdin.on('data', onData);

  const cleanup = () => {
    done = true;
    stdin.removeListener('data', onData);
    if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
      stdin.setRawMode(wasRaw);
    }
    stdin.pause();
    // Resolve any pending promise
    if (resolveNext) {
      resolveNext({ value: undefined as unknown as KeyEvent, done: true });
      resolveNext = null;
    }
  };

  async function* generator(): AsyncGenerator<KeyEvent> {
    while (!done) {
      if (queue.length > 0) {
        yield queue.shift()!;
      } else {
        const event = await new Promise<IteratorResult<KeyEvent>>(resolve => {
          resolveNext = resolve;
        });
        if (event.done) return;
        yield event.value;
      }
    }
  }

  return { events: generator(), cleanup };
}
