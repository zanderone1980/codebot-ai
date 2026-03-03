/**
 * CodeBot AI — TUI Layout Engine
 *
 * Panel-based terminal layout system. Manages screen regions,
 * content scrolling, focus, and rendering. Designed for the
 * TUI mode where agent activity is displayed in organized panels.
 *
 * ZERO external dependencies — uses only Node.js built-in modules.
 */

import { Screen, getTerminalSize, stripAnsi, moveTo, clearLine } from './screen';

/** Panel position on screen (absolute coordinates) */
export interface PanelPosition {
  top: number;
  left: number;
  width: number;
  height: number;
}

/** A single panel in the layout */
export interface Panel {
  id: string;
  title: string;
  content: string[];
  scrollOffset: number;
  focused: boolean;
  position: PanelPosition;
  border: boolean;
  maxScrollback: number;
}

/** Layout configuration for pre-defined arrangements */
export interface LayoutConfig {
  /** Split ratio for left/right panels (0-1, where 0.5 = equal) */
  splitRatio: number;
  /** Height of the status bar (bottom row) */
  statusBarHeight: number;
  /** Height of the bottom panel (diff/output) */
  bottomPanelHeight: number;
  /** Whether to show borders between panels */
  showBorders: boolean;
}

const DEFAULT_CONFIG: LayoutConfig = {
  splitRatio: 0.4,
  statusBarHeight: 1,
  bottomPanelHeight: 8,
  showBorders: true,
};

/** Box-drawing characters */
const BOX = {
  tl: '\u250c', tr: '\u2510', bl: '\u2514', br: '\u2518',
  h: '\u2500', v: '\u2502',
  lt: '\u251c', rt: '\u2524',
  tt: '\u252c', bt: '\u2534', cross: '\u253c',
};

const ANSI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  cyan: '\x1b[36m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  white: '\x1b[37m',
  inverse: '\x1b[7m',
};

/**
 * LayoutEngine — manages panels and rendering.
 */
export class LayoutEngine {
  private panels: Map<string, Panel> = new Map();
  private focusOrder: string[] = [];
  private focusIndex: number = 0;
  private screen: Screen;
  private config: LayoutConfig;
  private statusText: string = '';

  constructor(config?: Partial<LayoutConfig>) {
    this.config = { ...DEFAULT_CONFIG, ...config };
    this.screen = new Screen();
  }

  /** Add a panel to the layout */
  addPanel(id: string, title: string, opts?: { border?: boolean; maxScrollback?: number }): void {
    const panel: Panel = {
      id,
      title,
      content: [],
      scrollOffset: 0,
      focused: this.panels.size === 0, // First panel gets focus
      position: { top: 0, left: 0, width: 0, height: 0 },
      border: opts?.border ?? true,
      maxScrollback: opts?.maxScrollback ?? 1000,
    };
    this.panels.set(id, panel);
    this.focusOrder.push(id);
    this.recalculatePositions();
  }

  /** Remove a panel */
  removePanel(id: string): void {
    this.panels.delete(id);
    this.focusOrder = this.focusOrder.filter(fid => fid !== id);
    if (this.focusIndex >= this.focusOrder.length) {
      this.focusIndex = Math.max(0, this.focusOrder.length - 1);
    }
    this.recalculatePositions();
  }

  /** Get a panel by ID */
  getPanel(id: string): Panel | undefined {
    return this.panels.get(id);
  }

  /** Replace all content of a panel */
  updateContent(id: string, lines: string[]): void {
    const panel = this.panels.get(id);
    if (!panel) return;
    panel.content = lines.slice(-panel.maxScrollback);
    // Auto-scroll to bottom
    const viewHeight = this.getViewHeight(panel);
    if (panel.content.length > viewHeight) {
      panel.scrollOffset = panel.content.length - viewHeight;
    }
  }

  /** Append a single line to a panel (auto-scrolls) */
  appendLine(id: string, line: string): void {
    const panel = this.panels.get(id);
    if (!panel) return;
    panel.content.push(line);
    // Trim scrollback
    if (panel.content.length > panel.maxScrollback) {
      const excess = panel.content.length - panel.maxScrollback;
      panel.content.splice(0, excess);
      panel.scrollOffset = Math.max(0, panel.scrollOffset - excess);
    }
    // Auto-scroll to bottom
    const viewHeight = this.getViewHeight(panel);
    if (panel.content.length > viewHeight) {
      panel.scrollOffset = panel.content.length - viewHeight;
    }
  }

