/**
 * Policy Engine for CodeBot v2.1.5
 *
 * Loads, validates, and enforces declarative security policies.
 * Policy files: .codebot/policy.json (project) + ~/.codebot/policy.json (global)
 * Project policy overrides global policy where specified.
 */

import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { ToolCapabilities, CapabilityChecker } from './capabilities';

// ── Policy Schema ──

export interface PolicyExecution {
  sandbox?: 'docker' | 'host' | 'auto';
  network?: boolean;
  timeout_seconds?: number;
  max_memory_mb?: number;
}

export interface PolicyFilesystem {
  writable_paths?: string[];
  read_only_paths?: string[];
  denied_paths?: string[];
  allow_outside_project?: boolean;
}

export interface PolicyToolPermission {
  [toolName: string]: 'auto' | 'prompt' | 'always-ask';
}

export interface PolicyTools {
  enabled?: string[];
  disabled?: string[];
  permissions?: PolicyToolPermission;
  capabilities?: Record<string, ToolCapabilities>;
}

export interface PolicySecrets {
  block_on_detect?: boolean;
  scan_on_write?: boolean;
  allowed_patterns?: string[];
}

export interface PolicyGit {
  always_branch?: boolean;
  branch_prefix?: string;
  require_tests_before_commit?: boolean;
  never_push_main?: boolean;
}

export interface PolicyMcp {
  allowed_servers?: string[];
  blocked_servers?: string[];
}

export interface PolicyLimits {
  max_iterations?: number;
  max_file_size_kb?: number;
  max_files_per_operation?: number;
  cost_limit_usd?: number;
}

export interface PolicyRole {
  tools?: PolicyTools;
  filesystem?: PolicyFilesystem;
  limits?: PolicyLimits;
}

export interface PolicyRbac {
  /** Map OS username or identifier to role name */
  user_roles?: Record<string, string>;
  /** Role definitions with scoped policies */
  roles?: Record<string, PolicyRole>;
  /** Default role for unrecognized users (falls back to base policy if not set) */
  default_role?: string;
  /** Enable RBAC enforcement (default: false for backward compatibility) */
  enabled?: boolean;
}

export interface PolicyConstitutional {
  enabled?: boolean;
  vigil_enabled?: boolean;
  hard_block_enabled?: boolean;
}

export interface Policy {
  version?: string;
  execution?: PolicyExecution;
  filesystem?: PolicyFilesystem;
  tools?: PolicyTools;
  secrets?: PolicySecrets;
  git?: PolicyGit;
  mcp?: PolicyMcp;
  limits?: PolicyLimits;
  rbac?: PolicyRbac;
  constitutional?: PolicyConstitutional;
}

// ── Default Policy ──

export const DEFAULT_POLICY: Required<Policy> = {
  version: '1.0',
  constitutional: {
    enabled: true,
    vigil_enabled: true,
    hard_block_enabled: true,
  },
  execution: {
    sandbox: 'auto',
    network: false,             // safe default: no network in sandbox
    timeout_seconds: 120,
    max_memory_mb: 512,
  },
  filesystem: {
    writable_paths: [],       // empty = all project paths allowed
    read_only_paths: [],
    denied_paths: ['.env', '.env.local', '.env.production'],
    allow_outside_project: false,
  },
  tools: {
    enabled: [],              // empty = all tools enabled
    disabled: [],
    permissions: {},
  },
  secrets: {
    block_on_detect: true,      // safe default: block writes containing secrets
    scan_on_write: true,
    allowed_patterns: [],
  },
  git: {
    always_branch: true,        // safe default: auto-branch on first write
    branch_prefix: 'codebot/',
    require_tests_before_commit: false,
    never_push_main: true,
  },
  mcp: {
    allowed_servers: [],      // empty = all allowed
    blocked_servers: [],
  },
  limits: {
    max_iterations: 50,
    max_file_size_kb: 500,
    max_files_per_operation: 20,
    cost_limit_usd: 0,       // 0 = no limit
  },
  rbac: {
    enabled: false,
    user_roles: {},
    roles: {},
    default_role: undefined,
  },
};

// ── Policy Loader ──

