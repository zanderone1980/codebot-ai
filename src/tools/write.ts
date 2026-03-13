import * as fs from 'fs';
import * as path from 'path';
import { Tool } from '../types';
import { isPathSafe } from '../security';
import { scanForSecrets } from '../secrets';
import { PolicyEnforcer } from '../policy';
import { codebotPath } from '../paths';
import { warnNonFatal } from '../warn';



export class WriteFileTool implements Tool {
  name = 'write_file';
  description = 'Create a new file or overwrite an existing file with the given content. Automatically saves an undo snapshot for existing files.';
  permission: Tool['permission'] = 'prompt';
  private policyEnforcer?: PolicyEnforcer;

  constructor(policyEnforcer?: PolicyEnforcer) {
    this.policyEnforcer = policyEnforcer;
  }
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

    // Security: path safety check
    const projectRoot = process.cwd();
    const safety = isPathSafe(filePath, projectRoot);
    if (!safety.safe) {
      return `Error: ${safety.reason}`;
    }

    // Policy: filesystem restrictions (denied paths, read-only, writable scope)
    if (this.policyEnforcer) {
      const policyCheck = this.policyEnforcer.isPathWritable(filePath);
      if (!policyCheck.allowed) {
        return `Error: Blocked by policy — ${policyCheck.reason}`;
      }
    }

    // Security: secret detection (warn but don't block)
    const secrets = scanForSecrets(content);
    let warning = '';
    if (secrets.length > 0) {
      warning = `\n\n⚠️  WARNING: ${secrets.length} potential secret(s) detected:\n` +
        secrets.map(s => `  Line ${s.line}: ${s.type} — ${s.snippet}`).join('\n') +
        '\nConsider using environment variables instead of hardcoding secrets.';
    }

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
    return `${existed ? 'Overwrote' : 'Created'} ${filePath} (${lines} lines, ${content.length} bytes)${warning}`;
  }

  private saveSnapshot(filePath: string, content: string) {
    try {
      fs.mkdirSync(codebotPath('undo'), { recursive: true });
      const manifestPath = path.join(codebotPath('undo'), 'manifest.json');
      let manifest: Array<{ file: string; timestamp: number; snapshotFile: string }> = [];
      try {
        manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
      } catch { /* empty */ }

      const entry = {
        file: filePath,
        timestamp: Date.now(),
        snapshotFile: `${Date.now()}-${path.basename(filePath)}`,
      };
      fs.writeFileSync(path.join(codebotPath('undo'), entry.snapshotFile), content);
      manifest.push(entry);

      while (manifest.length > 50) {
        const old = manifest.shift()!;
        try { fs.unlinkSync(path.join(codebotPath('undo'), old.snapshotFile)); } catch { /* ok */ }
      }

      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));
    } catch { /* best effort */ }
  }
}
