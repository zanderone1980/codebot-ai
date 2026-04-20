/**
 * PATH augmentation for spawned shell commands.
 *
 * Why this exists:
 * When the Electron app is launched from Finder / the Dock on macOS, its
 * process.env.PATH does NOT include /opt/homebrew/bin (Apple Silicon brew),
 * /usr/local/bin (Intel brew + many manual installs), or ~/.cargo/bin etc.
 * Those only get added by the user's interactive shell rc files.
 *
 * Symptom before this fix: the agent runs `which python3` via the execute
 * tool and gets exit 1 — "python3 not found" — even though the user has
 * python3 installed via brew. The model then tells the user "I'm in a
 * sandboxed shell", which looks like hallucination but is actually a
 * truthful report of its (restricted) PATH.
 *
 * We prepend the well-known user-level bin dirs to PATH before handing env
 * off to child_process. This keeps the fix local to execution concerns —
 * the Electron process itself isn't affected.
 */

import * as os from 'os';
import * as path from 'path';

/**
 * Well-known bin directories that GUI apps on macOS/Linux routinely miss.
 * Order matters: earlier entries win on collisions. We put the user's home
 * bins first (most likely to be what they want), then /opt/homebrew, then
 * /usr/local, then the base system paths as a safety net.
 */
function standardBinDirs(): string[] {
  const home = os.homedir();
  const dirs = [
    path.join(home, '.local/bin'),
    path.join(home, 'bin'),
    path.join(home, '.cargo/bin'),
    path.join(home, '.pyenv/shims'),
    path.join(home, '.rbenv/shims'),
    path.join(home, '.nvm/versions/node'),  // parent only; version dirs vary
    '/opt/homebrew/bin',
    '/opt/homebrew/sbin',
    '/usr/local/bin',
    '/usr/local/sbin',
    '/usr/bin',
    '/bin',
    '/usr/sbin',
    '/sbin',
  ];
  return dirs;
}

/** Return an augmented PATH string: existing PATH + any missing standard dirs. */
export function augmentedPath(currentPath: string | undefined = process.env.PATH): string {
  const sep = path.delimiter;
  const existing = new Set((currentPath || '').split(sep).filter(Boolean));
  const toAdd: string[] = [];
  for (const dir of standardBinDirs()) {
    if (!existing.has(dir)) {
      toAdd.push(dir);
      existing.add(dir);
    }
  }
  // Prepend standard dirs — a user-customized PATH should still win where it
  // explicitly lists something, but at minimum the standard dirs are present.
  // We preserve the original PATH order by appending our additions at the end
  // so existing PATH entries take priority.
  const out = [...(currentPath || '').split(sep).filter(Boolean), ...toAdd];
  return out.join(sep);
}

/** Return a copy of env with PATH augmented to include standard bin dirs. */
export function envWithAugmentedPath(env: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  return { ...env, PATH: augmentedPath(env.PATH) };
}
