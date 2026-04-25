import * as fs from 'fs';
import * as path from 'path';
import { Tool, CapabilityLabel } from '../types';
import { isPathSafe } from '../security';
import { checkSecretsForWrite } from '../secret-guard';
import { PolicyEnforcer } from '../policy';
import { codebotPath } from '../paths';



export class WriteFileTool implements Tool {
  name = 'write_file';
  description = 'Create a new file or overwrite an existing file with the given content. Automatically saves an undo snapshot for existing files.';
  permission: Tool['permission'] = 'prompt';
  capabilities: CapabilityLabel[] = ['write-fs'];
  private projectRoot: string;
  private policyEnforcer?: PolicyEnforcer;

  constructor(policyEnforcer?: PolicyEnforcer, projectRoot?: string) {
    this.projectRoot = projectRoot || process.cwd();
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
    const filePath = path.resolve(this.projectRoot, args.path);
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


    // Safety: protect critical project files from accidental overwrite
    const basename = path.basename(filePath);
    const PROTECTED_FILES = new Set([
      'package.json', 'package-lock.json', 'tsconfig.json', 'tsconfig.build.json',
      '.env', '.env.local', '.env.production', '.gitignore', '.npmrc',
      'yarn.lock', 'pnpm-lock.yaml', 'Cargo.lock', 'go.sum',
    ]);
    if (fs.existsSync(filePath) && PROTECTED_FILES.has(basename)) {
      // Only allow overwrite if content looks like an edit (not a complete replacement)
      try {
        const oldContent = fs.readFileSync(filePath, 'utf-8');
        const oldName = JSON.parse(oldContent).name;
        const newName = (() => { try { return JSON.parse(content).name; } catch { return null; } })();
        if (oldName && newName && oldName !== newName) {
          return `Error: Blocked — refusing to overwrite ${basename} (project name would change from "${oldName}" to "${newName}"). This looks like an accidental overwrite, not an edit. Use edit_file for targeted changes.`;
        }
      } catch { /* not JSON, allow */ }
    }

    // Security: secret detection — respect policy.secrets.block_on_detect.
    // Default policy blocks; explicit opt-out via policy.secrets is still
    // honored (see src/secret-guard.ts).
    const guard = checkSecretsForWrite(content, this.policyEnforcer, filePath);
    if (guard.block) return guard.error!;
    const warning = guard.warning;

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
