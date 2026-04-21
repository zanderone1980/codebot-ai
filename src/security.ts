import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * Path safety module for CodeBot.
 *
 * Prevents tools from reading/writing system-critical files and directories.
 * Resolves symlinks to prevent bypass attacks.
 */

/** System-critical absolute paths that should NEVER be written to */
const BLOCKED_ABSOLUTE_PATHS = [
  '/etc', '/usr', '/bin', '/sbin', '/boot', '/dev', '/proc', '/sys',
  '/var/log', '/var/run', '/lib', '/lib64',
  // macOS system directories
  '/System', '/Library',
  // Windows system directories
  'C:\\Windows', 'C:\\Program Files', 'C:\\Program Files (x86)',
];

/** Home-relative sensitive directories/files that should NEVER be written to */
const BLOCKED_HOME_RELATIVE = [
  '.ssh',
  '.gnupg',
  '.aws/credentials',
  '.config/gcloud',
  '.bashrc',
  '.bash_profile',
  '.zshrc',
  '.profile',
  '.gitconfig',
  '.npmrc',
];

/**
 * Scratch directories that are universally safe for agents to use.
 *
 * Rationale: a coding agent MUST be able to write scratch files. These
 * directories are not system-critical, are writable by the user, and
 * are the canonical place dev tools put temporary output. Blocking
 * them makes the agent refuse routine tasks like "save a demo to
 * /tmp/foo/out.py and run it" — which is exactly the kind of prompt
 * a first-time user will throw at it.
 *
 * On macOS `os.tmpdir()` resolves to `/var/folders/.../T`; include it
 * explicitly so per-user tmp paths also pass.
 */
function getSafeTmpDirs(): string[] {
  const raw = ['/tmp', '/var/tmp'];
  try {
    const sys = os.tmpdir();
    if (sys && !raw.includes(sys)) raw.push(sys);
  } catch { /* best-effort */ }

  // Include both the raw path AND its realpath form, because callers
  // realpath the target path before comparing. On macOS /tmp and
  // /var/folders/... symlink through /private/*, so we must match both.
  const all = new Set<string>();
  for (const d of raw) {
    all.add(d);
    try { all.add(fs.realpathSync(d)); } catch { /* best-effort */ }
  }
  return Array.from(all);
}

export interface PathSafetyResult {
  safe: boolean;
  reason?: string;
}

/**
 * Check if a file path is safe for write/edit operations.
 *
 * Resolves symlinks, checks against blocked system paths,
 * and verifies the path is within the project or user home.
 */
export function isPathSafe(targetPath: string, projectRoot: string): PathSafetyResult {
  try {
    const resolved = path.resolve(targetPath);

    // Resolve symlinks — for new files, resolve the parent directory
    let realPath: string;
    try {
      realPath = fs.realpathSync(resolved);
    } catch {
      // File doesn't exist yet — resolve the parent
      const parentDir = path.dirname(resolved);
      try {
        const realParent = fs.realpathSync(parentDir);
        realPath = path.join(realParent, path.basename(resolved));
      } catch {
        // Parent doesn't exist either — use the resolved path as-is
        realPath = resolved;
      }
    }

    // Check against blocked absolute paths
    const normalizedPath = realPath.replace(/\\/g, '/').toLowerCase();
    for (const blocked of BLOCKED_ABSOLUTE_PATHS) {
      const normalizedBlocked = blocked.replace(/\\/g, '/').toLowerCase();
      if (normalizedPath === normalizedBlocked || normalizedPath.startsWith(normalizedBlocked + '/')) {
        return { safe: false, reason: `Blocked: "${realPath}" is inside system directory "${blocked}"` };
      }
    }

    // Check against home-relative sensitive paths
    const home = os.homedir();
    for (const relative of BLOCKED_HOME_RELATIVE) {
      const blockedPath = path.join(home, relative);
      const normalizedBlockedHome = blockedPath.replace(/\\/g, '/').toLowerCase();
      if (normalizedPath === normalizedBlockedHome || normalizedPath.startsWith(normalizedBlockedHome + '/')) {
        return { safe: false, reason: `Blocked: "${realPath}" is a sensitive file/directory (~/${relative})` };
      }
    }

    // Allow standard scratch directories. A coding agent MUST be able to write
    // to /tmp, /var/tmp, and the OS-specific tmpdir — that is the canonical
    // dev workflow. Blocking them breaks routine prompts like "save a demo
    // to /tmp/foo and run it" without protecting anything (these dirs are
    // user-writable by design).
    for (const tmp of getSafeTmpDirs()) {
      const normalizedTmp = path.resolve(tmp).replace(/\\/g, '/').toLowerCase();
      if (normalizedPath === normalizedTmp || normalizedPath.startsWith(normalizedTmp + '/')) {
        return { safe: true };
      }
    }

    // Verify path is under project root or user home
    const normalizedProject = path.resolve(projectRoot).replace(/\\/g, '/').toLowerCase();
    const normalizedHome = home.replace(/\\/g, '/').toLowerCase();

    const isUnderProject = normalizedPath.startsWith(normalizedProject + '/') || normalizedPath === normalizedProject;
    const isUnderHome = normalizedPath.startsWith(normalizedHome + '/') || normalizedPath === normalizedHome;

    if (!isUnderProject && !isUnderHome) {
      return { safe: false, reason: `Blocked: "${realPath}" is outside project root, user home, and safe scratch directories` };
    }

    return { safe: true };
  } catch (err) {
    return { safe: false, reason: `Path validation error: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Check if a working directory is safe for command execution.
 *
 * Ensures the CWD exists, is a directory, and is under the project root.
 */
export function isCwdSafe(cwd: string, projectRoot: string): PathSafetyResult {
  try {
    const resolved = path.resolve(cwd);

    // Check it exists and is a directory
    try {
      const stat = fs.statSync(resolved);
      if (!stat.isDirectory()) {
        return { safe: false, reason: `"${resolved}" is not a directory` };
      }
    } catch {
      return { safe: false, reason: `Directory does not exist: "${resolved}"` };
    }

    // Resolve symlinks
    let realPath: string;
    try {
      realPath = fs.realpathSync(resolved);
    } catch {
      realPath = resolved;
    }

    // Verify it's under project root, user home, or a safe scratch dir
    const normalizedPath = realPath.replace(/\\/g, '/').toLowerCase();
    const normalizedProject = path.resolve(projectRoot).replace(/\\/g, '/').toLowerCase();
    const normalizedHome = os.homedir().replace(/\\/g, '/').toLowerCase();

    const isUnderProject = normalizedPath.startsWith(normalizedProject + '/') || normalizedPath === normalizedProject;
    const isUnderHome = normalizedPath.startsWith(normalizedHome + '/') || normalizedPath === normalizedHome;

    // Allow scratch dirs as CWD — same rationale as isPathSafe.
    let isUnderSafeTmp = false;
    for (const tmp of getSafeTmpDirs()) {
      const normalizedTmp = path.resolve(tmp).replace(/\\/g, '/').toLowerCase();
      if (normalizedPath === normalizedTmp || normalizedPath.startsWith(normalizedTmp + '/')) {
        isUnderSafeTmp = true;
        break;
      }
    }

    if (!isUnderProject && !isUnderHome && !isUnderSafeTmp) {
      return { safe: false, reason: `CWD "${realPath}" is outside project root, user home, and safe scratch directories` };
    }

    return { safe: true };
  } catch (err) {
    return { safe: false, reason: `CWD validation error: ${err instanceof Error ? err.message : String(err)}` };
  }
}