/**
 * Load and merge policies from project + global locations.
 * Project policy overrides global where specified.
 */
export function loadPolicy(projectRoot?: string): Policy {
  const root = projectRoot || process.cwd();

  // Load global policy
  const globalPath = path.join(os.homedir(), '.codebot', 'policy.json');
  const globalPolicy = loadPolicyFile(globalPath);

  // Load project policy
  const projectPath = path.join(root, '.codebot', 'policy.json');
  const projectPolicy = loadPolicyFile(projectPath);

  // Merge: defaults ← global ← project (project wins)
  return mergePolicies(DEFAULT_POLICY, globalPolicy, projectPolicy);
}

function loadPolicyFile(filePath: string): Policy | null {
  try {
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath, 'utf-8');
    const parsed = JSON.parse(content);
    if (!validatePolicy(parsed)) return null;
    return parsed as Policy;
  } catch {
    return null;
  }
}

/** Known top-level policy fields for typo detection */
const KNOWN_POLICY_FIELDS = new Set([
  'version', 'execution', 'filesystem', 'tools', 'secrets', 'git', 'mcp', 'limits', 'rbac',
]);

/**
 * Basic validation — ensures the policy file has a recognizable shape.
 * Does NOT throw — returns false for invalid policies (fail-open with defaults).
 * Warns about unknown fields to catch typos.
 */
function validatePolicy(obj: unknown): boolean {
  if (!obj || typeof obj !== 'object') return false;
  const p = obj as Record<string, unknown>;

  // Version check
  if (p.version !== undefined && typeof p.version !== 'string') return false;

  // Type check each section
  if (p.execution !== undefined && typeof p.execution !== 'object') return false;
  if (p.filesystem !== undefined && typeof p.filesystem !== 'object') return false;
  if (p.tools !== undefined && typeof p.tools !== 'object') return false;
  if (p.secrets !== undefined && typeof p.secrets !== 'object') return false;
  if (p.git !== undefined && typeof p.git !== 'object') return false;
  if (p.mcp !== undefined && typeof p.mcp !== 'object') return false;
  if (p.limits !== undefined && typeof p.limits !== 'object') return false;
  if (p.rbac !== undefined && typeof p.rbac !== 'object') return false;

  // Warn about unknown top-level fields (catches typos like "filesytem")
  for (const key of Object.keys(p)) {
    if (!KNOWN_POLICY_FIELDS.has(key)) {
      console.warn(`Policy warning: unknown field "${key}" — did you mean one of: ${[...KNOWN_POLICY_FIELDS].join(', ')}?`);
    }
  }

  // Validate writable_paths don't escape the project
  const fs_policy = p.filesystem as Record<string, unknown> | undefined;
  if (fs_policy?.writable_paths && Array.isArray(fs_policy.writable_paths)) {
    for (const wp of fs_policy.writable_paths as string[]) {
      if (wp.startsWith('/') || wp.startsWith('~') || wp.includes('..')) {
        console.warn(`Policy warning: writable_path "${wp}" uses absolute/home/parent path — this may be unsafe.`);
      }
    }
  }

  return true;
}

/**
 * Deep merge policies. Later arguments override earlier ones.
 * Only defined keys in higher-priority policies override lower ones.
 */
function mergePolicies(...policies: (Policy | null)[]): Policy {
  const result: Record<string, unknown> = {};

  for (const policy of policies) {
    if (!policy) continue;
    for (const [key, value] of Object.entries(policy)) {
      if (value === undefined || value === null) continue;
      if (typeof value === 'object' && !Array.isArray(value)) {
        // Deep merge objects
        result[key] = { ...(result[key] as Record<string, unknown> || {}), ...value };
      } else {
        result[key] = value;
      }
    }
  }

  return result as Policy;
}

// ── Policy Enforcer ──

export class PolicyEnforcer {
  private policy: Policy;
  private projectRoot: string;

  constructor(policy?: Policy, projectRoot?: string) {
    this.policy = policy || loadPolicy(projectRoot);
    this.projectRoot = projectRoot || process.cwd();
  }


  /** Resolve the current user's role and return merged policy */
  private currentUser: string | null = null;

