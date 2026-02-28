import * as fs from 'fs';
import * as path from 'path';
import { Tool } from '../types';

export class CodeAnalysisTool implements Tool {
  name = 'code_analysis';
  description = 'Analyze code structure. Actions: symbols (list classes/functions/exports), imports (list imports), outline (file structure), references (find where a symbol is used).';
  permission: Tool['permission'] = 'auto';
  cacheable = true;
  parameters = {
    type: 'object',
    properties: {
      action: { type: 'string', description: 'Action: symbols, imports, outline, references' },
      path: { type: 'string', description: 'File or directory to analyze' },
      symbol: { type: 'string', description: 'Symbol name to find references for (required for "references" action)' },
    },
    required: ['action', 'path'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = args.action as string;
    const targetPath = args.path as string;

    if (!action) return 'Error: action is required';
    if (!targetPath) return 'Error: path is required';

    if (!fs.existsSync(targetPath)) {
      return `Error: path not found: ${targetPath}`;
    }

    switch (action) {
      case 'symbols': return this.extractSymbols(targetPath);
      case 'imports': return this.extractImports(targetPath);
      case 'outline': return this.buildOutline(targetPath);
      case 'references': {
        const symbol = args.symbol as string;
        if (!symbol) return 'Error: symbol is required for references action';
        return this.findReferences(targetPath, symbol);
      }
      default:
        return `Error: unknown action "${action}". Use: symbols, imports, outline, references`;
    }
  }

  private extractSymbols(filePath: string): string {
    const content = this.readFile(filePath);
    if (!content) return 'Error: could not read file';

    const symbols: string[] = [];
    const lines = content.split('\n');

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const lineNum = i + 1;

      // Classes
      const classMatch = line.match(/^(?:export\s+)?(?:abstract\s+)?class\s+(\w+)/);
      if (classMatch) symbols.push(`  class ${classMatch[1]} (line ${lineNum})`);

      // Functions
      const funcMatch = line.match(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/);
      if (funcMatch) symbols.push(`  function ${funcMatch[1]} (line ${lineNum})`);

      // Arrow function exports
      const arrowMatch = line.match(/^(?:export\s+)?(?:const|let)\s+(\w+)\s*=\s*(?:async\s+)?\(/);
      if (arrowMatch) symbols.push(`  const ${arrowMatch[1]} (line ${lineNum})`);

      // Interfaces & Types
      const ifaceMatch = line.match(/^(?:export\s+)?interface\s+(\w+)/);
      if (ifaceMatch) symbols.push(`  interface ${ifaceMatch[1]} (line ${lineNum})`);

      const typeMatch = line.match(/^(?:export\s+)?type\s+(\w+)/);
      if (typeMatch) symbols.push(`  type ${typeMatch[1]} (line ${lineNum})`);

      // Methods inside classes
      const methodMatch = line.match(/^\s+(?:async\s+)?(?:private\s+|public\s+|protected\s+)?(\w+)\s*\([^)]*\)\s*[:{]/);
      if (methodMatch && !['if', 'for', 'while', 'switch', 'catch', 'constructor'].includes(methodMatch[1])) {
        symbols.push(`    method ${methodMatch[1]} (line ${lineNum})`);
      }
    }

    if (symbols.length === 0) return 'No symbols found.';
    return `Symbols in ${path.basename(filePath)}:\n${symbols.join('\n')}`;
  }

  private extractImports(filePath: string): string {
    const content = this.readFile(filePath);
    if (!content) return 'Error: could not read file';

    const imports: string[] = [];
    const lines = content.split('\n');

    for (const line of lines) {
      // ES imports
      const esMatch = line.match(/^import\s+.*from\s+['"]([^'"]+)['"]/);
      if (esMatch) { imports.push(`  ${esMatch[1]}`); continue; }

      // Require
      const reqMatch = line.match(/require\s*\(\s*['"]([^'"]+)['"]\s*\)/);
      if (reqMatch) { imports.push(`  ${reqMatch[1]}`); continue; }

      // Python imports
      const pyMatch = line.match(/^(?:from\s+(\S+)\s+)?import\s+(\S+)/);
      if (pyMatch && !line.includes('{')) {
        imports.push(`  ${pyMatch[1] || pyMatch[2]}`);
      }
    }

    if (imports.length === 0) return 'No imports found.';
    return `Imports in ${path.basename(filePath)}:\n${imports.join('\n')}`;
  }

  private buildOutline(targetPath: string): string {
    const stat = fs.statSync(targetPath);

    if (stat.isFile()) {
      return this.extractSymbols(targetPath);
    }

    // Directory outline
    const lines: string[] = [`Outline of ${path.basename(targetPath)}/`];
    this.walkDir(targetPath, '', lines, 0, 3);
    return lines.join('\n');
  }

  private walkDir(dir: string, prefix: string, lines: string[], depth: number, maxDepth: number): void {
    if (depth >= maxDepth) return;
    const skip = new Set(['node_modules', '.git', 'dist', 'build', 'coverage', '__pycache__', '.next']);

    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    const dirs = entries.filter(e => e.isDirectory() && !e.name.startsWith('.') && !skip.has(e.name));
    const files = entries.filter(e => e.isFile() && !e.name.startsWith('.'));

    for (const d of dirs.sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`${prefix}${d.name}/`);
      this.walkDir(path.join(dir, d.name), prefix + '  ', lines, depth + 1, maxDepth);
    }
    for (const f of files.sort((a, b) => a.name.localeCompare(b.name))) {
      lines.push(`${prefix}${f.name}`);
    }
  }

  private findReferences(targetPath: string, symbol: string): string {
    const stat = fs.statSync(targetPath);
    const dir = stat.isFile() ? path.dirname(targetPath) : targetPath;
    const results: string[] = [];
    const regex = new RegExp(`\\b${symbol.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\b`, 'g');

    this.searchRefs(dir, regex, results, 50);

    if (results.length === 0) return `No references to "${symbol}" found.`;
    return `References to "${symbol}":\n${results.join('\n')}`;
  }

  private searchRefs(dir: string, regex: RegExp, results: string[], max: number): void {
    if (results.length >= max) return;
    const skip = new Set(['node_modules', '.git', 'dist', 'build', 'coverage']);

    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }

    for (const entry of entries) {
      if (results.length >= max) break;
      if (entry.name.startsWith('.') || skip.has(entry.name)) continue;

      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        this.searchRefs(full, regex, results, max);
      } else {
        const ext = path.extname(entry.name);
        if (!['.ts', '.js', '.tsx', '.jsx', '.py', '.go', '.rs', '.java', '.rb', '.c', '.cpp', '.h'].includes(ext)) continue;
        try {
          const content = fs.readFileSync(full, 'utf-8');
          const lines = content.split('\n');
          for (let i = 0; i < lines.length && results.length < max; i++) {
            regex.lastIndex = 0;
            if (regex.test(lines[i])) {
              results.push(`  ${full}:${i + 1}: ${lines[i].trimEnd()}`);
            }
          }
        } catch { /* skip */ }
      }
    }
  }

  private readFile(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, 'utf-8');
    } catch { return null; }
  }
}
