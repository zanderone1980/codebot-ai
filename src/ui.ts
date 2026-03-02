/**
 * CodeBot AI — Reusable UI Components for CLI Output
 *
 * Production-grade terminal rendering: boxes, risk bars, permission cards,
 * spinners, progress steps, diff previews, session headers, and summary boxes.
 *
 * ZERO external dependencies — uses only Node.js built-in modules.
 */

// ── Color Palette ──

export const UI = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
  italic: '\x1b[3m',
  red: '\x1b[31m',
  green: '\x1b[32m',
  yellow: '\x1b[33m',
  blue: '\x1b[34m',
  magenta: '\x1b[35m',
  cyan: '\x1b[36m',
  white: '\x1b[37m',
  orange: '\x1b[38;5;208m',
  brightGreen: '\x1b[92m',
  brightCyan: '\x1b[96m',
  brightYellow: '\x1b[93m',
  gray: '\x1b[90m',
};

// ── Box Drawing Characters ──

export const BOX = {
  tl: '\u250c', tr: '\u2510', bl: '\u2514', br: '\u2518',
  h: '\u2500', v: '\u2502',
  lt: '\u251c', rt: '\u2524',
};

// ── Helpers ──

/** Strip ANSI escape codes to get the visual width of a string */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** Pad a string (based on visual width) to a given length */
function padEnd(s: string, width: number): string {
  const visible = stripAnsi(s).length;
  const padding = Math.max(0, width - visible);
  return s + ' '.repeat(padding);
}

// ── box() ──

/**
 * Draw a bordered box with a title.
 * Auto-calculates width from the longest line if not specified.
 */
export function box(
  title: string,
  lines: string[],
  opts?: { width?: number; color?: string },
): string {
  const color = opts?.color || UI.cyan;
  const contentWidth = opts?.width || Math.max(
    stripAnsi(title).length + 4,
    ...lines.map(l => stripAnsi(l).length + 2),
    40,
  );

  const out: string[] = [];

  // Top border with title
  const titleStr = ` ${title} `;
  const titleLen = stripAnsi(titleStr).length;
  const remainingH = Math.max(0, contentWidth - titleLen - 1);
  out.push(
    `${color}${BOX.tl}${BOX.h}${titleStr}${BOX.h.repeat(remainingH)}${BOX.tr}${UI.reset}`,
  );

  // Content lines
  for (const line of lines) {
    out.push(
      `${color}${BOX.v}${UI.reset} ${padEnd(line, contentWidth - 2)} ${color}${BOX.v}${UI.reset}`,
    );
  }

  // Bottom border
  out.push(
    `${color}${BOX.bl}${BOX.h.repeat(contentWidth)}${BOX.br}${UI.reset}`,
  );

  return out.join('\n');
}

// ── riskBar() ──

/**
 * Render a visual risk bar: filled + empty blocks with score.
 * Color based on score: green (0-25), yellow (26-50), orange (51-75), red (76+).
 */
export function riskBar(score: number, width: number = 10): string {
  const clamped = Math.max(0, Math.min(100, Math.round(score)));
  const filled = Math.round((clamped / 100) * width);
  const empty = width - filled;

  let color: string;
  let label: string;
  if (clamped <= 25) {
    color = UI.green;
    label = 'green';
  } else if (clamped <= 50) {
    color = UI.yellow;
    label = 'yellow';
  } else if (clamped <= 75) {
    color = UI.orange;
    label = 'orange';
  } else {
    color = UI.red;
    label = 'red';
  }

  return `${color}${'▓'.repeat(filled)}${'░'.repeat(empty)}${UI.reset} ${clamped}/100 (${label})`;
}

// ── permissionCard() ──

/**
 * Render a full permission card for tool approval.
 */