  /** Set the current user for RBAC resolution */
  setUser(username: string): void {
    this.currentUser = username;
  }

  /** Get the current OS username */
  getCurrentUser(): string {
    return this.currentUser || os.userInfo().username || 'unknown';
  }

  /** Resolve the role for the current user */
  resolveRole(): string | null {
    const rbac = this.policy.rbac;
    if (!rbac?.enabled) return null;

    const user = this.getCurrentUser();
    const roleName = rbac.user_roles?.[user] || rbac.default_role || null;
    return roleName;
  }

  /** Get the effective policy for the current user (base policy merged with role overrides) */
  getEffectivePolicy(): Policy {
    const rbac = this.policy.rbac;
    if (!rbac?.enabled) return this.policy;

    const roleName = this.resolveRole();
    if (!roleName || !rbac.roles?.[roleName]) return this.policy;

    const role = rbac.roles[roleName];

    // Merge role overrides on top of base policy
    const effective = { ...this.policy };
    if (role.tools) {
      effective.tools = {
        ...effective.tools,
        ...role.tools,
        permissions: { ...effective.tools?.permissions, ...role.tools.permissions },
        capabilities: { ...effective.tools?.capabilities, ...role.tools.capabilities },
      };
    }
    if (role.filesystem) {
      effective.filesystem = { ...effective.filesystem, ...role.filesystem };
    }
    if (role.limits) {
      effective.limits = { ...effective.limits, ...role.limits };
    }

    return effective;
  }
  getPolicy(): Policy {
    return this.policy;
  }

  // ── Tool Access ──

  /** Check if a tool is enabled by policy. Returns { allowed, reason }. */
  isToolAllowed(toolName: string): { allowed: boolean; reason?: string } {
    const effective = this.getEffectivePolicy();
    const tools = effective.tools;
    if (!tools) return { allowed: true };

    // If explicit disabled list contains it, block
    if (tools.disabled && tools.disabled.length > 0) {
      if (tools.disabled.includes(toolName)) {
        return { allowed: false, reason: `Tool "${toolName}" is disabled by policy` };
      }
    }

    // If explicit enabled list exists and is non-empty, only those tools are allowed
    if (tools.enabled && tools.enabled.length > 0) {
      if (!tools.enabled.includes(toolName)) {
        return { allowed: false, reason: `Tool "${toolName}" is not in the enabled tools list` };
      }
    }

    return { allowed: true };
  }

  /** Get the permission level for a tool (policy override or null for default). */
  getToolPermission(toolName: string): 'auto' | 'prompt' | 'always-ask' | null {
    return this.getEffectivePolicy().tools?.permissions?.[toolName] || null;
  }

  // ── Filesystem Access ──

  /** Check if a path is writable according to policy. */
  isPathWritable(filePath: string): { allowed: boolean; reason?: string } {
    const fs_policy = this.getEffectivePolicy().filesystem;
    if (!fs_policy) return { allowed: true };

    const resolved = path.resolve(filePath);
    const relative = path.relative(this.projectRoot, resolved);

    // Check denied paths first (highest priority)
    if (fs_policy.denied_paths && fs_policy.denied_paths.length > 0) {
      for (const denied of fs_policy.denied_paths) {
        const deniedResolved = path.resolve(this.projectRoot, denied);
        if (resolved === deniedResolved || resolved.startsWith(deniedResolved + path.sep)) {
          return { allowed: false, reason: `Path "${relative}" is denied by policy` };
        }
        // Also check as a glob-like prefix
        if (this.matchesPattern(relative, denied)) {
          return { allowed: false, reason: `Path "${relative}" matches denied pattern "${denied}"` };
        }
      }
    }

    // Check read-only paths
    if (fs_policy.read_only_paths && fs_policy.read_only_paths.length > 0) {
      for (const ro of fs_policy.read_only_paths) {
        const roResolved = path.resolve(this.projectRoot, ro);
        if (resolved === roResolved || resolved.startsWith(roResolved + path.sep)) {
          return { allowed: false, reason: `Path "${relative}" is read-only by policy` };
        }
      }
    }

    // Check writable paths (if specified, only these are writable)
    if (fs_policy.writable_paths && fs_policy.writable_paths.length > 0) {
      let matched = false;
      for (const wp of fs_policy.writable_paths) {
        const wpResolved = path.resolve(this.projectRoot, wp);
        if (resolved === wpResolved || resolved.startsWith(wpResolved + path.sep)) {
          matched = true;
          break;
        }
        if (this.matchesPattern(relative, wp)) {
          matched = true;
          break;
        }
      }
      if (!matched) {
        return { allowed: false, reason: `Path "${relative}" is not in the writable paths list` };
      }
    }

    return { allowed: true };
  }

