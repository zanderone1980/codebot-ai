import * as fs from 'fs';
import * as path from 'path';

/**
 * Build a lightweight repo map (~200-500 tokens) to give the model project awareness.
 */
export function buildRepoMap(rootDir: string): string {
  const lines: string[] = ['Project structure:'];
  const maxFiles = 50;
  let fileCount = 0;
  const skip = new Set([
    'node_modules', '.git', 'dist', 'build', 'coverage',
    '__pycache__', '.next', '.cache', '.codebot', '.venv', 'venv',
  ]);

  const walk = (dir: string, prefix: string, depth: number) => {
    if (depth > 4 || fileCount > maxFiles) return;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    entries.sort((a, b) => {
      if (a.isDirectory() && !b.isDirectory()) return -1;
      if (!a.isDirectory() && b.isDirectory()) return 1;
      return a.name.localeCompare(b.name);
    });

    for (const entry of entries) {
      if (skip.has(entry.name) || (entry.name.startsWith('.') && entry.name !== '.env.example')) continue;
      if (fileCount > maxFiles) break;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        lines.push(`${prefix}${entry.name}/`);
        walk(fullPath, prefix + '  ', depth + 1);
      } else {
        fileCount++;
        lines.push(`${prefix}${entry.name}`);
      }
    }
  };

  walk(rootDir, '  ', 0);

  // Add key file info
  const pkgPath = path.join(rootDir, 'package.json');
  if (fs.existsSync(pkgPath)) {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf-8'));
      lines.push(`\npackage.json: ${pkg.name || 'unnamed'} v${pkg.version || '0.0.0'}`);
      if (pkg.scripts) {
        lines.push(`  scripts: ${Object.keys(pkg.scripts).join(', ')}`);
      }
    } catch {
      // skip
    }
  }

  return lines.join('\n');
}
