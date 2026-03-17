/**
 * Policy presets — opinionated configurations for common use cases.
 * Use --preset <name> to apply, or --init-preset <name> to write to .codebot/policy.json.
 */

import { Policy } from './policy';

const SOLO: Partial<Policy> = {
  execution: { sandbox: 'host', network: true, timeout_seconds: 300, max_memory_mb: 512 },
  git: { always_branch: false, never_push_main: false, require_tests_before_commit: false },
  limits: { max_iterations: 100, cost_limit_usd: 10, max_file_size_kb: 500 },
  constitutional: { enabled: true, hard_block_enabled: false },
  tools: { enabled: [], disabled: [], permissions: { execute: 'prompt' } },
  secrets: { block_on_detect: true, scan_on_write: true },
};

const TEAM_SAFE: Partial<Policy> = {
  execution: { sandbox: 'auto', network: false, timeout_seconds: 120, max_memory_mb: 512 },
  git: { always_branch: true, never_push_main: true, require_tests_before_commit: true, branch_prefix: 'codebot/' },
  limits: { max_iterations: 50, cost_limit_usd: 5, max_file_size_kb: 500 },
  constitutional: { enabled: true, hard_block_enabled: true, vigil_enabled: true },
  filesystem: { denied_paths: ['.env', '.env.*', 'credentials*', '*.pem', '*.key'], allow_outside_project: false },
  secrets: { block_on_detect: true, scan_on_write: true },
  tools: { enabled: [], disabled: [] },
};

const REVIEW_ONLY: Partial<Policy> = {
  execution: { sandbox: 'host', network: true, timeout_seconds: 60, max_memory_mb: 256 },
  git: { always_branch: false, never_push_main: true },
  limits: { max_iterations: 20, cost_limit_usd: 2, max_file_size_kb: 500 },
  constitutional: { enabled: true, hard_block_enabled: true },
  tools: {
    enabled: ['read_file', 'glob', 'grep', 'think', 'memory', 'code_analysis', 'multi_search', 'diff_viewer', 'code_review', 'web_search', 'web_fetch'],
    disabled: ['write_file', 'edit_file', 'batch_edit', 'execute', 'git', 'docker', 'ssh_remote', 'browser', 'plugin_forge'],
  },
  secrets: { block_on_detect: true, scan_on_write: false },
};

const ENTERPRISE: Partial<Policy> = {
  execution: { sandbox: 'docker', network: false, timeout_seconds: 60, max_memory_mb: 256 },
  git: { always_branch: true, never_push_main: true, require_tests_before_commit: true, branch_prefix: 'agent/' },
  limits: { max_iterations: 30, cost_limit_usd: 3, max_file_size_kb: 200, max_files_per_operation: 10 },
  constitutional: { enabled: true, hard_block_enabled: true, vigil_enabled: true },
  filesystem: { denied_paths: ['.env', '.env.*', 'credentials*', '*.pem', '*.key', '*.p12', 'secrets/', '.aws/', '.ssh/'], allow_outside_project: false },
  tools: { disabled: ['browser', 'ssh_remote', 'docker', 'plugin_forge', 'skill_forge', 'graphics', 'notification'] },
  secrets: { block_on_detect: true, scan_on_write: true },
  rbac: { enabled: true },
};

const PRESETS: Record<string, Partial<Policy>> = {
  solo: SOLO,
  'team-safe': TEAM_SAFE,
  'review-only': REVIEW_ONLY,
  enterprise: ENTERPRISE,
};

/** Get a policy preset by name. Returns null if not found. */
export function getPreset(name: string): Partial<Policy> | null {
  return PRESETS[name] || null;
}

/** List available preset names. */
export function listPresets(): string[] {
  return Object.keys(PRESETS);
}

/** Get preset with description. */
export function describePresets(): Array<{ name: string; description: string }> {
  return [
    { name: 'solo', description: 'Fast, minimal friction for solo developers' },
    { name: 'team-safe', description: 'Safe defaults for team repos with branch protection' },
    { name: 'review-only', description: 'Read-only mode — no file modifications allowed' },
    { name: 'enterprise', description: 'Maximum lockdown with Docker sandbox and RBAC' },
  ];
}
