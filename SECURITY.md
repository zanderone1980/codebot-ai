# Security Policy

## Overview

CodeBot AI is designed with security as a core architectural principle, not an afterthought. Every tool call passes through multiple enforcement layers before execution.

## Security Architecture

```
User Input
    |
    v
+-- Agent Loop --------------------------------+
|   LLM Response -> Tool Calls                 |
|       |                                      |
|   [1] Policy Enforcer (tool enable/disable)  |
|       |                                      |
|   [2] Capability Checker (fine-grained ACLs) |
|       |                                      |
|   [3] Permission Gate (user approval)        |
|       |                                      |
|   [4] Risk Scorer (0-100 assessment)         |
|       |                                      |
|   [5] Security Checks (path, SSRF, secrets)  |
|       |                                      |
|   [6] Rate Limiter                           |
|       |                                      |
|   [7] Execution (sandboxed or host)          |
|       |                                      |
|   [8] Audit Logger (hash-chained)            |
+----------------------------------------------+
```

## Enforcement Layers

### 1. Policy Engine (`src/policy.ts`)
Declarative JSON policies at `.codebot/policy.json` control tool access, filesystem scope, execution limits, git workflow, secret handling, and MCP server restrictions. Project policies override global policies.

### 2. Capability-Based Permissions (`src/capabilities.ts`)
Fine-grained resource restrictions per tool: allowed shell commands, writable file paths, permitted network domains, output size caps.

### 3. Permission Gate
Three levels: `auto` (no prompt), `prompt` (ask in interactive mode), `always-ask` (always require approval). Configurable per-tool via policy.

### 4. Risk Scoring (`src/risk.ts`)
Every tool call receives a 0-100 risk score based on six weighted factors: permission level, file path sensitivity, command destructiveness, network access, data volume, and cumulative session risk.

### 5. Path Safety (`src/security.ts`)
Blocks writes to system directories (`/etc`, `/usr/bin`, `~/.ssh`), detects path traversal attacks (`../../`), enforces project-scoped file access.

### 6. Secret Detection (`src/secrets.ts`)
Scans content for AWS keys, GitHub tokens, JWTs, private keys, connection strings, and other credential patterns. Blocks or masks secrets based on policy.

### 7. SSRF Protection (`src/tools/web-fetch.ts`)
Blocks requests to localhost, private IPs (10.x, 172.16.x, 192.168.x), link-local addresses, cloud metadata endpoints (169.254.169.254), and non-HTTP protocols.

### 8. Audit Trail (`src/audit.ts`)
Append-only JSONL log with SHA-256 hash chains for tamper detection. Every tool execution, denial, error, and security block is recorded.

## Sandbox Execution

When Docker is available, shell commands run in disposable containers with:
- No network access (default)
- Read-only filesystem with project directory mounted
- CPU and memory limits
- PID limits
- No privilege escalation

Fallback: host execution with command blocklist when Docker is unavailable.

## Supported Export Formats

- **SARIF 2.1.0** — For GitHub Code Scanning, Azure DevOps, SonarQube integration
- **JSONL** — Raw audit entries for custom analysis
- **OpenTelemetry** — Optional metrics export via OTLP

## Reporting Vulnerabilities

If you discover a security vulnerability, please report it responsibly:

1. **Do NOT** open a public GitHub issue
2. Email: alex@zanderpinkdesign.com
3. Include: description, reproduction steps, impact assessment
4. We will respond within 48 hours
5. We will coordinate disclosure after a fix is available

## Compliance

For SOC 2 Trust Services Criteria mapping, readiness checklists, sample policies, and auditor evidence guides, see [docs/SOC2_COMPLIANCE.md](docs/SOC2_COMPLIANCE.md).

## Scope

This security policy covers the `codebot-ai` npm package, the VS Code extension (`codebot-ai-vscode`), and the GitHub Action (`@codebot-ai/action`).
