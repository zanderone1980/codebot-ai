import * as fs from 'fs';
import * as path from 'path';
import { Tool } from '../types';

export class GlobTool implements Tool {
  name = 'glob';
  description = 'Find files matching a glob pattern. Returns matching file paths relative to the search directory.';
  permission: Tool['permission'] = 'auto';
  parameters = {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Glob pattern (e.g., "**/*.ts", "src/**/*.js")' },
      cwd: { type: 'string', description: 'Directory to search in (defaults to current)' },
    },
    required: ['pattern'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const cwd = (args.cwd as string) || process.cwd();
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

    const walk = (currentDir: string, rel: string) => {
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
        if (entry.isDirectory()) {
          walk(path.join(currentDir, entry.name), relPath);
        } else if (regex.test(relPath)) {
          results.push(relPath);
        }
      }
    };

    walk(dir, '');
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
