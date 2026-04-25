/**
 * Symbol indexer — RFC 001 Part A.
 *
 * Scans a project for top-level declarations (classes, functions, etc.)
 * and builds a flat name→location index so the agent can look up
 * "where is `RelatedFieldListFilter` defined?" without grep-and-hope.
 *
 * Honest scope of v1:
 *  - Regex-based. Fast, approximate. Catches most Python / TS / JS
 *    top-level symbols plus Go and Rust basics. Doesn't understand
 *    scope, so nested / conditional declarations may be missed.
 *  - In-memory per session, no on-disk cache. On a 10k-file repo the
 *    walk + regex runs in ~1s. If that ever becomes the bottleneck we
 *    add caching keyed on git HEAD.
 *  - Not an LSP. Not tree-sitter. Those are deliberately out of scope —
 *    this is the smallest thing that beats naive grep for localization.
 *
 * The agent-facing tool is `find_symbol` in src/tools/find-symbol.ts.
 */

import * as fs from 'fs';
import * as path from 'path';

export type SymbolKind =
  | 'class'
  | 'function'
  | 'method'
  | 'const'
  | 'type'
  | 'interface'
  | 'enum'
  | 'struct'
  | 'trait'
  | 'module';

export interface SymbolEntry {
  name: string;
  kind: SymbolKind;
  /**
   * Path relative to projectRoot, ALWAYS in POSIX form (forward slashes).
   * Normalized at the boundary in `walkDir()` via `toPosixPath()` so that
   * the same project produces the same `file` value on Windows, macOS,
   * and Linux. Consumers (FindSymbolTool, dashboard, agent log lines)
   * can rely on this without re-normalizing.
   */
  file: string;
  line: number;       // 1-based
  lang: 'python' | 'typescript' | 'javascript' | 'go' | 'rust' | 'ruby' | 'java';
}

/**
 * Normalize a relative path to POSIX form. On POSIX hosts this is a
 * no-op. On Windows, `path.relative` returns `mod\a.py`; we want
 * `mod/a.py` so the wire format is platform-independent.
 *
 * Applied at the SymbolEntry boundary only — internal `path.join` /
 * `fs.readdirSync` work in native form.
 */
function toPosixPath(p: string): string {
  return path.sep === '/' ? p : p.split(path.sep).join('/');
}

/**
 * Per-language regexes. Each match must expose the symbol name in a
 * named capture group `name`. Patterns are intentionally anchored to
 * the start of a line so we don't match names inside strings or
 * expressions.
 */
interface LangSpec {
  lang: SymbolEntry['lang'];
  extensions: string[];
  patterns: Array<{ re: RegExp; kind: SymbolKind }>;
}

const LANGS: LangSpec[] = [
  {
    lang: 'python',
    extensions: ['.py'],
    patterns: [
      // Python — indentation matters for methods vs functions.
      // We capture anything at any indent level but mark methods when
      // there's leading whitespace.
      { re: /^(?<indent>[ \t]*)(?:async\s+)?def\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*\(/, kind: 'function' },
      { re: /^(?<indent>[ \t]*)class\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*[(:]/, kind: 'class' },
    ],
  },
  {
    lang: 'typescript',
    extensions: ['.ts', '.tsx'],
    patterns: [
      { re: /^(?:export\s+)?(?:async\s+)?function\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)\s*[<(]/, kind: 'function' },
      { re: /^(?:export\s+)?(?:abstract\s+)?class\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)\b/, kind: 'class' },
      { re: /^(?:export\s+)?interface\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)\b/, kind: 'interface' },
      { re: /^(?:export\s+)?type\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)\s*=/, kind: 'type' },
      { re: /^(?:export\s+)?enum\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)\b/, kind: 'enum' },
      { re: /^(?:export\s+)?const\s+(?<name>[A-Z_][A-Z0-9_]*)\s*=/, kind: 'const' }, // SCREAMING constants only
    ],
  },
  {
    lang: 'javascript',
    extensions: ['.js', '.jsx', '.mjs', '.cjs'],
    patterns: [
      { re: /^(?:export\s+)?(?:async\s+)?function\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)\s*\(/, kind: 'function' },
      { re: /^(?:export\s+)?class\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)\b/, kind: 'class' },
    ],
  },
  {
    lang: 'go',
    extensions: ['.go'],
    patterns: [
      { re: /^func\s+(?:\([^)]*\)\s+)?(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*\(/, kind: 'function' },
      { re: /^type\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)\s+struct\b/, kind: 'struct' },
      { re: /^type\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)\s+interface\b/, kind: 'interface' },
    ],
  },
  {
    lang: 'rust',
    extensions: ['.rs'],
    patterns: [
      { re: /^(?:pub\s+(?:\([^)]*\)\s+)?)?fn\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)\s*[<(]/, kind: 'function' },
      { re: /^(?:pub\s+(?:\([^)]*\)\s+)?)?struct\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)\b/, kind: 'struct' },
      { re: /^(?:pub\s+(?:\([^)]*\)\s+)?)?enum\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)\b/, kind: 'enum' },
      { re: /^(?:pub\s+(?:\([^)]*\)\s+)?)?trait\s+(?<name>[A-Za-z_][A-Za-z0-9_]*)\b/, kind: 'trait' },
    ],
  },
  {
    lang: 'ruby',
    extensions: ['.rb'],
    patterns: [
      { re: /^\s*def\s+(?:self\.)?(?<name>[A-Za-z_][A-Za-z0-9_]*[?!=]?)/, kind: 'function' },
      { re: /^\s*class\s+(?<name>[A-Z][A-Za-z0-9_:]*)\b/, kind: 'class' },
      { re: /^\s*module\s+(?<name>[A-Z][A-Za-z0-9_:]*)\b/, kind: 'module' },
    ],
  },
  {
    lang: 'java',
    extensions: ['.java'],
    patterns: [
      { re: /^\s*(?:public\s+|private\s+|protected\s+)?(?:abstract\s+|final\s+)?class\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)\b/, kind: 'class' },
      { re: /^\s*(?:public\s+|private\s+|protected\s+)?interface\s+(?<name>[A-Za-z_$][A-Za-z0-9_$]*)\b/, kind: 'interface' },
    ],
  },
];

