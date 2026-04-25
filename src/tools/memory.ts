import { Tool, CapabilityLabel } from '../types';
import { MemoryManager } from '../memory';

export class MemoryTool implements Tool {
  name = 'memory';
  description = 'Read or write persistent memory. Memory survives across sessions and is always available to you. Use this to remember important context, user preferences, project patterns, or anything worth keeping.';
  permission: Tool['permission'] = 'auto';
  capabilities: CapabilityLabel[] = ['write-fs'];
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
          return this.memory.readFile(this.toScope(scope), file);
        }
        const result = scope === 'global'
          ? this.memory.readGlobal()
          : this.memory.readProject();
        return result || '(empty — no memory saved yet)';
      }

      case 'write': {
        if (!content) return 'Error: content is required for write action';
        if (file) {
          return this.memory.writeFile(this.toScope(scope), file, content);
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

  private toScope(scope: string): 'global' | 'project' {
    return scope === 'global' ? 'global' : 'project';
  }
}
