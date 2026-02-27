import { Tool, ToolSchema } from '../types';
import { ReadFileTool } from './read';
import { WriteFileTool } from './write';
import { EditFileTool } from './edit';
import { ExecuteTool } from './execute';
import { GlobTool } from './glob';
import { GrepTool } from './grep';
import { ThinkTool } from './think';
import { MemoryTool } from './memory';
import { WebFetchTool } from './web-fetch';
import { BrowserTool } from './browser';

export class ToolRegistry {
  private tools: Map<string, Tool> = new Map();

  constructor(projectRoot?: string) {
    this.register(new ReadFileTool());
    this.register(new WriteFileTool());
    this.register(new EditFileTool());
    this.register(new ExecuteTool());
    this.register(new GlobTool());
    this.register(new GrepTool());
    this.register(new ThinkTool());
    this.register(new MemoryTool(projectRoot));
    this.register(new WebFetchTool());
    this.register(new BrowserTool());
  }

  register(tool: Tool) {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  getSchemas(): ToolSchema[] {
    return Array.from(this.tools.values()).map(t => ({
      type: 'function' as const,
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  all(): Tool[] {
    return Array.from(this.tools.values());
  }
}
