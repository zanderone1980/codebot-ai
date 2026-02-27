import * as fs from 'fs';
import * as path from 'path';
import { Tool } from '../types';

export class WriteFileTool implements Tool {
  name = 'write_file';
  description = 'Create a new file or overwrite an existing file with the given content.';
  permission: Tool['permission'] = 'prompt';
  parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to write' },
      content: { type: 'string', description: 'Content to write to the file' },
    },
    required: ['path', 'content'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const filePath = path.resolve(args.path as string);
    const content = args.content as string;
    const dir = path.dirname(filePath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const existed = fs.existsSync(filePath);
    fs.writeFileSync(filePath, content, 'utf-8');

    const lines = content.split('\n').length;
    return `${existed ? 'Overwrote' : 'Created'} ${filePath} (${lines} lines, ${content.length} bytes)`;
  }
}