/** Directories we never descend into. */
const SKIP_DIRS = new Set([
  'node_modules', '.git', '.hg', '.svn', 'dist', 'build', 'out',
  'target', '__pycache__', '.venv', 'venv', '.tox', '.mypy_cache',
  '.pytest_cache', '.next', '.nuxt', 'coverage', '.idea', '.vscode',
]);

/** Hard cap so a rogue giant repo can't OOM the agent. */
const MAX_FILES = 10_000;
const MAX_FILE_SIZE_BYTES = 2 * 1024 * 1024; // 2 MB

/** Map an extension to a LangSpec, or undefined if we don't index it. */
function specForExt(ext: string): LangSpec | undefined {
  return LANGS.find((s) => s.extensions.includes(ext.toLowerCase()));
}

/** Walk a single file and emit its symbols. */
function scanFile(absPath: string, relPath: string, spec: LangSpec, out: SymbolEntry[]): void {
  let contents: string;
  try {
    const stat = fs.statSync(absPath);
    if (stat.size > MAX_FILE_SIZE_BYTES) return;
    contents = fs.readFileSync(absPath, 'utf-8');
  } catch {
    return;
  }
  if (contents.includes('\0')) return; // binary
  const lines = contents.split('\n');
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    for (const { re, kind } of spec.patterns) {
      const m = re.exec(line);
      if (!m?.groups?.name) continue;
      const name = m.groups.name;
      let effectiveKind = kind;
      // Python: `def` at non-zero indent under a `class` is a method.
      // Cheap heuristic: any indent == method.
      if (spec.lang === 'python' && kind === 'function' && m.groups.indent && m.groups.indent.length > 0) {
        effectiveKind = 'method';
      }
      out.push({ name, kind: effectiveKind, file: relPath, line: i + 1, lang: spec.lang });
      break; // first matching pattern wins per line
    }
  }
}

function walkDir(
  root: string,
  current: string,
  out: SymbolEntry[],
  counter: { files: number },
): void {
  if (counter.files >= MAX_FILES) return;
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (counter.files >= MAX_FILES) return;
    const abs = path.join(current, entry.name);
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name)) continue;
      if (entry.name.startsWith('.') && entry.name !== '.') continue;
      walkDir(root, abs, out, counter);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name);
    const spec = specForExt(ext);
    if (!spec) continue;
    // Normalize to POSIX-style at the boundary so SymbolEntry.file is
    // platform-independent. See toPosixPath() docstring.
    const rel = toPosixPath(path.relative(root, abs));
    scanFile(abs, rel, spec, out);
    counter.files++;
  }
}

export class SymbolIndexer {
  private readonly projectRoot: string;
  private cache: SymbolEntry[] | null = null;
  private indexedAt = 0;
  /** How long the in-memory index is considered fresh. Rebuilds beyond this age. */
  readonly staleAfterMs = 30_000;

  constructor(projectRoot: string) {
    this.projectRoot = projectRoot;
  }

  /** Force a rebuild. Returns the full entry list. */
  build(): SymbolEntry[] {
    const out: SymbolEntry[] = [];
    const counter = { files: 0 };
    walkDir(this.projectRoot, this.projectRoot, out, counter);
    this.cache = out;
    this.indexedAt = Date.now();
    return out;
  }

  private ensureIndex(): SymbolEntry[] {
    if (!this.cache || Date.now() - this.indexedAt > this.staleAfterMs) {
      return this.build();
    }
    return this.cache;
  }

  /** Exact-name lookup. */
  findByName(name: string): SymbolEntry[] {
    return this.ensureIndex().filter((s) => s.name === name);
  }

  /** Case-insensitive prefix match. */
  findByPrefix(prefix: string): SymbolEntry[] {
    const needle = prefix.toLowerCase();
    return this.ensureIndex().filter((s) => s.name.toLowerCase().startsWith(needle));
  }

  /** Case-insensitive substring match. Useful when the agent has a
   * partial name like "Filter" and wants all RelatedFieldListFilter-ish
   * matches. */
  findBySubstring(needle: string): SymbolEntry[] {
    const q = needle.toLowerCase();
    return this.ensureIndex().filter((s) => s.name.toLowerCase().includes(q));
  }

  /** Stats for debugging / tests. */
  stats(): { totalSymbols: number; byLang: Record<string, number>; byKind: Record<string, number> } {
    const entries = this.ensureIndex();
    const byLang: Record<string, number> = {};
    const byKind: Record<string, number> = {};
    for (const e of entries) {
      byLang[e.lang] = (byLang[e.lang] || 0) + 1;
      byKind[e.kind] = (byKind[e.kind] || 0) + 1;
    }
    return { totalSymbols: entries.length, byLang, byKind };
  }
}
