import * as fs from 'fs';
import * as path from 'path';
import { Tool } from '../types';

export class GlobTool implements Tool {
  name = 'glob';
  private projectRoot: string;
  constructor(projectRoot?: string) { this.projectRoot = projectRoot || process.cwd(); }
  description = 'Find files matching a glob pattern. Returns matching file paths relative to the search directory.';
  permission: Tool['permission'] = 'auto';
  cacheable = true;
  parameters = {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern (e.g., "**/*.ts", "src/**/*.js")' },
      cwd: { type: 'string', description: 'Directory to search in (defaults to current)' },
    },
    required: ['pattern'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const cwd = (args.cwd as string) || this.projectRoot;
    const pattern = args.pattern as string;
    const matches = this.walkAndMatch(cwd, pattern);

    if (matches.length === 0) return 'No files found matching pattern.';
    if (matches.length > 100) {
      return `${matches.slice(0, 100).join('\n')}\n\n... and ${matches.length - 100} more files`;
    }
    return matches.join('\n');
  }

  private walkAndMatch(dir: string, pattern: string): string[] {
    const results: string[] = [];
    const regex = this.patternToRegex(pattern);
    const skip = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '__pycache__', '.next']);
    const maxDepth = 20;
    const visited = new Set<string>();

    const walk = (currentDir: string, rel: string, depth: number) => {
      if (depth > maxDepth) return;

      // Resolve real path to detect symlink loops
      let realDir: string;
      try {
        realDir = fs.realpathSync(currentDir);
      } catch {
        return;
      }
      if (visited.has(realDir)) return;
      visited.add(realDir);

      let entries: fs.Dirent[];
      try {
        entries = fs.readdirSync(currentDir, { withFileTypes: true });
      } catch {
        return;
      }

      for (const entry of entries) {
        if (entry.name.startsWith('.') && !pattern.startsWith('.')) continue;
        if (skip.has(entry.name)) continue;

        const relPath = rel ? `${rel}/${entry.name}` : entry.name;
        if (entry.isDirectory() || entry.isSymbolicLink()) {
          const fullPath = path.join(currentDir, entry.name);
          try {
            const stat = fs.statSync(fullPath);
            if (stat.isDirectory()) {
              walk(fullPath, relPath, depth + 1);
            } else if (regex.test(relPath)) {
              results.push(relPath);
            }
          } catch {
            continue; // broken symlink
          }
        } else if (regex.test(relPath)) {
          results.push(relPath);
        }
      }
    };

    walk(dir, '', 0);
    return results.sort();
  }

  private patternToRegex(pattern: string): RegExp {
    const regex = pattern
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '{{GLOBSTAR}}')
      .replace(/\*/g, '[^/]*')
      .replace(/\{\{GLOBSTAR\}\}/g, '.*')
      .replace(/\?/g, '[^/]');
    return new RegExp(`^${regex}$`);
  }
}
