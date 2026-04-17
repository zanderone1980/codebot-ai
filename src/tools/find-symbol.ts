/**
 * find_symbol — RFC 001 Part A tool.
 *
 * Answers "where is symbol X defined?" by walking the project with a
 * regex-based indexer (see src/symbol-indexer.ts). Returns matches
 * with file path, line number, symbol kind, and language.
 *
 * Why this tool exists: the 50-task SWE-bench run showed that ~32% of
 * wrong-patch failures came from CodeBot editing the wrong file.
 * grep returns every textual hit; `find_symbol` returns only places
 * the name is *declared*, which is what "where is X defined" actually
 * means. Top open-source agents (Aider, SWE-agent) have variants of
 * this.
 */

import { Tool } from '../types';
import { SymbolIndexer, SymbolEntry } from '../symbol-indexer';

export class FindSymbolTool implements Tool {
  name = 'find_symbol';
  description =
    'Find where a symbol (class, function, interface, type, method, etc.) is DEFINED ' +
    'in the project. Much more precise than grep for localization: grep finds every ' +
    'textual mention, find_symbol finds only declaration sites. ' +
    'Supports exact name, prefix (e.g. "Related*"), or substring match. ' +
    'Indexes Python, TypeScript, JavaScript, Go, Rust, Ruby, Java. Use this as ' +
    'the FIRST STEP when you need to navigate a codebase to find where to edit.';
  permission: Tool['permission'] = 'auto';
  cacheable = true;

  parameters = {
    type: 'object',
    properties: {
      name: {
        type: 'string',
        description:
          'The symbol name to find. Case-sensitive for exact match, case-insensitive ' +
          'for prefix/substring. Examples: "RelatedFieldListFilter", "get_choices".',
      },
      match: {
        type: 'string',
        enum: ['exact', 'prefix', 'substring'],
        description:
          'How to match: "exact" (default) for a precise name, "prefix" for '
          + 'names starting with the query, "substring" for names containing the query.',
      },
      kind: {
        type: 'string',
        description:
          'Optional filter: class, function, method, interface, type, enum, struct, '
          + 'trait, module, const. Leave empty to match any kind.',
      },
      limit: {
        type: 'number',
        description: 'Cap on results returned (default 25).',
      },
    },
    required: ['name'],
  };

  private indexer: SymbolIndexer;

  constructor(projectRoot?: string) {
    this.indexer = new SymbolIndexer(projectRoot || process.cwd());
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const name = (args.name as string) || '';
    if (!name.trim()) return 'Error: name is required';
    const match = ((args.match as string) || 'exact').toLowerCase();
    const kind = args.kind ? String(args.kind).toLowerCase() : '';
    const limit = Math.max(1, Math.min(500, Number(args.limit) || 25));

    let hits: SymbolEntry[];
    switch (match) {
      case 'exact':
        hits = this.indexer.findByName(name);
        break;
      case 'prefix':
        hits = this.indexer.findByPrefix(name);
        break;
      case 'substring':
        hits = this.indexer.findBySubstring(name);
        break;
      default:
        return `Error: unknown match type "${match}". Use exact, prefix, or substring.`;
    }

    if (kind) {
      hits = hits.filter((h) => h.kind === kind);
    }

    if (hits.length === 0) {
      const sizeHint = this.indexer.stats().totalSymbols;
      return `No symbols found matching ${match}:${JSON.stringify(name)}${kind ? ` kind:${kind}` : ''}. ` +
             `(Index contains ${sizeHint} symbols total.)`;
    }

    // Stable sort by file path then line, so output is deterministic
    hits.sort((a, b) => {
      if (a.file !== b.file) return a.file.localeCompare(b.file);
      return a.line - b.line;
    });

    const truncated = hits.length > limit;
    const shown = hits.slice(0, limit);
    const lines = shown.map((h) => `  ${h.file}:${h.line}  [${h.kind} ${h.lang}]  ${h.name}`);
    const header = `Found ${hits.length} symbol${hits.length === 1 ? '' : 's'} matching ${match}:${JSON.stringify(name)}` +
                   (kind ? ` kind:${kind}` : '') +
                   (truncated ? ` (showing first ${limit})` : '');
    return `${header}\n${lines.join('\n')}`;
  }
}