export function permissionCard(
  toolName: string,
  args: Record<string, unknown>,
  risk: { score: number; level: string; factors?: Array<{ name: string; rawScore: number; reason: string }> },
  opts?: { sandbox?: boolean; network?: boolean },
): string {
  const width = 48;
  const color = UI.cyan;
  const lines: string[] = [];

  // Title line
  const titleStr = ' PERMISSION REQUIRED ';
  const titleLen = titleStr.length;
  const remainingH = Math.max(0, width - titleLen - 1);
  lines.push(
    `${color}${BOX.tl}${BOX.h}${UI.bold}${titleStr}${UI.reset}${color}${BOX.h.repeat(remainingH)}${BOX.tr}${UI.reset}`,
  );

  // Tool line
  const toolLine = `${UI.dim}Tool:${UI.reset}    ${UI.bold}${toolName}${UI.reset}`;
  lines.push(
    `${color}${BOX.v}${UI.reset} ${padEnd(toolLine, width - 2)} ${color}${BOX.v}${UI.reset}`,
  );

  // Risk line
  const riskBarStr = riskBar(risk.score);
  const riskLine = `${UI.dim}Risk:${UI.reset}    ${riskBarStr}`;
  lines.push(
    `${color}${BOX.v}${UI.reset} ${padEnd(riskLine, width - 2)} ${color}${BOX.v}${UI.reset}`,
  );

  // Risk factors (if any and score > 0)
  if (risk.factors && risk.factors.length > 0 && risk.score > 0) {
    lines.push(
      `${color}${BOX.v}${UI.reset} ${padEnd('', width - 2)} ${color}${BOX.v}${UI.reset}`,
    );
    for (const factor of risk.factors) {
      if (factor.rawScore > 0) {
        const factorStr = `${UI.dim}  ${factor.name}: ${factor.reason}${UI.reset}`;
        lines.push(
          `${color}${BOX.v}${UI.reset} ${padEnd(factorStr, width - 2)} ${color}${BOX.v}${UI.reset}`,
        );
      }
    }
  }

  // Blank separator
  lines.push(
    `${color}${BOX.v}${UI.reset} ${padEnd('', width - 2)} ${color}${BOX.v}${UI.reset}`,
  );

  // Args
  for (const [k, v] of Object.entries(args)) {
    let val: string;
    if (typeof v === 'string') {
      val = v.length > 35 ? v.substring(0, 35) + '...' : v;
    } else {
      const s = JSON.stringify(v);
      val = s.length > 35 ? s.substring(0, 35) + '...' : s;
    }
    const argLine = `${UI.dim}${k}:${UI.reset}${' '.repeat(Math.max(1, 9 - k.length))}${val}`;
    lines.push(
      `${color}${BOX.v}${UI.reset} ${padEnd(argLine, width - 2)} ${color}${BOX.v}${UI.reset}`,
    );
  }

  // Blank separator
  lines.push(
    `${color}${BOX.v}${UI.reset} ${padEnd('', width - 2)} ${color}${BOX.v}${UI.reset}`,
  );

  // Sandbox/network status
  if (opts) {
    const sandboxStr = opts.sandbox
      ? `${UI.brightGreen}\u2713${UI.reset} Docker`
      : `${UI.dim}\u2717 none${UI.reset}`;
    const networkStr = opts.network
      ? `${UI.brightGreen}\u2713${UI.reset} allowed`
      : `${UI.red}\u2717${UI.reset} blocked`;
    const statusLine = `Sandbox: ${sandboxStr} ${UI.dim}|${UI.reset} Network: ${networkStr}`;
    lines.push(
      `${color}${BOX.v}${UI.reset} ${padEnd(statusLine, width - 2)} ${color}${BOX.v}${UI.reset}`,
    );
  }

  // Divider
  lines.push(
    `${color}${BOX.lt}${BOX.h.repeat(width)}${BOX.rt}${UI.reset}`,
  );

  // Action bar
  const actionLine = `${UI.bold}[y]${UI.reset} Allow  ${UI.bold}[n]${UI.reset} Deny  ${UI.bold}[d]${UI.reset} Details`;
  lines.push(
    `${color}${BOX.v}${UI.reset} ${padEnd(actionLine, width - 2)} ${color}${BOX.v}${UI.reset}`,
  );

  // Bottom border
  lines.push(
    `${color}${BOX.bl}${BOX.h.repeat(width)}${BOX.br}${UI.reset}`,
  );

  return '\n' + lines.join('\n') + '\n';
}

// ── spinner() ──

const SPINNER_FRAMES = ['\u280b', '\u2819', '\u2839', '\u2838', '\u283c', '\u2834', '\u2826', '\u2827', '\u2807', '\u280f'];

/**
 * Create a spinner with update() and stop() methods.
 * Uses `\r` to update in place. Shows elapsed time.
 */
export function spinner(label: string): { update(label: string): void; stop(finalLabel: string): void } {
  let currentLabel = label;
  let frameIndex = 0;
  const startTime = Date.now();

  const render = () => {
    const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
    const frame = SPINNER_FRAMES[frameIndex % SPINNER_FRAMES.length];
    process.stdout.write(`\r${UI.cyan}${frame}${UI.reset} ${currentLabel} ${UI.dim}(${elapsed}s)${UI.reset}  `);
    frameIndex++;
  };

  const interval = setInterval(render, 80);
  render(); // Render immediately

  return {
    update(newLabel: string) {
      currentLabel = newLabel;
    },
    stop(finalLabel: string) {
      clearInterval(interval);
      const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
      process.stdout.write(`\r${UI.brightGreen}\u2713${UI.reset} ${finalLabel} ${UI.dim}(${elapsed}s)${UI.reset}  \n`);
    },
  };
}

// ── progressStep() ──

/**
 * Return a formatted progress step string.
 */