  // ── Execution Policy ──

  /** Get sandbox mode. */
  getSandboxMode(): 'docker' | 'host' | 'auto' {
    return this.getEffectivePolicy().execution?.sandbox || 'auto';
  }

  /** Check if network is allowed for executed commands. */
  isNetworkAllowed(): boolean {
    return this.getEffectivePolicy().execution?.network !== false;
  }

  /** Get execution timeout in milliseconds. */
  getTimeoutMs(): number {
    const seconds = this.getEffectivePolicy().execution?.timeout_seconds || 120;
    return seconds * 1000;
  }

  /** Get max memory in MB for sandbox. */
  getMaxMemoryMb(): number {
    return this.getEffectivePolicy().execution?.max_memory_mb || 512;
  }

  // ── Git Policy ──

  /** Check if agent should always work on a branch. */
  shouldAlwaysBranch(): boolean {
    return this.getEffectivePolicy().git?.always_branch === true;
  }

  /** Get branch prefix for auto-created branches. */
  getBranchPrefix(): string {
    return this.getEffectivePolicy().git?.branch_prefix || 'codebot/';
  }

  /** Check if pushing to main/master is blocked. */
  isMainPushBlocked(): boolean {
    return this.getEffectivePolicy().git?.never_push_main !== false; // default true
  }

  // ── Secrets Policy ──

  /** Should secrets block writes (vs just warn)? */
  shouldBlockSecrets(): boolean {
    return this.getEffectivePolicy().secrets?.block_on_detect === true;
  }

  /** Should scan for secrets on write? */
  shouldScanSecrets(): boolean {
    return this.getEffectivePolicy().secrets?.scan_on_write !== false; // default true
  }

  // ── MCP Policy ──

  /** Check if an MCP server is allowed. */
  isMcpServerAllowed(serverName: string): { allowed: boolean; reason?: string } {
    const mcp = this.getEffectivePolicy().mcp;
    if (!mcp) return { allowed: true };

    // Blocked list takes priority
    if (mcp.blocked_servers && mcp.blocked_servers.length > 0) {
      if (mcp.blocked_servers.includes(serverName)) {
        return { allowed: false, reason: `MCP server "${serverName}" is blocked by policy` };
      }
    }

    // If allowed list is non-empty, only those servers are allowed
    if (mcp.allowed_servers && mcp.allowed_servers.length > 0) {
      if (!mcp.allowed_servers.includes(serverName)) {
        return { allowed: false, reason: `MCP server "${serverName}" is not in the allowed list` };
      }
    }

    return { allowed: true };
  }

  // ── Limits ──

  /** Get max iterations for the agent loop. */
  getMaxIterations(): number {
    return this.getEffectivePolicy().limits?.max_iterations || 50;
  }

  /** Get max file size in bytes for write operations. */
  getMaxFileSizeBytes(): number {
    return (this.getEffectivePolicy().limits?.max_file_size_kb || 500) * 1024;
  }

  /** Get cost limit in USD (0 = no limit). */
  getCostLimitUsd(): number {
    return this.getEffectivePolicy().limits?.cost_limit_usd || 0;
  }

  // ── Capabilities (v1.8.0) ──

  /** Get capability restrictions for a tool. undefined = unrestricted. */
  getToolCapabilities(toolName: string): ToolCapabilities | undefined {
    return this.getEffectivePolicy().tools?.capabilities?.[toolName];
  }

