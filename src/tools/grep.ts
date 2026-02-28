import * as fs from 'fs';
import * as path from 'path';
import { Tool } from '../types';

export class GrepTool implements Tool {
  name = 'grep';
  description = 'Search file contents for a regex pattern. Returns matching lines with file paths and line numbers.';
  permission: Tool['permission'] = 'auto';
  cacheable = true;
  parameters = {
    type: 'object',
    properties: {
      pattern: { type: 'string', description: 'Regex pattern to search for' },
      path: { type: 'string', description: 'File or directory to search (defaults to current directory)' },
      include: { type: 'string', description: 'File extension filter (e.g., "*.ts", "*.js")' },
    },
    required: ['pattern'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const searchPath = (args.path as string) || process.cwd();
    if (!args.pattern) return 'Error: pattern is required';

    let regex: RegExp;
    try {
      regex = new RegExp(args.pattern as string, 'gi');
    } catch (e) {
      return `Error: invalid regex pattern: ${(e as Error).message}`;
    }

    const results: string[] = [];
    const maxResults = 50;

    let stat: fs.Stats;
    try {
      stat = fs.statSync(searchPath);
    } catch {
      return `Error: path not found: ${searchPath}`;
    }
    if (stat.isFile()) {
      this.searchFile(searchPath, regex, results, maxResults);
    } else {
      this.searchDir(searchPath, regex, results, args.include as string | undefined, maxResults);
    }

    if (results.length === 0) return 'No matches found.';
    const header = results.length >= maxResults ? `(showing first ${maxResults} matches)\n` : '';
    return header + results.join('\n');
  }

  private searchFile(filePath: string, regex: RegExp, results: string[], maxResults: number) {
    if (results.length >= maxResults) return;
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      if (content.includes('\0')) return; // skip binary files
      const lines = content.split('\n');
      for (let i = 0; i < lines.length && results.length < maxResults; i++) {
        regex.lastIndex = 0;
        if (regex.test(lines[i])) {
          results.push(`${filePath}:${i + 1}: ${lines[i].trimEnd()}`);
        }
      }
    } catch {
      // skip unreadable files
    }
  }

  private searchDir(
    dir: string,
    regex: RegExp,
    results: string[],
    include: string | undefined,
    maxResults: number
  ) {
    if (results.length >= maxResults) return;
    const skip = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '__pycache__']);

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }

    const includeRegex = include ? this.globToRegex(include) : null;

    for (const entry of entries) {
      if (results.length >= maxResults) break;
      if (entry.name.startsWith('.') || skip.has(entry.name)) continue;

      const fullPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this.searchDir(fullPath, regex, results, include, maxResults);
      } else {
        if (includeRegex && !includeRegex.test(entry.name)) continue;
        this.searchFile(fullPath, regex, results, maxResults);
      }
    }
  }

  private globToRegex(glob: string): RegExp {
    const regex = glob
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*/g, '.*')
      .replace(/\?/g, '.');
    return new RegExp(`^${regex}$`);
  }
}
