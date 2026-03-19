import * as fs from 'fs';
import * as path from 'path';
import { Tool } from '../types';
import { isPathSafe } from '../security';
import { scanForSecrets } from '../secrets';
import { PolicyEnforcer } from '../policy';
import { codebotPath } from '../paths';
import { warnNonFatal } from '../warn';

// Undo snapshot directory

const MAX_UNDO = 50;

export class EditFileTool implements Tool {
  name = 'edit_file';
  description = 'Edit a file by replacing an exact string match with new content. The old_string must appear exactly once in the file. Shows a diff preview and creates an undo snapshot.';
  permission: Tool['permission'] = 'prompt';
  private projectRoot: string;
  private policyEnforcer?: PolicyEnforcer;

  constructor(policyEnforcer?: PolicyEnforcer, projectRoot?: string) {
    this.projectRoot = projectRoot || process.cwd();
    this.policyEnforcer = policyEnforcer;
  }
  parameters = {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Path to the file to edit' },
      old_string: { type: 'string', description: 'Exact string to find (must be unique in the file)' },
      new_string: { type: 'string', description: 'Replacement string' },
    },
    required: ['path', 'old_string', 'new_string'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    if (!args.path || typeof args.path !== 'string') {
      return 'Error: path is required';
    }
    if (args.old_string === undefined || args.old_string === null) {
      return 'Error: old_string is required';
    }
    if (args.new_string === undefined || args.new_string === null) {
      return 'Error: new_string is required';
    }
    const filePath = path.resolve(this.projectRoot, args.path);
    const oldStr = String(args.old_string);
    const newStr = String(args.new_string);

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

    // Security: resolve symlinks before reading
    let realPath: string;
    try {
      realPath = fs.realpathSync(filePath);
    } catch {
      throw new Error(`File not found: ${filePath}`);
    }

    if (!fs.existsSync(realPath)) {
      throw new Error(`File not found: ${filePath}`);
    }

    // Security: secret detection on new content (warn but don't block)
    const secrets = scanForSecrets(newStr);
    let warning = '';
    if (secrets.length > 0) {
      warning = `\n\n⚠️  WARNING: ${secrets.length} potential secret(s) in new content:\n` +
        secrets.map(s => `  ${s.type} — ${s.snippet}`).join('\n') +
        '\nConsider using environment variables instead of hardcoding secrets.';
    }

    const content = fs.readFileSync(realPath, 'utf-8');
    const count = content.split(oldStr).length - 1;

    if (count === 0) {
      throw new Error(`String not found in ${filePath}. Make sure old_string matches exactly (including whitespace).`);
    }
    if (count > 1) {
      throw new Error(`String found ${count} times in ${filePath}. Provide more surrounding context to make it unique.`);
    }

    // Save undo snapshot
    this.saveSnapshot(realPath, content);

    const updated = content.replace(oldStr, newStr);
    fs.writeFileSync(realPath, updated, 'utf-8');

    // Generate diff preview
    const diff = this.generateDiff(oldStr, newStr, content, filePath);
    return diff + warning;
  }

  private generateDiff(oldStr: string, newStr: string, content: string, filePath: string): string {
    const lines = content.split('\n');
    const matchIdx = content.indexOf(oldStr);
    const linesBefore = content.substring(0, matchIdx).split('\n');
    const startLine = linesBefore.length;

    const oldLines = oldStr.split('\n');
    const newLines = newStr.split('\n');

    let diff = `Edited ${filePath}\n`;

    // Show context (2 lines before)
    const contextStart = Math.max(0, startLine - 3);
    for (let i = contextStart; i < startLine - 1; i++) {
      diff += `  ${i + 1} │ ${lines[i]}\n`;
    }

    // Show removed lines
    for (const line of oldLines) {
      diff += `  - │ ${line}\n`;
    }

    // Show added lines
    for (const line of newLines) {
      diff += `  + │ ${line}\n`;
    }

    // Show context (2 lines after)
    const endLine = startLine - 1 + oldLines.length;
    for (let i = endLine; i < Math.min(lines.length, endLine + 2); i++) {
      diff += `  ${i + 1} │ ${lines[i]}\n`;
    }

    return diff.trimEnd();
  }

  /** Save a snapshot for undo */
  private saveSnapshot(filePath: string, content: string) {
    try {
      fs.mkdirSync(codebotPath('undo'), { recursive: true });

      const manifest = this.loadManifest();
      const entry = {
        file: filePath,
        timestamp: Date.now(),
        snapshotFile: `${Date.now()}-${path.basename(filePath)}`,
      };

      // Write snapshot content
      fs.writeFileSync(path.join(codebotPath('undo'), entry.snapshotFile), content);

      manifest.push(entry);

      // Prune old snapshots
      while (manifest.length > MAX_UNDO) {
        const old = manifest.shift()!;
        try { fs.unlinkSync(path.join(codebotPath('undo'), old.snapshotFile)); } catch { /* ok */ }
      }

      fs.writeFileSync(path.join(codebotPath('undo'), 'manifest.json'), JSON.stringify(manifest, null, 2));
    } catch {
      // Best-effort, don't fail the edit
    }
  }

  private loadManifest(): Array<{ file: string; timestamp: number; snapshotFile: string }> {
    try {
      const raw = fs.readFileSync(path.join(codebotPath('undo'), 'manifest.json'), 'utf-8');
      return JSON.parse(raw);
    } catch {
      return [];
    }
  }

  /** Undo the last edit to a file. Returns result message. */
  static undo(filePath?: string): string {
    try {
      const manifestPath = path.join(codebotPath('undo'), 'manifest.json');
      if (!fs.existsSync(manifestPath)) return 'No undo history available.';

      const manifest: Array<{ file: string; timestamp: number; snapshotFile: string }> =
        JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));

      if (manifest.length === 0) return 'No undo history available.';

      // Find the entry to undo
      let entry;
      if (filePath) {
        const resolved = path.resolve(filePath);
        for (let i = manifest.length - 1; i >= 0; i--) {
          if (manifest[i].file === resolved) {
            entry = manifest.splice(i, 1)[0];
            break;
          }
        }
        if (!entry) return `No undo history for ${filePath}`;
      } else {
        entry = manifest.pop()!;
      }

      // Restore the snapshot
      const snapshotPath = path.join(codebotPath('undo'), entry.snapshotFile);
      if (!fs.existsSync(snapshotPath)) return 'Snapshot file missing.';

      const content = fs.readFileSync(snapshotPath, 'utf-8');
      fs.writeFileSync(entry.file, content, 'utf-8');

      // Cleanup
      try { fs.unlinkSync(snapshotPath); } catch { /* ok */ }
      fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

      return `Restored ${entry.file} to state before last edit.`;
    } catch (err) {
      return `Undo failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  }
}