  /** Check a specific capability for a tool. Returns { allowed, reason }. */
  checkCapability(
    toolName: string,
    capabilityType: keyof ToolCapabilities,
    value: string | number,
  ): { allowed: boolean; reason?: string } {
    const caps = this.getEffectivePolicy().tools?.capabilities;
    if (!caps) return { allowed: true };
    const checker = new CapabilityChecker(caps, this.projectRoot);
    return checker.checkCapability(toolName, capabilityType, value);
  }

  // ── Helpers ──

  /**
   * Simple glob-like pattern matching:
   * - `*` matches any single path component
   * - `**` matches any number of path components
   * - `.env` matches exact filename
   */
  private matchesPattern(relativePath: string, pattern: string): boolean {
    // Exact match
    if (relativePath === pattern) return true;

    // Simple prefix match (handles ./src, ./tests)
    const cleanPattern = pattern.replace(/^\.\//, '');
    const cleanPath = relativePath.replace(/^\.\//, '');

    if (cleanPath === cleanPattern) return true;
    if (cleanPath.startsWith(cleanPattern + '/')) return true;
    if (cleanPath.startsWith(cleanPattern + path.sep)) return true;

    // Basename match (handles .env, .env.local)
    if (!pattern.includes('/') && !pattern.includes(path.sep)) {
      if (path.basename(relativePath) === pattern) return true;
    }

    // Glob-like: ** matches any depth
    if (pattern.includes('**')) {
      const regex = new RegExp(
        '^' +
        pattern
          .replace(/[.+^${}()|[\]\\]/g, '\\$&')
          .replace(/\*\*/g, '.*')
          .replace(/\*/g, '[^/]*') +
        '$'
      );
      return regex.test(cleanPath);
    }

    return false;
  }
}

/**
 * Generate a default policy file content for `codebot --init-policy`.
 */
export function generateDefaultPolicyFile(): string {
  return JSON.stringify({
    version: '1.0',
  constitutional: {
    enabled: true,
    vigil_enabled: true,
    hard_block_enabled: true,
  },
    execution: {
      sandbox: 'auto',
      network: false,
      timeout_seconds: 120,
      max_memory_mb: 512,
    },
    filesystem: {
      writable_paths: [],
      read_only_paths: [],
      denied_paths: ['.env', '.env.local', '.env.production'],
      allow_outside_project: false,
    },
    tools: {
      enabled: [],
      disabled: [],
      permissions: {
        execute: 'always-ask',
        write_file: 'prompt',
        edit_file: 'prompt',
      },
      capabilities: {
        execute: {
          shell_commands: [
            'npm', 'npx', 'node', 'git', 'tsc', 'eslint', 'prettier',
            'jest', 'vitest', 'pytest', 'make', 'cargo', 'go', 'python',
            'python3', 'ruby', 'php', 'java', 'javac', 'mvn', 'gradle',
            'docker', 'ls', 'cat', 'head', 'tail', 'wc', 'sort', 'uniq',
            'find', 'which', 'echo', 'pwd', 'env', 'date',
          ],
          max_output_kb: 500,
        },
      },
    },
    secrets: {
      block_on_detect: true,
      scan_on_write: true,
    },
    git: {
      always_branch: true,
      branch_prefix: 'codebot/',
      require_tests_before_commit: false,
      never_push_main: true,
    },
    mcp: {
      allowed_servers: [],
      blocked_servers: [],
    },
    limits: {
      max_iterations: 50,
      max_file_size_kb: 500,
      max_files_per_operation: 20,
      cost_limit_usd: 0,
    },
    rbac: {
      enabled: false,
      default_role: 'developer',
      user_roles: {},
      roles: {
        admin: {
          tools: { disabled: [] },
          limits: { max_iterations: 100, cost_limit_usd: 50.0 },
        },
        developer: {
          tools: {
            disabled: ['ssh_remote'],
            permissions: { execute: 'prompt', write_file: 'prompt' },
          },
          limits: { max_iterations: 50, cost_limit_usd: 10.0 },
        },
        reviewer: {
          tools: {
            disabled: ['execute', 'write_file', 'edit_file', 'batch_edit', 'ssh_remote', 'docker', 'database'],
            permissions: {},
          },
          filesystem: { writable_paths: [] },
          limits: { max_iterations: 10, cost_limit_usd: 2.0 },
        },
      },
    },
  }, null, 2) + '\n';
}
