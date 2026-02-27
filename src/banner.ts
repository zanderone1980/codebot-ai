/**
 * CodeBot AI mascot and CLI banner.
 *
 * Mascot name: Codi
 * Three designs: Pixel Bot, Monitor Bot, Visor Helmet
 */

const C = {
  reset: '\x1b[0m',
  bold: '\x1b[1m',
  dim: '\x1b[2m',
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
// DESIGN 1: "Pixel Bot" — Half-block pixel art robot head
// Retro-modern pixel aesthetic. The signature look.
// ─────────────────────────────────────────────────────
export const MASCOT_1 = `
              ██
       ▄▄████████████▄▄
       █              █
       █  ▄██▄  ▄██▄  █
       █  ▀██▀  ▀██▀  █
       █              █
       █   ▀██████▀   █
       ▀▀████████████▀▀
`;

export const BANNER_1 = (version: string, model: string, provider: string, session: string, autonomous: boolean): string => {
  const lines = [
    '',
    `${C.brightGreen}              ██${C.reset}`,
    `${C.cyan}       ▄▄████████████▄▄${C.reset}`,
    `${C.cyan}       █${C.reset}              ${C.cyan}█${C.reset}   ${C.bold}${C.brightCyan}CodeBot AI${C.reset} ${C.dim}v${version}${C.reset}`,
    `${C.cyan}       █  ${C.brightGreen}▄██▄${C.reset}  ${C.brightGreen}▄██▄${C.reset}  ${C.cyan}█${C.reset}   ${C.dim}Think local. Code global.${C.reset}`,
    `${C.cyan}       █  ${C.brightGreen}▀██▀${C.reset}  ${C.brightGreen}▀██▀${C.reset}  ${C.cyan}█${C.reset}`,
    `${C.cyan}       █${C.reset}              ${C.cyan}█${C.reset}   ${C.dim}Model:    ${C.white}${model}${C.reset}`,
    `${C.cyan}       █   ${C.brightCyan}▀██████▀${C.reset}   ${C.cyan}█${C.reset}   ${C.dim}Provider: ${C.white}${provider}${C.reset}`,
    `${C.cyan}       ▀▀████████████▀▀${C.reset}   ${C.dim}Session:  ${C.white}${session}${C.reset}`,
    autonomous ? `                           ${C.brightYellow}${C.bold}⚡ AUTONOMOUS${C.reset}` : '',
    '',
  ];
  return lines.join('\n');
};

// ─────────────────────────────────────────────────────
// DESIGN 2: "Monitor Bot" — Screen face with side panels
// Clean technical look. Like a friendly terminal display.
// ─────────────────────────────────────────────────────
export const MASCOT_2 = `
    ╔╗ ╔════════════════╗ ╔╗
    ║║ ║                ║ ║║
    ║║ ║   ●        ●   ║ ║║
    ║║ ║                ║ ║║
    ║║ ║    └──────┘    ║ ║║
    ║║ ║                ║ ║║
    ╚╝ ╚════════════════╝ ╚╝
`;

export const BANNER_2 = (version: string, model: string, provider: string, session: string, autonomous: boolean): string => {
  const lines = [
    '',
    `${C.dim}    ╔╗${C.reset} ${C.cyan}╔════════════════╗${C.reset} ${C.dim}╔╗${C.reset}`,
    `${C.dim}    ║║${C.reset} ${C.cyan}║${C.reset}                ${C.cyan}║${C.reset} ${C.dim}║║${C.reset}`,
    `${C.dim}    ║║${C.reset} ${C.cyan}║${C.reset}   ${C.brightGreen}●${C.reset}        ${C.brightGreen}●${C.reset}   ${C.cyan}║${C.reset} ${C.dim}║║${C.reset}   ${C.bold}${C.brightCyan}CodeBot AI${C.reset} ${C.dim}v${version}${C.reset}`,
    `${C.dim}    ║║${C.reset} ${C.cyan}║${C.reset}                ${C.cyan}║${C.reset} ${C.dim}║║${C.reset}   ${C.dim}Think local. Code global.${C.reset}`,
    `${C.dim}    ║║${C.reset} ${C.cyan}║${C.reset}    ${C.brightCyan}└──────┘${C.reset}    ${C.cyan}║${C.reset} ${C.dim}║║${C.reset}`,
    `${C.dim}    ║║${C.reset} ${C.cyan}║${C.reset}                ${C.cyan}║${C.reset} ${C.dim}║║${C.reset}   ${C.dim}Model:    ${C.white}${model}${C.reset}`,
    `${C.dim}    ╚╝${C.reset} ${C.cyan}╚════════════════╝${C.reset} ${C.dim}╚╝${C.reset}   ${C.dim}Provider: ${C.white}${provider}${C.reset}`,
    `                                ${C.dim}Session:  ${C.white}${session}${C.reset}`,
    autonomous ? `                                ${C.brightYellow}${C.bold}⚡ AUTONOMOUS${C.reset}` : '',
    '',
  ];
  return lines.join('\n');
};

// ─────────────────────────────────────────────────────
// DESIGN 3: "Visor Helmet" — Daft Punk style with glowing visor
// Sleek, aggressive, cyberpunk. Diamond silhouette.
// ─────────────────────────────────────────────────────
export const MASCOT_3 = `
         ▄████████▄
        █▀        ▀█
       █ ░░██████░░ █
       █ ░░░░░░░░░░ █
        █▄        ▄█
         ▀████████▀
`;

export const BANNER_3 = (version: string, model: string, provider: string, session: string, autonomous: boolean): string => {
  const lines = [
    '',
    `${C.cyan}         ▄████████▄${C.reset}`,
    `${C.cyan}        █▀${C.reset}        ${C.cyan}▀█${C.reset}       ${C.bold}${C.brightCyan}CodeBot AI${C.reset} ${C.dim}v${version}${C.reset}`,
    `${C.cyan}       █ ${C.brightCyan}░░${C.brightGreen}██████${C.brightCyan}░░${C.cyan} █${C.reset}      ${C.dim}Think local. Code global.${C.reset}`,
    `${C.cyan}       █ ${C.dim}░░░░░░░░░░${C.cyan} █${C.reset}`,
    `${C.cyan}        █▄${C.reset}        ${C.cyan}▄█${C.reset}       ${C.dim}Model:    ${C.white}${model}${C.reset}`,
    `${C.cyan}         ▀████████▀${C.reset}        ${C.dim}Provider: ${C.white}${provider}${C.reset}`,
    `                            ${C.dim}Session:  ${C.white}${session}${C.reset}`,
    autonomous ? `                            ${C.brightYellow}${C.bold}⚡ AUTONOMOUS${C.reset}` : '',
    '',
  ];
  return lines.join('\n');
};

// ─────────────────────────────────────────────────────
// Default banner (Design 1 — Pixel Bot)
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
