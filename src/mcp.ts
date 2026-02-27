import { Tool } from './types';
import { execSync, spawn, ChildProcess } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';

/**
 * MCP (Model Context Protocol) client.
 *
 * Connects to MCP servers defined in `.codebot/mcp.json` or `~/.codebot/mcp.json`:
 *
 * {
 *   "servers": [
 *     {
 *       "name": "my-server",
 *       "command": "npx",
 *       "args": ["-y", "@my/mcp-server"],
 *       "env": {}
 *     }
 *   ]
 * }
 *
 * Each server is launched as a subprocess communicating via JSON-RPC over stdio.
 */

interface MCPServerConfig {
  name: string;
  command: string;
  args?: string[];
  env?: Record<string, string>;
}

interface MCPConfig {
  servers: MCPServerConfig[];
}

interface MCPToolDef {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
}

class MCPConnection {
  private process: ChildProcess;
  private buffer = '';
  private requestId = 0;
  private pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  name: string;

  constructor(config: MCPServerConfig) {
    this.name = config.name;
    this.process = spawn(config.command, config.args || [], {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: { ...process.env, ...config.env },
    });

    this.process.stdout?.on('data', (chunk: Buffer) => {
      this.buffer += chunk.toString();
      this.processBuffer();
    });

    this.process.on('error', () => { /* server failed to start */ });
  }

  private processBuffer() {
    const lines = this.buffer.split('\n');
    this.buffer = lines.pop() || '';

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const msg = JSON.parse(line);
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const { resolve, reject } = this.pending.get(msg.id)!;
          this.pending.delete(msg.id);
          if (msg.error) {
            reject(new Error(msg.error.message || 'MCP error'));
          } else {
            resolve(msg.result);
          }
        }
      } catch { /* skip malformed */ }
    }
  }

  async request(method: string, params?: Record<string, unknown>): Promise<unknown> {
    const id = ++this.requestId;
    const msg = JSON.stringify({ jsonrpc: '2.0', id, method, params }) + '\n';

    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.process.stdin?.write(msg);

      // Timeout after 30s
      setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`MCP request timeout: ${method}`));
        }
      }, 30000);
    });
  }

  async initialize(): Promise<void> {
    await this.request('initialize', {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'codebot-ai', version: '1.1.0' },
    });
    await this.request('notifications/initialized');
  }

  async listTools(): Promise<MCPToolDef[]> {
    const result = await this.request('tools/list') as { tools: MCPToolDef[] };
    return result?.tools || [];
  }

  async callTool(name: string, args: Record<string, unknown>): Promise<string> {
    const result = await this.request('tools/call', { name, arguments: args }) as {
      content?: Array<{ type: string; text?: string }>;
    };
    if (result?.content) {
      return result.content
        .filter(c => c.type === 'text')
        .map(c => c.text || '')
        .join('\n');
    }
    return JSON.stringify(result);
  }

  close() {
    this.process.kill();
  }
}

/** Create Tool wrappers from an MCP server's tools */
function mcpToolToTool(connection: MCPConnection, def: MCPToolDef): Tool {
  return {
    name: `mcp_${connection.name}_${def.name}`,
    description: `[MCP:${connection.name}] ${def.description}`,
    permission: 'prompt' as const,
    parameters: def.inputSchema || { type: 'object', properties: {} },
    execute: async (args: Record<string, unknown>) => {
      return connection.callTool(def.name, args);
    },
  };
}

/** Load MCP config and connect to all servers, returning Tool wrappers */
export async function loadMCPTools(projectRoot?: string): Promise<{ tools: Tool[]; cleanup: () => void }> {
  const tools: Tool[] = [];
  const connections: MCPConnection[] = [];

  const configPaths = [
    path.join(os.homedir(), '.codebot', 'mcp.json'),
  ];
  if (projectRoot) {
    configPaths.push(path.join(projectRoot, '.codebot', 'mcp.json'));
  }

  for (const configPath of configPaths) {
    if (!fs.existsSync(configPath)) continue;

    let config: MCPConfig;
    try {
      config = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
    } catch {
      continue;
    }

    for (const serverConfig of config.servers || []) {
      try {
        const conn = new MCPConnection(serverConfig);
        await conn.initialize();
        const serverTools = await conn.listTools();

        for (const toolDef of serverTools) {
          tools.push(mcpToolToTool(conn, toolDef));
        }

        connections.push(conn);
      } catch (err) {
        console.error(`MCP server "${serverConfig.name}" failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return {
    tools,
    cleanup: () => connections.forEach(c => c.close()),
  };
}
