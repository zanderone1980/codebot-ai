/**
 * CodeBot AI mascot and CLI banner.
 *
 * Mascot name: Codi
 * Personality: A cyberpunk AI that lives in your terminal.
 *              Sharp, confident, ready to ship code at light speed.
 *              Codi doesn't need the cloud — runs local, thinks global.
 */

const C = {
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
  brightCyan: '\x1b[96m',
  brightGreen: '\x1b[92m',
  brightYellow: '\x1b[93m',
  brightMagenta: '\x1b[95m',
  brightWhite: '\x1b[97m',
};

// ─────────────────────────────────────────────────────
// DESIGN 1: "Neon Visor" — Cyberpunk robot with glowing visor
// The signature look. Sleek, powerful, unmistakable.
// ─────────────────────────────────────────────────────
export const MASCOT_1 = `
          ╱▔▔╲
     ╔═══╡░░░░╞═══╗
     ║ ┌──────────┐║
     ║ │ ◈  ▓▓  ◈ │║
     ║ └──────────┘║
     ║   ╱ ════ ╲  ║
     ╚═══╧══════╧══╝
`;

export const BANNER_1 = (version: string, model: string, provider: string, session: string, autonomous: boolean): string => {
  const lines = [
    '',
    `${C.dim}          ╱▔▔╲${C.reset}`,
    `${C.cyan}     ╔═══╡${C.brightCyan}░░░░${C.cyan}╞═══╗${C.reset}`,
    `${C.cyan}     ║${C.white} ┌──────────┐${C.cyan}║${C.reset}   ${C.bold}${C.brightCyan}CodeBot AI${C.reset} ${C.dim}v${version}${C.reset}`,
    `${C.cyan}     ║${C.white} │ ${C.brightGreen}◈${C.white}  ${C.brightYellow}▓▓${C.white}  ${C.brightGreen}◈${C.white} │${C.cyan}║${C.reset}   ${C.dim}Think local. Code global.${C.reset}`,
    `${C.cyan}     ║${C.white} └──────────┘${C.cyan}║${C.reset}`,
    `${C.cyan}     ║${C.dim}   ╱ ${C.brightCyan}════${C.dim} ╲  ${C.cyan}║${C.reset}   ${C.dim}Model:    ${C.white}${model}${C.reset}`,
    `${C.cyan}     ╚═══╧══════╧══╝${C.reset}   ${C.dim}Provider: ${C.white}${provider}${C.reset}`,
    `${C.dim}                        Session:  ${C.white}${session}${C.reset}`,
    `${C.dim}                        ${autonomous ? `${C.brightYellow}${C.bold}⚡ AUTONOMOUS${C.reset}` : ''}${C.reset}`,
    '',
  ];
  return lines.join('\n');
};

// ─────────────────────────────────────────────────────
// DESIGN 2: "Signal Bot" — Broadcasting antenna, expressive eyes
// Character-driven. Friendly but techy. The comms officer.
// ─────────────────────────────────────────────────────
export const MASCOT_2 = `
        ╭┄┄)))))
     ┌──┴────────┐
     │  ◉      ◉  │
     │  ╰──┬┬──╯  │
     │    ┌┘└┐    │
     └──┬─┤▓▓├─┬──┘
        └─┴──┴─┘
`;

export const BANNER_2 = (version: string, model: string, provider: string, session: string, autonomous: boolean): string => {
  const lines = [
    '',
    `${C.dim}        ╭┄┄${C.brightYellow})))${C.brightGreen})${C.brightCyan})${C.reset}`,
    `${C.cyan}     ┌──┴────────┐${C.reset}`,
    `${C.cyan}     │  ${C.brightGreen}◉${C.cyan}      ${C.brightGreen}◉${C.cyan}  │${C.reset}   ${C.bold}${C.brightCyan}CodeBot AI${C.reset} ${C.dim}v${version}${C.reset}`,
    `${C.cyan}     │  ${C.dim}╰──┬┬──╯${C.cyan}  │${C.reset}   ${C.dim}Think local. Code global.${C.reset}`,
    `${C.cyan}     │    ${C.dim}┌┘└┐${C.cyan}    │${C.reset}`,
    `${C.cyan}     └──┬─┤${C.brightYellow}▓▓${C.cyan}├─┬──┘${C.reset}   ${C.dim}Model:    ${C.white}${model}${C.reset}`,
    `${C.cyan}        └─┴──┴─┘${C.reset}      ${C.dim}Provider: ${C.white}${provider}${C.reset}`,
    `${C.dim}                        Session:  ${C.white}${session}${C.reset}`,
    `${C.dim}                        ${autonomous ? `${C.brightYellow}${C.bold}⚡ AUTONOMOUS${C.reset}` : ''}${C.reset}`,
    '',
  ];
  return lines.join('\n');
};

