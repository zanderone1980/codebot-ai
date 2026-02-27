import * as fs from 'fs';
import * as path from 'path';
import { Tool } from './types';

/**
 * Plugin system for CodeBot.
 *
 * Plugins are .js files in `.codebot/plugins/` (project) or `~/.codebot/plugins/` (global).
 * Each plugin exports a default function or object that implements the Tool interface:
 *
 * module.exports = {
 *   name: 'my_tool',
 *   description: 'Does something useful',
 *   permission: 'prompt',
 *   parameters: { type: 'object', properties: { ... }, required: [...] },
 *   execute: async (args) => { return 'result'; }
 * };
 */

export function loadPlugins(projectRoot?: string): Tool[] {
  const plugins: Tool[] = [];
  const os = require('os');

  const dirs = [
    path.join(os.homedir(), '.codebot', 'plugins'),
  ];

  if (projectRoot) {
    dirs.push(path.join(projectRoot, '.codebot', 'plugins'));
  }

  for (const dir of dirs) {
    if (!fs.existsSync(dir)) continue;

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }

    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith('.js')) continue;

      try {
        const pluginPath = path.join(dir, entry.name);
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const mod = require(pluginPath);
        const plugin = mod.default || mod;

        if (isValidTool(plugin)) {
          plugins.push(plugin);
        }
      } catch (err) {
        console.error(`Plugin load error (${entry.name}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return plugins;
}

function isValidTool(obj: unknown): obj is Tool {
  if (!obj || typeof obj !== 'object') return false;
  const t = obj as Record<string, unknown>;
  return (
    typeof t.name === 'string' &&
    typeof t.description === 'string' &&
    typeof t.execute === 'function' &&
    typeof t.parameters === 'object' &&
    typeof t.permission === 'string'
  );
}
