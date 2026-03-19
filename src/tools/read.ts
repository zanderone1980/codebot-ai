import * as fs from 'fs';
import * as path from 'path';
import { Tool } from '../types';

export class ReadFileTool implements Tool {
  name = 'read_file';
  description = 'Read the contents of a file. Returns file content with line numbers.';
  permission: Tool['permission'] = 'auto';
  cacheable = true;
  private projectRoot: string;
  constructor(projectRoot?: string) { this.projectRoot = projectRoot || process.cwd(); }
  parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to read' },
      offset: { type: 'number', description: 'Line number to start from (1-based). Optional.' },
      limit: { type: 'number', description: 'Max number of lines to read. Optional.' },
    },
    required: ['path'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    if (!args.path || typeof args.path !== 'string') {
      return 'Error: path is required';
    }
    const filePath = path.resolve(this.projectRoot, args.path);

    if (!fs.existsSync(filePath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    const stat = fs.statSync(filePath);
    if (stat.isDirectory()) {
      throw new Error(`Path is a directory: ${filePath}. Use glob to list files.`);
    }

    if (stat.size > 2 * 1024 * 1024) {
      throw new Error(`File too large (${Math.round(stat.size / 1024)}KB). Use offset/limit to read in chunks.`);
    }

    const content = fs.readFileSync(filePath, 'utf-8');
    const lines = content.split('\n');
    const offset = Math.max(0, ((args.offset as number) || 1) - 1);
    const limit = (args.limit as number) || lines.length;
    const slice = lines.slice(offset, offset + limit);

    return slice
      .map((line, i) => `${String(offset + i + 1).padStart(5)}\t${line}`)
      .join('\n');
  }
}
