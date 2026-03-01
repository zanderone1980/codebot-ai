# Threat Model (STRIDE-Based)

This document analyzes CodeBot AI's attack surfaces using the STRIDE framework.

## Trust Boundaries

```
┌──────────────────────────────────────────┐
│  Untrusted: LLM Responses               │
│  (prompt injection, hallucinated tools)  │
├──────────────────────────────────────────┤
│  Semi-trusted: User Input                │
│  (may be automated, may contain secrets) │
├──────────────────────────────────────────┤
│  Trusted: Agent Core                     │
│  (policy enforcement, security checks)   │
├──────────────────────────────────────────┤
│  Trusted: Local Filesystem               │
│  (within project scope)                  │
└──────────────────────────────────────────┘
```

## STRIDE Analysis

### Spoofing

| Threat | Risk | Mitigation |
|--------|------|------------|
| LLM impersonates a trusted tool | Medium | Tool registry validates tool names against known set |
| Forged session history | Medium | HMAC-SHA256 message signing (`src/integrity.ts`) |
| Fake audit log entries | Low | SHA-256 hash chain verification (`src/audit.ts`) |

### Tampering

| Threat | Risk | Mitigation |
|--------|------|------------|
| LLM modifies system files | High | Path safety checks block `/etc`, `/usr`, `~/.ssh` (`src/security.ts`) |
| LLM modifies files outside project | High | `allow_outside_project: false` default policy |
| Tampered audit log | Medium | Hash-chained entries, `--verify-audit` CLI command |
| Modified session history | Medium | HMAC signatures verified on load (`src/integrity.ts`) |

### Repudiation

| Threat | Risk | Mitigation |
|--------|------|------------|
| Agent denies performing actions | Low | Append-only audit log with hash chain |
| Missing audit entries | Low | Every tool execution logged (success, error, block) |
| Audit log deletion | Medium | Logs stored in `~/.codebot/audit/`, rotation at 10MB |

### Information Disclosure

| Threat | Risk | Mitigation |
|--------|------|------------|
| Secrets in tool output sent to LLM | High | Secret detection and masking (`src/secrets.ts`) |
| SSRF to internal services | High | Blocks localhost, private IPs, cloud metadata (`src/tools/web-fetch.ts`) |
| Path traversal reads sensitive files | High | Path safety validation (`src/security.ts`) |
| API keys in command output | Medium | Secret scanning on all tool output |

### Denial of Service

| Threat | Risk | Mitigation |
|--------|------|------------|
| Infinite agent loop | Medium | `max_iterations` limit (default: 50) |
| Cost runaway | Medium | `cost_limit_usd` hard stop |
| Resource exhaustion in sandbox | Low | CPU, memory, PID limits in Docker sandbox |
| Rate limit abuse | Low | Per-tool rate limiting (`src/rate-limiter.ts`) |

### Elevation of Privilege

| Threat | Risk | Mitigation |
|--------|------|------------|
| LLM prompt injection via tool output | High | Tool output treated as data, never as instructions |
| Shell command injection | High | Command blocklist, capability-based shell restrictions |
| Plugin executes privileged code | Medium | Plugins loaded from known directory, policy controls |
| MCP server abuse | Medium | `allowed_servers`/`blocked_servers` policy controls |

## Attack Surface Summary

1. **LLM responses** are the primary untrusted input. All tool calls from LLM responses pass through policy, capability, permission, and security checks.
2. **Shell execution** is the highest-risk tool. Mitigated by Docker sandbox, command blocklist, capability restrictions, and `always-ask` permission default.
3. **File operations** are scoped to the project directory by default, with sensitive path blocking.
4. **Network access** is disabled by default in sandbox mode, with SSRF protection for all HTTP tools.
