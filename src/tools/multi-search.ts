import * as fs from 'fs';
import * as path from 'path';
import { Tool, CapabilityLabel } from '../types';

interface SearchResult {
  file: string;
  line?: number;
  text?: string;
  score: number;
  type: 'filename' | 'content' | 'symbol';
}

export class MultiSearchTool implements Tool {
  name = 'multi_search';
  description = 'Fuzzy search across filenames, file contents, and code symbols. Returns ranked results by relevance.';
  permission: Tool['permission'] = 'auto';
  capabilities: CapabilityLabel[] = ['read-only'];
  parameters = {
    type: 'object',
    properties: {
      query: { type: 'string', description: 'Search query (fuzzy matched against filenames, content, and symbols)' },
      path: { type: 'string', description: 'Directory to search (defaults to current)' },
      max_results: { type: 'number', description: 'Max results to return (default: 20)' },
    },
    required: ['query'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const query = args.query as string;
    if (!query) return 'Error: query is required';

    const searchPath = (args.path as string) || process.cwd();
    const maxResults = (args.max_results as number) || 20;

    if (!fs.existsSync(searchPath)) return `Error: path not found: ${searchPath}`;

    const results: SearchResult[] = [];
    const queryLower = query.toLowerCase();
    const queryParts = queryLower.split(/\s+/);

    this.searchDir(searchPath, queryLower, queryParts, results);

    // Sort by score descending
    results.sort((a, b) => b.score - a.score);
    const top = results.slice(0, maxResults);

    if (top.length === 0) return `No results for "${query}".`;

    const lines = top.map(r => {
      const tag = r.type === 'filename' ? '[file]' : r.type === 'symbol' ? '[symbol]' : '[content]';
      const loc = r.line ? `:${r.line}` : '';
      const preview = r.text ? ` — ${r.text.substring(0, 80)}` : '';
      return `  ${tag} ${r.file}${loc}${preview}`;
    });

    return `Search results for "${query}" (${top.length} matches):\n${lines.join('\n')}`;
  }

  private searchDir(dir: string, query: string, parts: string[], results: SearchResult[]): void {
    const skip = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '__pycache__', '.next']);
    const codeExts = new Set(['.ts', '.js', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.rb', '.c', '.cpp', '.h', '.css', '.html', '.json', '.md', '.yaml', '.yml', '.toml']);

    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (entry.name.startsWith('.') || skip.has(entry.name)) continue;
      const full = path.join(dir, entry.name);

      if (entry.isDirectory()) {
        // Score directory name
        const dirScore = this.fuzzyScore(entry.name.toLowerCase(), query, parts);
        if (dirScore > 0) {
          results.push({ file: full + '/', score: dirScore * 0.5, type: 'filename' });
        }
        this.searchDir(full, query, parts, results);
      } else {
        // Filename match
        const nameScore = this.fuzzyScore(entry.name.toLowerCase(), query, parts);
        if (nameScore > 0) {
          results.push({ file: full, score: nameScore, type: 'filename' });
        }

        // Content + symbol search for code files
        const ext = path.extname(entry.name).toLowerCase();
        if (!codeExts.has(ext)) continue;

        try {
          const content = fs.readFileSync(full, 'utf-8');
          if (content.length > 500_000 || content.includes('\0')) continue; // skip huge/binary

          const lines = content.split('\n');
          for (let i = 0; i < lines.length; i++) {
            const line = lines[i];
            const lineLower = line.toLowerCase();

            // Content match
            if (lineLower.includes(query)) {
              results.push({ file: full, line: i + 1, text: line.trimEnd(), score: 3, type: 'content' });
            }

            // Symbol match (class, function, method definitions)
            const symbolMatch = line.match(/(?:class|function|interface|type|const|let|var|def|fn|func)\s+(\w+)/);
            if (symbolMatch) {
              const symScore = this.fuzzyScore(symbolMatch[1].toLowerCase(), query, parts);
              if (symScore > 0) {
                results.push({ file: full, line: i + 1, text: line.trimEnd(), score: symScore * 1.5, type: 'symbol' });
              }
            }
          }
        } catch { /* skip */ }
      }
    }
  }

  private fuzzyScore(target: string, query: string, parts: string[]): number {
    // Exact match
    if (target === query) return 10;
    // Contains full query
    if (target.includes(query)) return 7;
    // All parts present
    if (parts.every(p => target.includes(p))) return 5;
    // Some parts present
    const matched = parts.filter(p => target.includes(p)).length;
    if (matched > 0) return matched * 2;
    return 0;
  }
}
