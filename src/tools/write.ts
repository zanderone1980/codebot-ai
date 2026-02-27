import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Tool } from '../types';

const UNDO_DIR = path.join(os.homedir(), '.codebot', 'undo');

export class WriteFileTool implements Tool {
  name = 'write_file';
  description = 'Create a new file or overwrite an existing file with the given content. Automatically saves an undo snapshot for existing files.';
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
    if (!args.path || typeof args.path !== 'string') {
      return 'Error: path is required';
    }
    if (args.content === undefined || args.content === null) {
      return 'Error: content is required';
    }
    const filePath = path.resolve(args.path);
    const content = String(args.content);
    const dir = path.dirname(filePath);

    if (!fs.existsSync(dir)) {
      fs.mkdirSync(dir, { recursive: true });
    }

    const existed = fs.existsSync(filePath);

    // Save undo snapshot before overwriting
    if (existed) {
      try {
        const oldContent = fs.readFileSync(filePath, 'utf-8');
        this.saveSnapshot(filePath, oldContent);
      } catch { /* best effort */ }
    }

    fs.writeFileSync(filePath, content, 'utf-8');

    const lines = content.split('\n').length;
    return `${existed ? 'Overwrote' : 'Created'} ${filePath} (${lines} lines, ${content.length} bytes)`;
  }

  private saveSnapshot(filePath: string, content: string) {
    try {
      fs.mkdirSync(UNDO_DIR, { recursive: true });
      const manifestPath = path.join(UNDO_DIR, 'manifest.json');
      let manifest: Array<{ file: string; timestamp: number; snapshotFile: string }> = [];
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      } catch { /* empty */ }

      const entry = {
        file: filePath,
        timestamp: Date.now(),
        snapshotFile: `${Date.now()}-${path.basename(filePath)}`,
      };
      fs.writeFileSync(path.join(UNDO_DIR, entry.snapshotFile), content);
      manifest.push(entry);

      while (manifest.length > 50) {
        const old = manifest.shift()!;
        try { fs.unlinkSync(path.join(UNDO_DIR, old.snapshotFile)); } catch { /* ok */ }
      }

      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    } catch { /* best effort */ }
  }
}