export function progressStep(current: number, total: number, label: string): string {
  return `${UI.dim}Step ${current}/${total}:${UI.reset} ${label}`;
}

// ── diffPreview() ──

/**
 * Render a colorized diff preview showing removed/added lines.
 * Shows max N lines (default 20), with truncation message.
 */
export function diffPreview(
  oldContent: string,
  newContent: string,
  filePath: string,
  opts?: { maxLines?: number },
): string {
  const maxLines = opts?.maxLines ?? 20;
  const oldLines = oldContent.split('\n');
  const newLines = newContent.split('\n');

  const out: string[] = [];
  out.push(`${UI.bold}${UI.cyan}--- ${filePath}${UI.reset}`);
  out.push(`${UI.bold}${UI.cyan}+++ ${filePath}${UI.reset}`);

  // Simple line-by-line diff
  const diffLines: string[] = [];
  const maxLen = Math.max(oldLines.length, newLines.length);

  // Build a basic diff using longest common subsequence approach
  // For simplicity, use a line-matching strategy
  const oldSet = new Set(oldLines);
  const newSet = new Set(newLines);

  let oi = 0;
  let ni = 0;

  while (oi < oldLines.length || ni < newLines.length) {
    if (oi < oldLines.length && ni < newLines.length && oldLines[oi] === newLines[ni]) {
      // Context line
      diffLines.push(`${UI.dim} ${oldLines[oi]}${UI.reset}`);
      oi++;
      ni++;
    } else if (oi < oldLines.length && !newSet.has(oldLines[oi])) {
      // Removed line
      diffLines.push(`${UI.red}-${oldLines[oi]}${UI.reset}`);
      oi++;
    } else if (ni < newLines.length && !oldSet.has(newLines[ni])) {
      // Added line
      diffLines.push(`${UI.green}+${newLines[ni]}${UI.reset}`);
      ni++;
    } else if (oi < oldLines.length) {
      diffLines.push(`${UI.red}-${oldLines[oi]}${UI.reset}`);
      oi++;
    } else {
      diffLines.push(`${UI.green}+${newLines[ni]}${UI.reset}`);
      ni++;
    }
  }

  // Apply max lines truncation
  const shownLines = diffLines.slice(0, maxLines);
  out.push(...shownLines);

  if (diffLines.length > maxLines) {
    const remaining = diffLines.length - maxLines;
    out.push(`${UI.dim}... ${remaining} more lines${UI.reset}`);
  }

  return out.join('\n');
}

// ── sessionHeader() ──

/**
 * Render a consistent session context block in a box.
 */
export function sessionHeader(info: {
  version: string;
  model: string;
  provider: string;
  session: string;
  cwd: string;
  branch?: string;
  sandbox?: string;
  policy?: string;
}): string {
  const lines: string[] = [];

  lines.push(`${UI.dim}Model:${UI.reset}    ${info.model}`);
  lines.push(`${UI.dim}Provider:${UI.reset} ${info.provider}`);
  lines.push(`${UI.dim}Session:${UI.reset}  ${info.session}`);
  lines.push(`${UI.dim}CWD:${UI.reset}      ${info.cwd}`);
  if (info.branch) {
    lines.push(`${UI.dim}Branch:${UI.reset}   ${info.branch}`);
  }
  if (info.sandbox || info.policy) {
    const parts: string[] = [];
    if (info.sandbox) parts.push(`Sandbox: ${info.sandbox}`);
    if (info.policy) parts.push(`Policy: ${info.policy}`);
    lines.push(`${UI.dim}${parts.join(' | ')}${UI.reset}`);
  }

  return box(`CodeBot AI v${info.version}`, lines);
}

// ── summaryBox() ──

/**
 * Render the end-of-session summary in a clean box format.
 */
export function summaryBox(stats: {
  duration: string;
  model: string;
  provider: string;
  tokens: string;
  cost: string;
  tools: number;
  files: number;
  risk: number;
}): string {
  const riskColor = stats.risk <= 25
    ? UI.green
    : stats.risk <= 50
      ? UI.yellow
      : stats.risk <= 75
        ? UI.orange
        : UI.red;

  const lines: string[] = [
    `${UI.dim}Duration:${UI.reset} ${stats.duration}`,
    `${UI.dim}Model:${UI.reset}    ${stats.model} via ${stats.provider}`,
    `${UI.dim}Tokens:${UI.reset}   ${stats.tokens}`,
    `${UI.dim}Cost:${UI.reset}     ${stats.cost}`,
    `${UI.dim}Tools:${UI.reset}    ${stats.tools} calls`,
    `${UI.dim}Files:${UI.reset}    ${stats.files} modified`,
    `${UI.dim}Risk:${UI.reset}     ${riskColor}avg ${stats.risk}/100${UI.reset}`,
  ];

  return box('Session Summary', lines);
}
