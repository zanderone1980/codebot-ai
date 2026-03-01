# Hardening Guide

Production hardening checklist for CodeBot AI deployments.

## Essential Hardening

### 1. Enable Docker Sandbox
```json
{
  "execution": {
    "sandbox": "docker",
    "network": false,
    "timeout_seconds": 60,
    "max_memory_mb": 256
  }
}
```

### 2. Restrict Tool Access
Disable tools you don't need:
```json
{
  "tools": {
    "disabled": ["browser", "ssh_remote", "docker", "database", "http_client"],
    "permissions": {
      "execute": "always-ask",
      "write_file": "prompt",
      "git": "prompt"
    }
  }
}
```

### 3. Lock Down Shell Commands
Only allow specific command prefixes:
```json
{
  "tools": {
    "capabilities": {
      "execute": {
        "shell_commands": ["npm test", "npm run build", "tsc", "git status", "git diff", "git log"]
      }
    }
  }
}
```

### 4. Restrict File Access
```json
{
  "filesystem": {
    "writable_paths": ["./src/**", "./tests/**"],
    "denied_paths": ["./.env", "./.env.*", "./secrets/", "./.git/config"],
    "allow_outside_project": false
  }
}
```

### 5. Enable Secret Blocking
```json
{
  "secrets": {
    "block_on_detect": true,
    "scan_on_write": true
  }
}
```

### 6. Set Cost Limits
```json
{
  "limits": {
    "cost_limit_usd": 10.00,
    "max_iterations": 25,
    "max_file_size_kb": 200
  }
}
```

### 7. Enforce Branch Workflow
```json
{
  "git": {
    "always_branch": true,
    "never_push_main": true,
    "branch_prefix": "codebot/"
  }
}
```

## Monitoring

### Audit Log Verification
```bash
# Verify all audit chains
codebot --verify-audit

# Verify specific session
codebot --verify-audit <session-id>

# Export as SARIF for CI integration
codebot --export-audit sarif > results.sarif
```

### Metrics
Use the `/metrics` interactive command or set `OTEL_EXPORTER_OTLP_ENDPOINT` for continuous monitoring.

### Risk Monitoring
Use the `/risk` interactive command to review risk assessment history.

## CI/CD Hardening

When running CodeBot in CI (GitHub Action), additional considerations:

1. **Store API keys in GitHub Secrets**, never in code
2. **Use `max-iterations: 15`** to prevent runaway costs
3. **Review action outputs** before merging auto-fix PRs
4. **Enable SARIF upload** for security scan results
5. **Pin the action version** (`@v2` not `@main`)
