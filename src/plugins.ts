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


/** Validate plugin manifest fields (lightweight, no external deps) */
function validateManifest(manifest: Record<string, unknown>, fileName: string): string | null {
  if (typeof manifest.name !== 'string' || !manifest.name) {
    return `Plugin skipped (${fileName}): manifest "name" must be a non-empty string`;
  }
  if (!/^[a-zA-Z0-9_-]+$/.test(manifest.name)) {
    return `Plugin skipped (${fileName}): manifest "name" contains invalid characters (use a-z, 0-9, - _)`;
  }
  if (typeof manifest.version !== 'string' || !/^\d+\.\d+/.test(manifest.version)) {
    return `Plugin skipped (${fileName}): manifest "version" must be a semver string (e.g. "1.0.0")`;
  }
  if (typeof manifest.hash !== 'string' || !manifest.hash.startsWith('sha256:')) {
    return `Plugin skipped (${fileName}): manifest "hash" must start with "sha256:"`;
  }
  if (manifest.hash.length !== 71) { // "sha256:" (7) + 64 hex chars
    return `Plugin skipped (${fileName}): manifest "hash" must be sha256:<64 hex chars>`;
  }
  const known = new Set(['name', 'version', 'hash', 'description', 'author', 'permissions']);
  for (const key of Object.keys(manifest)) {
    if (!known.has(key)) {
      console.warn(`Plugin warning (${fileName}): unknown manifest field "${key}"`);
    }
  }
  return null; // valid
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

        const validationError = validateManifest(manifest as unknown as Record<string, unknown>, entry.name);
        if (validationError) {
          console.error(validationError);
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
          // Validate tool parameter schema
          const schemaError = validateToolSchema(plugin.parameters, entry.name);
          if (schemaError) {
            console.error(`Plugin skipped (${entry.name}): invalid parameter schema — ${schemaError}`);
            continue;
          }
          plugins.push(plugin);
        }
      } catch (err) {
        console.error(`Plugin load error (${entry.name}): ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  }

  return plugins;
}

/** Validate a plugin tool's parameter schema against JSON Schema conventions */
function validateToolSchema(params: unknown, pluginName: string): string | null {
  if (!params || typeof params !== 'object') return 'parameters must be an object';
  const schema = params as Record<string, unknown>;

  if (schema.type !== 'object') return 'parameters.type must be "object"';
  if (!schema.properties || typeof schema.properties !== 'object') {
    return 'parameters.properties must be an object';
  }

  const props = schema.properties as Record<string, unknown>;
  const validTypes = new Set(['string', 'number', 'boolean', 'object', 'array', 'integer']);

  for (const [key, val] of Object.entries(props)) {
    if (!val || typeof val !== 'object') {
      return `parameters.properties.${key} must be an object`;
    }
    const prop = val as Record<string, unknown>;
    if (typeof prop.type !== 'string' || !validTypes.has(prop.type)) {
      return `parameters.properties.${key}.type must be one of: ${[...validTypes].join(', ')}`;
    }
    if (prop.description !== undefined && typeof prop.description !== 'string') {
      return `parameters.properties.${key}.description must be a string`;
    }
    if (prop.enum !== undefined && !Array.isArray(prop.enum)) {
      return `parameters.properties.${key}.enum must be an array`;
    }
  }

  if (schema.required !== undefined) {
    if (!Array.isArray(schema.required)) return 'parameters.required must be an array';
    for (const req of schema.required) {
      if (typeof req !== 'string') return 'parameters.required entries must be strings';
      if (!(req in props)) {
        return `parameters.required references "${req}" but it is not in properties`;
      }
    }
  }

  return null;
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