  /** Scroll a panel up/down */
  scroll(id: string, delta: number): void {
    const panel = this.panels.get(id);
    if (!panel) return;
    const viewHeight = this.getViewHeight(panel);
    const maxScroll = Math.max(0, panel.content.length - viewHeight);
    panel.scrollOffset = Math.max(0, Math.min(maxScroll, panel.scrollOffset + delta));
  }

  /** Focus a specific panel by ID */
  focus(id: string): void {
    for (const [pid, panel] of this.panels) {
      panel.focused = pid === id;
    }
    const idx = this.focusOrder.indexOf(id);
    if (idx >= 0) this.focusIndex = idx;
  }

  /** Cycle focus to next panel */
  focusNext(): void {
    if (this.focusOrder.length === 0) return;
    this.focusIndex = (this.focusIndex + 1) % this.focusOrder.length;
    const nextId = this.focusOrder[this.focusIndex];
    this.focus(nextId);
  }

  /** Cycle focus to previous panel */
  focusPrev(): void {
    if (this.focusOrder.length === 0) return;
    this.focusIndex = (this.focusIndex - 1 + this.focusOrder.length) % this.focusOrder.length;
    const prevId = this.focusOrder[this.focusIndex];
    this.focus(prevId);
  }

  /** Get the currently focused panel ID */
  getFocusedId(): string | undefined {
    return this.focusOrder[this.focusIndex];
  }

  /** Set the status bar text */
  setStatus(text: string): void {
    this.statusText = text;
  }

  /** Recalculate panel positions based on terminal size */
  resize(): void {
    this.recalculatePositions();
  }

  /** Get all panel IDs */
  getPanelIds(): string[] {
    return [...this.panels.keys()];
  }

  /** Get panel count */
  get panelCount(): number {
    return this.panels.size;
  }

  /**
   * Render the full layout to screen.
   * Draws borders, titles, content, scroll indicators, and status bar.
   */
  render(): string {
    const { rows, cols } = getTerminalSize();
    const output: string[] = [];

    // Render each panel
    for (const panel of this.panels.values()) {
      output.push(this.renderPanel(panel, cols));
    }

    // Render status bar
    output.push(this.renderStatusBar(rows, cols));

    return output.join('');
  }

  /** Flush render to screen (for live use) */
  renderToScreen(): void {
    this.screen.clear();
    this.screen.write(this.render());
    this.screen.flush();
  }

  /** Get the Screen instance for enter/exit */
  getScreen(): Screen {
    return this.screen;
  }

  // ── Private methods ──

  private getViewHeight(panel: Panel): number {
    // Available lines for content (subtract border top + bottom if bordered)
    return panel.border ? panel.position.height - 2 : panel.position.height;
  }

  private recalculatePositions(): void {
    const { rows, cols } = getTerminalSize();
    const ids = [...this.panels.keys()];
    const count = ids.length;

    if (count === 0) return;

    const statusH = this.config.statusBarHeight;
    const availableH = rows - statusH;

    if (count === 1) {
      // Single panel: full screen minus status bar
      const panel = this.panels.get(ids[0])!;
      panel.position = { top: 1, left: 1, width: cols, height: availableH };
    } else if (count === 2) {
      // Two panels: left/right split
      const leftW = Math.floor(cols * this.config.splitRatio);
      const rightW = cols - leftW;

      const p1 = this.panels.get(ids[0])!;
      p1.position = { top: 1, left: 1, width: leftW, height: availableH };

      const p2 = this.panels.get(ids[1])!;
      p2.position = { top: 1, left: leftW + 1, width: rightW, height: availableH };
    } else if (count === 3) {
      // Three panels: left column + right column (top/bottom)
      const leftW = Math.floor(cols * this.config.splitRatio);
      const rightW = cols - leftW;
      const bottomH = this.config.bottomPanelHeight;
      const topH = availableH - bottomH;

      const p1 = this.panels.get(ids[0])!;
      p1.position = { top: 1, left: 1, width: leftW, height: availableH };

      const p2 = this.panels.get(ids[1])!;
      p2.position = { top: 1, left: leftW + 1, width: rightW, height: topH };

      const p3 = this.panels.get(ids[2])!;
      p3.position = { top: topH + 1, left: leftW + 1, width: rightW, height: bottomH };
    } else {
      // 4+ panels: grid layout (2x2)
      const halfW = Math.floor(cols / 2);
      const halfH = Math.floor(availableH / 2);
      let idx = 0;
      for (const id of ids) {
        const panel = this.panels.get(id)!;
        const gridRow = Math.floor(idx / 2);
        const gridCol = idx % 2;
        panel.position = {
          top: gridRow * halfH + 1,
          left: gridCol * halfW + 1,
          width: gridCol === 1 ? cols - halfW : halfW,
          height: gridRow === 1 ? availableH - halfH : halfH,
        };
        idx++;
        if (idx >= 4) break; // Max 4 panels in grid
      }
    }
  }

