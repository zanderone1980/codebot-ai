import { Tool } from '../types';
import { codebotPath } from '../paths';
import { MemoryManager } from '../memory';

export class MemoryTool implements Tool {
  name = 'memory';
  description = 'Read or write persistent memory. Memory survives across sessions and is always available to you. Use this to remember important context, user preferences, project patterns, or anything worth keeping.';
  permission: Tool['permission'] = 'auto';
  parameters = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action: "read" to view memory, "write" to add/update, "list" to show all files',
        enum: ['read', 'write', 'list'],
      },
      scope: {
        type: 'string',
        description: 'Scope: "global" for all projects, "project" for current project',
        enum: ['global', 'project'],
      },
      content: {
        type: 'string',
        description: 'Content to write (for write action)',
      },
      file: {
        type: 'string',
        description: 'Topic file name (e.g., "patterns" creates patterns.md). Omit for main MEMORY.md',
      },
    },
    required: ['action'],
  };

  private memory: MemoryManager;

  constructor(projectRoot?: string) {
    this.memory = new MemoryManager(projectRoot);
  }

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = args.action as string;
    const scope = (args.scope as string) || 'project';
    const content = args.content as string | undefined;
    const file = args.file as string | undefined;

    switch (action) {
      case 'read': {
        if (file) {
          return this.readTopicFile(scope, file);
        }
        const result = scope === 'global'
          ? this.memory.readGlobal()
          : this.memory.readProject();
        return result || '(empty — no memory saved yet)';
      }

      case 'write': {
        if (!content) return 'Error: content is required for write action';
        if (file) {
          return this.writeTopicFile(scope, file, content);
        }
        if (scope === 'global') {
          this.memory.appendGlobal(content);
        } else {
          this.memory.appendProject(content);
        }
        return `Memory updated (${scope}).`;
      }

      case 'list': {
        const files = this.memory.list();
        if (files.length === 0) return 'No memory files yet.';
        return files
          .map(f => `[${f.scope}] ${f.file} (${f.size} bytes)`)
          .join('\n');
      }

      default:
        return `Error: Unknown action "${action}". Use read, write, or list.`;
    }
  }

  private getMemoryDir(scope: string): string {
    const path = require('path');
    if (scope === 'global') {
      return codebotPath('memory');
    }
    return path.join(process.cwd(), '.codebot', 'memory');
  }

  private sanitizeFileName(file: string): string {
    const path = require('path');
    // Strip path traversal — only allow the basename
    const base = path.basename(file);
    return base.endsWith('.md') ? base : `${base}.md`;
  }

  private readTopicFile(scope: string, file: string): string {
    const fs = require('fs');
    const path = require('path');
    const fileName = this.sanitizeFileName(file);
    const dir = this.getMemoryDir(scope);
    const filePath = path.join(dir, fileName);
    if (fs.existsSync(filePath)) {
      return fs.readFileSync(filePath, 'utf-8');
    }
    return `(no file: ${fileName})`;
  }

  private writeTopicFile(scope: string, file: string, content: string): string {
    const fs = require('fs');
    const path = require('path');
    const fileName = this.sanitizeFileName(file);
    const dir = this.getMemoryDir(scope);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, fileName), content);
    return `Wrote ${fileName} (${scope}).`;
  }
}
