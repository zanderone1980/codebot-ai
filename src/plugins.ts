import * as fs from 'fs';
import * as path from 'path';
import { codebotPath } from './paths';
import * as crypto from 'crypto';
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
 *
 * Security: Each plugin MUST have an accompanying plugin.json manifest with a SHA-256 hash.
 * Plugins without a valid manifest or with a hash mismatch are skipped.
 */

interface PluginManifest {
  name: string;
  version: string;
  hash: string; // "sha256:abc123..."
}

export function loadPlugins(projectRoot?: string): Tool[] {
  const plugins: Tool[] = [];
  const dirs = [
    codebotPath('plugins'),
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

        // Security: verify plugin against manifest hash
        const manifestPath = path.join(dir, 'plugin.json');
        if (!fs.existsSync(manifestPath)) {
          console.error(`Plugin skipped (${entry.name}): no plugin.json manifest found. Create one with: { "name": "...", "version": "...", "hash": "sha256:..." }`);
          continue;
        }

        let manifest: PluginManifest;
        try {
          manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        } catch {
          console.error(`Plugin skipped (${entry.name}): invalid plugin.json manifest`);
          continue;
        }

        if (!manifest.hash || !manifest.hash.startsWith('sha256:')) {
          console.error(`Plugin skipped (${entry.name}): manifest missing valid sha256 hash`);
          continue;
        }

        // Compute SHA-256 of the plugin file
        const pluginContent = fs.readFileSync(pluginPath);
        const computedHash = 'sha256:' + crypto.createHash('sha256').update(pluginContent).digest('hex');

        if (computedHash !== manifest.hash) {
          console.error(`Plugin skipped (${entry.name}): hash mismatch. Expected ${manifest.hash}, got ${computedHash}. Plugin may have been tampered with.`);
          continue;
        }

        // Hash verified — safe to load
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