  private renderPanel(panel: Panel, _totalCols: number): string {
    const { top, left, width, height } = panel.position;
    const out: string[] = [];

    if (!panel.border) {
      // No border: just render content lines
      const viewH = height;
      const visible = panel.content.slice(panel.scrollOffset, panel.scrollOffset + viewH);
      for (let i = 0; i < viewH; i++) {
        const line = visible[i] || '';
        const truncated = this.truncateLine(line, width);
        out.push(`${moveTo(top + i, left)}${truncated}${clearLine()}`);
      }
      return out.join('');
    }

    // Bordered panel
    const borderColor = panel.focused ? ANSI.cyan : ANSI.dim;
    const titleColor = panel.focused ? ANSI.bold : ANSI.dim;
    const contentW = width - 2; // Subtract left + right border
    const contentH = height - 2; // Subtract top + bottom border

    // Top border with title
    const titleStr = ` ${panel.title} `;
    const titleVisLen = stripAnsi(titleStr).length;
    const hRepeat = Math.max(0, contentW - titleVisLen);
    out.push(
      `${moveTo(top, left)}${borderColor}${BOX.tl}${ANSI.reset}${titleColor}${titleStr}${ANSI.reset}${borderColor}${BOX.h.repeat(hRepeat)}${BOX.tr}${ANSI.reset}`
    );

    // Content rows
    const visible = panel.content.slice(panel.scrollOffset, panel.scrollOffset + contentH);
    for (let i = 0; i < contentH; i++) {
      const line = visible[i] || '';
      const truncated = this.truncateLine(line, contentW);
      const padLen = Math.max(0, contentW - stripAnsi(truncated).length);
      out.push(
        `${moveTo(top + 1 + i, left)}${borderColor}${BOX.v}${ANSI.reset}${truncated}${' '.repeat(padLen)}${borderColor}${BOX.v}${ANSI.reset}`
      );
    }

    // Bottom border with scroll indicator
    const totalLines = panel.content.length;
    const scrollInfo = totalLines > contentH
      ? ` ${panel.scrollOffset + 1}-${Math.min(panel.scrollOffset + contentH, totalLines)}/${totalLines} `
      : '';
    const scrollLen = scrollInfo.length;
    const bottomH = Math.max(0, contentW - scrollLen);
    out.push(
      `${moveTo(top + height - 1, left)}${borderColor}${BOX.bl}${BOX.h.repeat(bottomH)}${ANSI.dim}${scrollInfo}${borderColor}${BOX.br}${ANSI.reset}`
    );

    return out.join('');
  }

  private renderStatusBar(rows: number, cols: number): string {
    const barY = rows;
    const text = this.statusText || 'Tab: switch panel | ↑↓: scroll | y: approve | n: deny | q: quit';
    const padded = stripAnsi(text).length < cols
      ? text + ' '.repeat(cols - stripAnsi(text).length)
      : text;
    return `${moveTo(barY, 1)}${ANSI.inverse}${this.truncateLine(padded, cols)}${ANSI.reset}`;
  }

  private truncateLine(line: string, maxWidth: number): string {
    const visible = stripAnsi(line);
    if (visible.length <= maxWidth) return line;

    // We need to truncate respecting ANSI codes
    let visCount = 0;
    let result = '';
    let inEsc = false;

    for (let i = 0; i < line.length; i++) {
      const ch = line[i];

      if (ch === '\x1b') {
        inEsc = true;
        result += ch;
        continue;
      }

      if (inEsc) {
        result += ch;
        if (ch === 'm') inEsc = false;
        continue;
      }

      if (visCount >= maxWidth - 1) {
        result += '\u2026'; // ellipsis
        break;
      }

      result += ch;
      visCount++;
    }

    return result + ANSI.reset;
  }
}
