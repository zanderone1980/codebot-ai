import * as fs from 'fs';
import * as path from 'path';
import { Tool } from '../types';
import { isPathSafe } from '../security';
import { scanForSecrets } from '../secrets';
import { PolicyEnforcer } from '../policy';

interface EditOperation {
  path: string;
  old_string: string;
  new_string: string;
}

export class BatchEditTool implements Tool {
  name = 'batch_edit';
  description = 'Apply multiple find-and-replace edits across one or more files atomically. All edits are validated before any are applied. Useful for renaming, refactoring, and coordinated multi-file changes.';
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
      edits: {
        type: 'array',
        description: 'Array of edit operations: [{path, old_string, new_string}, ...]',
        items: {
          type: 'object',
          properties: {
            path: { type: 'string', description: 'File path' },
            old_string: { type: 'string', description: 'Exact string to find' },
            new_string: { type: 'string', description: 'Replacement string' },
          },
          required: ['path', 'old_string', 'new_string'],
        },
      },
    },
    required: ['edits'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const edits = args.edits as EditOperation[];
    if (!edits || !Array.isArray(edits) || edits.length === 0) {
      return 'Error: edits array is required and must not be empty';
    }

    const projectRoot = this.projectRoot;

    // Phase 1: Validate all edits before applying any
    const errors: string[] = [];
    const warnings: string[] = [];
    const validated: Array<{ filePath: string; content: string; updated: string; edit: EditOperation }> = [];

    // Group edits by file so we can chain them
    const byFile = new Map<string, EditOperation[]>();
    for (const edit of edits) {
      if (!edit.path || !edit.old_string === undefined) {
        errors.push(`Invalid edit: missing path or old_string`);
        continue;
      }
      const filePath = path.resolve(this.projectRoot, edit.path);

      // Security: path safety check
      const safety = isPathSafe(filePath, projectRoot);
      if (!safety.safe) {
        errors.push(`${safety.reason}`);
        continue;
      }

      // Policy: filesystem restrictions
      if (this.policyEnforcer) {
        const policyCheck = this.policyEnforcer.isPathWritable(filePath);
        if (!policyCheck.allowed) {
          errors.push(`Blocked by policy — ${policyCheck.reason}`);
          continue;
        }
      }

      // Lookup-or-create in one place so we never need `!` on the get().
      let list = byFile.get(filePath);
      if (!list) {
        list = [];
        byFile.set(filePath, list);
      }
      list.push(edit);
    }

    for (const [filePath, fileEdits] of byFile) {
      if (!fs.existsSync(filePath)) {
        errors.push(`File not found: ${filePath}`);
        continue;
      }

      let content = fs.readFileSync(filePath, 'utf-8');
      const originalContent = content;

      for (const edit of fileEdits) {
        const oldStr = String(edit.old_string);
        const newStr = String(edit.new_string);
        const count = content.split(oldStr).length - 1;

        if (count === 0) {
          errors.push(`String not found in ${filePath}: "${oldStr.substring(0, 60)}${oldStr.length > 60 ? '...' : ''}"`);
          continue;
        }
        if (count > 1) {
          errors.push(`String found ${count} times in ${filePath} (must be unique): "${oldStr.substring(0, 60)}${oldStr.length > 60 ? '...' : ''}"`);
          continue;
        }

        // Security: secret detection on new content
        const secrets = scanForSecrets(newStr);
        if (secrets.length > 0) {
          warnings.push(`Secrets detected in edit for ${filePath}: ${secrets.map(s => `${s.type} (${s.snippet})`).join(', ')}`);
        }

        content = content.replace(oldStr, newStr);
      }

      if (content !== originalContent) {
        validated.push({ filePath, content: originalContent, updated: content, edit: fileEdits[0] });
      }
    }

    if (errors.length > 0) {
      return `Validation failed (no changes made):\n${errors.map(e => `  - ${e}`).join('\n')}`;
    }

    // Phase 2: Apply all edits atomically
    const results: string[] = [];
    for (const { filePath, updated } of validated) {
      fs.writeFileSync(filePath, updated, 'utf-8');
      results.push(filePath);
    }

    const fileCount = validated.length;
    const editCount = edits.length;
    let output = `Applied ${editCount} edit${editCount > 1 ? 's' : ''} across ${fileCount} file${fileCount > 1 ? 's' : ''}:\n${results.map(f => `  ✓ ${f}`).join('\n')}`;

    if (warnings.length > 0) {
      output += `\n\n⚠️  Security warnings:\n${warnings.map(w => `  - ${w}`).join('\n')}`;
    }

    return output;
  }
}
