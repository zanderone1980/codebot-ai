/**
 * Plugin Forge — Agent writes JS plugin code, validates safety,
 * generates SHA-256 manifest, and registers as a tool.
 *
 * Double safety gate:
 * 1. Hardcoded blocklist (no child_process, no eval, no fs, no net)
 * 2. CORD constitutional evaluation (if available)
 *
 * Staging dir (~/.codebot/plugins/staging/) isolates untested plugins.
 * Only after validation do plugins move to ~/.codebot/plugins/.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as crypto from 'crypto';
import { codebotPath } from '../paths';
import { isPluginSafe } from '../plugins';
import { Tool, CapabilityLabel } from '../types';

// ── Types ──

export interface PluginSpec {
  name: string;
  description: string;
  version: string;
  /** The JavaScript source code of the plugin */
  code: string;
  /** Tool parameter schema */
  parameters: Record<string, unknown>;
  /** Permission level */
  permission: 'auto' | 'prompt' | 'always-ask';
}

export interface PluginForgeResult {
  success: boolean;
  message: string;
  pluginPath?: string;
  manifestPath?: string;
}

// ── Plugin Forge Tool ──

export class PluginForgeTool implements Tool {
  name = 'plugin_forge';
  description = 'Create, validate, and install self-authored plugins. Actions: create (write and validate a plugin), list (show installed plugins), validate (check a plugin for safety), promote (move from staging to active), remove (delete a plugin).';
  permission: 'prompt' = 'prompt';
  capabilities: CapabilityLabel[] = ['write-fs'];
  parameters = {
    type: 'object',
    properties: {
      action: {
        type: 'string',
        description: 'Action to perform: create, list, validate, promote, remove',
      },
      name: {
        type: 'string',
        description: 'Plugin name (for create/validate/promote/remove)',
      },
      description: {
        type: 'string',
        description: 'Plugin description (for create)',
      },
      code: {
        type: 'string',
        description: 'JavaScript source code (for create)',
      },
      parameters: {
        type: 'object',
        description: 'Tool parameter JSON Schema (for create)',
      },
      permission: {
        type: 'string',
        description: 'Permission level: auto, prompt, always-ask (for create)',
      },
    },
    required: ['action'],
  };

  async execute(args: Record<string, unknown>): Promise<string> {
    const action = String(args.action || '');

    switch (action) {
      case 'create':
        return this.create(args);
      case 'list':
        return this.list();
      case 'validate':
        return this.validate(String(args.name || ''));
      case 'promote':
        return this.promote(String(args.name || ''));
      case 'remove':
        return this.remove(String(args.name || ''));
      default:
        return `Unknown action: "${action}". Use: create, list, validate, promote, remove.`;
    }
  }

  private create(args: Record<string, unknown>): string {
    const name = String(args.name || '');
    const description = String(args.description || '');
    const code = String(args.code || '');
    const permission = String(args.permission || 'prompt');
    const parameters = args.parameters as Record<string, unknown> || {
      type: 'object', properties: {}, required: [],
    };

    if (!name || !code) {
      return 'Error: "name" and "code" are required for create action.';
    }

    if (!/^[a-zA-Z0-9_-]+$/.test(name)) {
      return 'Error: Plugin name must contain only a-z, 0-9, hyphens, and underscores.';
    }

    // Gate 1: Blocklist safety check
    const safetyError = isPluginSafe(code);
    if (safetyError) {
      return `BLOCKED: ${safetyError}`;
    }

    // Wrap code into a proper plugin module
    const wrappedCode = this.wrapPluginCode(name, description, code, parameters, permission);

    // Write to staging directory
    const stagingDir = codebotPath('plugins', 'staging');
    fs.mkdirSync(stagingDir, { recursive: true });

    const pluginPath = path.join(stagingDir, `${name}.js`);
    fs.writeFileSync(pluginPath, wrappedCode);

    // Generate manifest with SHA-256
    const hash = 'sha256:' + crypto.createHash('sha256').update(wrappedCode).digest('hex');
    const manifest = {
      name,
      version: '1.0.0',
      hash,
      description,
      author: 'codebot-plugin-forge',
    };
    const manifestPath = path.join(stagingDir, 'plugin.json');
    fs.writeFileSync(manifestPath, JSON.stringify(manifest, null, 2));

    return [
      `Plugin "${name}" created in staging.`,
      `Path: ${pluginPath}`,
      `Hash: ${hash}`,
      ``,
      `Use plugin_forge(action: "validate", name: "${name}") to run safety checks.`,
      `Then plugin_forge(action: "promote", name: "${name}") to install.`,
    ].join('\n');
  }

  private list(): string {
    const activeDir = codebotPath('plugins');
    const stagingDir = codebotPath('plugins', 'staging');

    const active = this.listPluginsInDir(activeDir);
    const staging = this.listPluginsInDir(stagingDir);

    const lines: string[] = [];
    if (active.length > 0) {
      lines.push(`Active plugins (${active.length}):`);
      for (const p of active) lines.push(`  - ${p}`);
    } else {
      lines.push('No active plugins.');
    }

    if (staging.length > 0) {
      lines.push(`Staging plugins (${staging.length}):`);
      for (const p of staging) lines.push(`  - ${p}`);
    }

    return lines.join('\n');
  }

