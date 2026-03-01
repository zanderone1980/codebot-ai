# Policy Configuration Guide

CodeBot uses declarative JSON policies to control security, tool access, and execution limits. Policy files are loaded from `.codebot/policy.json` (project-level) and `~/.codebot/policy.json` (global). Project policies override global policies.

## Quick Start

Generate a default policy file:
```bash
codebot --init-policy
```

This creates `.codebot/policy.json` with safe defaults.

## Full Reference

### `version`
- **Type**: `string`
- **Default**: `"1.0"`
- **Description**: Policy schema version.

### `execution`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `sandbox` | `"docker" \| "host" \| "auto"` | `"auto"` | Execution mode. `auto` uses Docker when available. |
| `network` | `boolean` | `false` | Allow network access in sandboxed commands. |
| `timeout_seconds` | `number` | `120` | Max execution time per command. |
| `max_memory_mb` | `number` | `512` | Memory limit for sandboxed commands. |

### `filesystem`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `writable_paths` | `string[]` | `[]` | Glob patterns of writable paths (empty = all project files). |
| `read_only_paths` | `string[]` | `[]` | Paths that can be read but not written. |
| `denied_paths` | `string[]` | `[]` | Paths blocked from all access. |
| `allow_outside_project` | `boolean` | `false` | Allow file operations outside project root. |

### `tools`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `enabled` | `string[]` | all | Whitelist of allowed tools (if set, only these are available). |
| `disabled` | `string[]` | `[]` | Blacklist of blocked tools. |
| `permissions` | `object` | `{}` | Per-tool permission overrides: `"auto"`, `"prompt"`, or `"always-ask"`. |
| `capabilities` | `object` | `{}` | Fine-grained per-tool capabilities (see below). |

#### Capabilities

```json
{
  "tools": {
    "capabilities": {
      "execute": {
        "shell_commands": ["npm", "node", "git", "tsc"],
        "net_access": [],
        "max_output_kb": 100
      },
      "write_file": {
        "fs_write": ["./src/**", "./tests/**"]
      }
    }
  }
}
```

| Capability | Type | Description |
|------------|------|-------------|
| `shell_commands` | `string[]` | Allowed command prefixes for the execute tool. |
| `fs_write` | `string[]` | Glob patterns of writable paths for write/edit tools. |
| `fs_read` | `string[]` | Glob patterns of readable paths. |
| `net_access` | `string[]` | Allowed domains. `["*"]` for unrestricted. |
| `max_output_kb` | `number` | Maximum output size in kilobytes. |

### `secrets`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `block_on_detect` | `boolean` | `true` | Block writes containing detected secrets. |
| `scan_on_write` | `boolean` | `true` | Scan file content for secrets before writing. |
| `allowed_patterns` | `string[]` | `[]` | Glob patterns for allowed secret-like values (e.g., test keys). |

### `git`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `always_branch` | `boolean` | `true` | Auto-create feature branches before writes. |
| `branch_prefix` | `string` | `"codebot/"` | Prefix for auto-created branch names. |
| `require_tests_before_commit` | `boolean` | `false` | Run tests before allowing commits. |
| `never_push_main` | `boolean` | `true` | Block push to main/master branches. |

### `mcp`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `allowed_servers` | `string[]` | `["*"]` | MCP servers allowed to connect. |
| `blocked_servers` | `string[]` | `[]` | MCP servers blocked from connecting. |

### `limits`

| Field | Type | Default | Description |
|-------|------|---------|-------------|
| `max_iterations` | `number` | `50` | Maximum agent loop iterations per message. |
| `max_file_size_kb` | `number` | `500` | Maximum file size for write operations. |
| `max_files_per_operation` | `number` | `20` | Maximum files in a batch edit. |
| `cost_limit_usd` | `number` | `0` | Hard stop when cost exceeds this limit. `0` = no limit. |

## Example: Restrictive Production Policy

```json
{
  "version": "1.0",
  "execution": {
    "sandbox": "docker",
    "network": false,
    "timeout_seconds": 60
  },
  "filesystem": {
    "writable_paths": ["./src/**", "./tests/**"],
    "denied_paths": ["./.env", "./secrets/", "./.git/config"]
  },
  "tools": {
    "disabled": ["browser", "ssh_remote", "docker", "database"],
    "permissions": {
      "execute": "always-ask",
      "write_file": "prompt"
    },
    "capabilities": {
      "execute": {
        "shell_commands": ["npm test", "npm run", "tsc", "git status", "git diff"]
      }
    }
  },
  "secrets": {
    "block_on_detect": true,
    "scan_on_write": true
  },
  "git": {
    "always_branch": true,
    "never_push_main": true
  },
  "limits": {
    "max_iterations": 25,
    "cost_limit_usd": 5.00
  }
}
```