// ─────────────────────────────────────────────────────
// DESIGN 3: "Holo Core" — Floating holographic AI core
// Abstract, futuristic. A projection from the machine.
// ─────────────────────────────────────────────────────
export const MASCOT_3 = `
      ╭━━━━━━━━━━━╮
     ╱  ◇      ◇   ╲
    │  ░░░░████░░░░  │
     ╲   ╰══════╯   ╱
      ╰━━━━┯━━┯━━━━╯
           ┃  ┃
      ━━━━━┻━━┻━━━━━
`;

export const BANNER_3 = (version: string, model: string, provider: string, session: string, autonomous: boolean): string => {
  const lines = [
    '',
    `${C.brightCyan}      ╭━━━━━━━━━━━╮${C.reset}`,
    `${C.cyan}     ╱  ${C.brightMagenta}◇${C.cyan}      ${C.brightMagenta}◇${C.cyan}   ╲${C.reset}   ${C.bold}${C.brightCyan}CodeBot AI${C.reset} ${C.dim}v${version}${C.reset}`,
    `${C.cyan}    │  ${C.brightCyan}░░░░${C.brightWhite}████${C.brightCyan}░░░░${C.cyan}  │${C.reset}   ${C.dim}Think local. Code global.${C.reset}`,
    `${C.cyan}     ╲   ${C.dim}╰══════╯${C.cyan}   ╱${C.reset}`,
    `${C.brightCyan}      ╰━━━━${C.dim}┯━━┯${C.brightCyan}━━━━╯${C.reset}   ${C.dim}Model:    ${C.white}${model}${C.reset}`,
    `${C.dim}           ┃  ┃${C.reset}          ${C.dim}Provider: ${C.white}${provider}${C.reset}`,
    `${C.brightCyan}      ━━━━━${C.dim}┻━━┻${C.brightCyan}━━━━━${C.reset}   ${C.dim}Session:  ${C.white}${session}${C.reset}`,
    `${C.dim}                        ${autonomous ? `${C.brightYellow}${C.bold}⚡ AUTONOMOUS${C.reset}` : ''}${C.reset}`,
    '',
  ];
  return lines.join('\n');
};

// ─────────────────────────────────────────────────────
// Default banner (Design 1 — Neon Visor, the signature look)
// ─────────────────────────────────────────────────────
export const banner = BANNER_1;

/**
 * Random startup greeting from Codi.
 */
const GREETINGS = [
  "Systems online. Let's ship.",
  "All circuits green. Ready to code.",
  "What are we building today?",
  "I read your codebase. We need to talk.",
  "Local power, global ambitions.",
  "No cloud. No limits. Let's go.",
  "Standing by. Say the word.",
  "Initialized. Awaiting instructions.",
  "Your code, your machine, your move.",
  "Another day, another deploy.",
  "Signal locked. Ready to transmit.",
  "Booted up. Zero dependencies loaded.",
];

export function randomGreeting(): string {
  return GREETINGS[Math.floor(Math.random() * GREETINGS.length)];
}

/**
 * Compact single-line startup for non-TTY / piped usage.
 */
export function compactBanner(version: string, model: string): string {
  return `${C.bold}${C.brightCyan}CodeBot AI${C.reset} ${C.dim}v${version}${C.reset} ${C.dim}[${model}]${C.reset}`;
}