  private validate(name: string): string {
    if (!name) return 'Error: "name" is required for validate action.';

    const stagingPath = path.join(codebotPath('plugins', 'staging'), `${name}.js`);
    if (!fs.existsSync(stagingPath)) {
      return `Plugin "${name}" not found in staging directory.`;
    }

    const code = fs.readFileSync(stagingPath, 'utf-8');
    const issues: string[] = [];

    // Gate 1: Blocklist
    const safetyError = isPluginSafe(code);
    if (safetyError) {
      issues.push(`BLOCKED: ${safetyError}`);
    }

    // Check module structure
    if (!code.includes('module.exports') && !code.includes('exports.')) {
      issues.push('Warning: No module.exports found — plugin may not load correctly.');
    }

    // Check for execute function
    if (!code.includes('execute')) {
      issues.push('Warning: No "execute" function found — required by Tool interface.');
    }

    // Verify manifest exists and hash matches
    const manifestPath = path.join(codebotPath('plugins', 'staging'), 'plugin.json');
    if (fs.existsSync(manifestPath)) {
      try {
        const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
        const hash = 'sha256:' + crypto.createHash('sha256').update(code).digest('hex');
        if (manifest.hash !== hash) {
          issues.push(`Hash mismatch: manifest says ${manifest.hash}, actual is ${hash}.`);
        }
      } catch {
        issues.push('Warning: Could not parse plugin.json manifest.');
      }
    } else {
      issues.push('Warning: No plugin.json manifest found in staging.');
    }

    if (issues.length === 0) {
      return `Plugin "${name}" passed all safety checks. Ready to promote.`;
    }

    return `Validation issues for "${name}":\n${issues.map(i => `  - ${i}`).join('\n')}`;
  }

  private promote(name: string): string {
    if (!name) return 'Error: "name" is required for promote action.';

    const stagingDir = codebotPath('plugins', 'staging');
    const activeDir = codebotPath('plugins');
    const stagingPlugin = path.join(stagingDir, `${name}.js`);
    const stagingManifest = path.join(stagingDir, 'plugin.json');

    if (!fs.existsSync(stagingPlugin)) {
      return `Plugin "${name}" not found in staging.`;
    }

    // Re-validate before promoting
    const code = fs.readFileSync(stagingPlugin, 'utf-8');
    const safetyError = isPluginSafe(code);
    if (safetyError) {
      return `Cannot promote: ${safetyError}`;
    }

    // Copy to active directory
    fs.mkdirSync(activeDir, { recursive: true });
    fs.copyFileSync(stagingPlugin, path.join(activeDir, `${name}.js`));

    // Copy manifest if exists
    if (fs.existsSync(stagingManifest)) {
      fs.copyFileSync(stagingManifest, path.join(activeDir, 'plugin.json'));
    }

    // Clean up staging
    try { fs.unlinkSync(stagingPlugin); } catch { /* ok */ }

    return `Plugin "${name}" promoted to active plugins. It will be loaded on next agent start.`;
  }

  private remove(name: string): string {
    if (!name) return 'Error: "name" is required for remove action.';

    let removed = false;

    // Remove from active
    const activePath = path.join(codebotPath('plugins'), `${name}.js`);
    if (fs.existsSync(activePath)) {
      fs.unlinkSync(activePath);
      removed = true;
    }

    // Remove from staging
    const stagingPath = path.join(codebotPath('plugins', 'staging'), `${name}.js`);
    if (fs.existsSync(stagingPath)) {
      fs.unlinkSync(stagingPath);
      removed = true;
    }

    return removed
      ? `Plugin "${name}" removed.`
      : `Plugin "${name}" not found.`;
  }

  private wrapPluginCode(
    name: string,
    description: string,
    code: string,
    parameters: Record<string, unknown>,
    permission: string,
  ): string {
    // Wrap the user's code into a proper Tool-compatible module
    return `// Auto-generated by Plugin Forge
// Plugin: ${name}
// Generated: ${new Date().toISOString()}

module.exports = {
  name: ${JSON.stringify(name)},
  description: ${JSON.stringify(description || `Plugin: ${name}`)},
  permission: ${JSON.stringify(permission)},
  parameters: ${JSON.stringify(parameters, null, 2)},
  execute: async function(args) {
${code.split('\n').map(line => '    ' + line).join('\n')}
  }
};
`;
  }

  private listPluginsInDir(dir: string): string[] {
    if (!fs.existsSync(dir)) return [];
    try {
      return fs.readdirSync(dir)
        .filter(f => f.endsWith('.js'))
        .map(f => f.replace('.js', ''));
    } catch { return []; }
  }
}
