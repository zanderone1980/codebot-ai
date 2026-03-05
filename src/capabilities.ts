/**
 * Capability-Based Tool Permissions for CodeBot v1.8.0
 *
 * Fine-grained, per-tool resource restrictions.
 * Configured via .codebot/policy.json → tools.capabilities.
 *
 * Example:
 * {
 *   "execute": {
 *     "shell_commands": ["npm", "node", "git", "tsc"],
 *     "max_output_kb": 500
 *   },
 *   "write_file": {
 *     "fs_write": ["./src/**", "./tests/**"]
 *   }
 * }
 */

import * as path from 'path';

// ── Capability Schema ──

export interface ToolCapabilities {
  fs_read?: string[];        // glob patterns of readable paths
  fs_write?: string[];       // glob patterns of writable paths
  net_access?: string[];     // allowed domains (empty array = no network)
  shell_commands?: string[]; // allowed command prefixes
  max_output_kb?: number;    // output size cap in KB
}

export type CapabilityConfig = Record<string, ToolCapabilities>;

// ── Capability Checker ──

export class CapabilityChecker {
  private capabilities: CapabilityConfig;
  private projectRoot: string;

  constructor(capabilities: CapabilityConfig, projectRoot: string) {
    this.capabilities = capabilities;
    this.projectRoot = projectRoot;
  }

  /** Get capabilities for a tool. undefined = no restrictions. */
  getToolCapabilities(toolName: string): ToolCapabilities | undefined {
    return this.capabilities[toolName];
  }

  /** Check if a specific capability is allowed. */
  checkCapability(
    toolName: string,
    capabilityType: keyof ToolCapabilities,
    value: string | number,
  ): { allowed: boolean; reason?: string } {
    const caps = this.capabilities[toolName];
    if (!caps) return { allowed: true }; // No caps defined = unrestricted

    switch (capabilityType) {
      case 'fs_read':
        return this.checkGlobs(caps.fs_read, value as string, 'fs_read', toolName);
      case 'fs_write':
        return this.checkGlobs(caps.fs_write, value as string, 'fs_write', toolName);
      case 'net_access':
        return this.checkDomain(caps.net_access, value as string, toolName);
      case 'shell_commands':
        return this.checkCommandPrefix(caps.shell_commands, value as string, toolName);
      case 'max_output_kb':
        return this.checkOutputSize(caps.max_output_kb, value as number, toolName);
      default:
        return { allowed: true };
    }
  }

  /** Check if a path matches any of the allowed glob patterns. */
  private checkGlobs(
    patterns: string[] | undefined,
    filePath: string,
    capName: string,
    toolName: string,
  ): { allowed: boolean; reason?: string } {
    if (!patterns || patterns.length === 0) return { allowed: true };

    const resolved = path.resolve(filePath);
    const relative = path.relative(this.projectRoot, resolved);

    // Don't restrict paths outside the project (those are handled by security.ts)
    if (relative.startsWith('..')) return { allowed: true };

    for (const pattern of patterns) {
      if (this.matchGlob(relative, pattern)) {
        return { allowed: true };
      }
    }

    return {
      allowed: false,
      reason: `Tool "${toolName}" ${capName} capability blocks "${relative}" (allowed: ${patterns.join(', ')})`,
    };
  }

  /** Check if a domain is in the allowed list. */
  private checkDomain(
    allowed: string[] | undefined,
    domain: string,
    toolName: string,
  ): { allowed: boolean; reason?: string } {
    if (allowed === undefined) return { allowed: true }; // undefined = unrestricted
    if (allowed.length === 0) {
      // Empty array = no network access allowed
      return {
        allowed: false,
        reason: `Tool "${toolName}" has no allowed network domains`,
      };
    }

    if (allowed.includes('*')) return { allowed: true };

    const normalizedDomain = domain.toLowerCase();
    for (const d of allowed) {
      const nd = d.toLowerCase();
      if (normalizedDomain === nd) return { allowed: true };
      if (normalizedDomain.endsWith('.' + nd)) return { allowed: true };
    }

    return {
      allowed: false,
      reason: `Tool "${toolName}" cannot access domain "${domain}" (allowed: ${allowed.join(', ')})`,
    };
  }

  /** Check if a command starts with an allowed prefix. */
  private checkCommandPrefix(
    allowed: string[] | undefined,
    command: string,
    toolName: string,
  ): { allowed: boolean; reason?: string } {
    if (!allowed || allowed.length === 0) return { allowed: true };

    const cmd = command.trim();
    for (const prefix of allowed) {
      if (cmd === prefix || cmd.startsWith(prefix + ' ')) {
        return { allowed: true };
      }
    }

    // Extract first word for the error message
    const firstWord = cmd.split(/\s+/)[0] || cmd.substring(0, 30);

    return {
      allowed: false,
      reason: `Tool "${toolName}" cannot run "${firstWord}" (allowed commands: ${allowed.join(', ')})`,
    };
  }

  /** Check if output size is within the cap. */
  private checkOutputSize(
    maxKb: number | undefined,
    actualKb: number,
    toolName: string,
  ): { allowed: boolean; reason?: string } {
    if (maxKb === undefined || maxKb <= 0) return { allowed: true };
    if (actualKb <= maxKb) return { allowed: true };
    return {
      allowed: false,
      reason: `Tool "${toolName}" output ${actualKb}KB exceeds cap of ${maxKb}KB`,
    };
  }

  /** Simple glob matching (** = any depth, * = one segment). */
  private matchGlob(relativePath: string, pattern: string): boolean {
    const cleanPattern = pattern.replace(/^\.\//, '');
    const cleanPath = relativePath.replace(/^\.\//, '');

    // Exact match
    if (cleanPath === cleanPattern) return true;

    // Prefix match (directory)
    if (cleanPath.startsWith(cleanPattern + '/')) return true;

    // Glob expansion
    if (pattern.includes('*')) {
      const regex = new RegExp(
        '^' +
        cleanPattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*/g, '<<GLOBSTAR>>')
          .replace(/\*/g, '[^/]*')
          .replace(/<<GLOBSTAR>>/g, '.*') +
        '$',
      );
      return regex.test(cleanPath);
    }

    return false;
  }
}
