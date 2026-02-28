# CodeBot AI — 90-Day Production Roadmap

**Start:** v1.6.0 (security hardening shipped)
**End:** v2.0.0 (production-grade, enterprise-ready)
**Philosophy:** Ship something hardened at every checkpoint. No big bangs.

---

## Current State (v1.6.0)

| Metric | Value |
|--------|-------|
| Production LOC | 9,011 |
| Test LOC | 2,753 |
| Tests | 217 passing |
| Tools | 29 built-in + MCP + plugins |
| Security | Path safety, secret detection, audit logging, SSRF, MCP/plugin lockdown |

**What we have:** Pattern-based security (regex blocklists, path checks, sanitization).
**What we need:** Architecture-based security (isolation boundaries, policy enforcement, zero-trust tools).

---

## Phase 1: Contained (v1.7.0) — Weeks 1-3

**Theme:** _"Nothing escapes the sandbox."_

### 1.1 Docker Sandbox Execution

**Goal:** All `execute` tool calls run inside a disposable container by default.

**New files:**
- `src/sandbox/index.ts` — Sandbox manager (detect Docker, lifecycle)
- `src/sandbox/docker.ts` — Docker container execution engine
- `src/sandbox/config.ts` — Sandbox policy (mounts, network, limits)
- `src/sandbox/sandbox.test.ts` — Integration tests

**Implementation:**

```
Sandbox Architecture:
┌─────────────────────────────────────────┐
│  CodeBot Agent (host process)           │
│  ├── read_file, glob, grep (host, r/o) │
│  ├── write_file, edit_file (host, scoped) │
│  └── execute ──┐                        │
│                │                        │
│     ┌──────────▼──────────────┐         │
│     │  Docker Container       │         │
│     │  - Project dir mounted  │         │
│     │  - Read-only /usr /etc  │         │
│     │  - No network (default) │         │
│     │  - CPU: 2 cores max     │         │
│     │  - Memory: 512MB max    │         │
│     │  - Time: 120s max       │         │
│     │  - No privileged mode   │         │
│     └─────────────────────────┘         │
└─────────────────────────────────────────┘
```

**Docker command template:**
```bash
docker run --rm \
  --network none \
  --read-only \
  --tmpfs /tmp:size=100m \
  --cpus="2" \
  --memory="512m" \
  --pids-limit 100 \
  --security-opt no-new-privileges \
  -v "${PROJECT_DIR}:/workspace:rw" \
  -w /workspace \
  codebot-sandbox:latest \
  sh -c "${COMMAND}"
```

**Graceful degradation:**
- If Docker unavailable: fall back to host execution WITH existing blocklist
- Log warning: "Running in unsandboxed mode — install Docker for full isolation"
- CLI flag: `--sandbox=docker|host|auto` (default: auto)

**Files to modify:**
- `src/tools/execute.ts` — Route through sandbox when available
- `src/cli.ts` — Add `--sandbox` flag
- `src/types.ts` — Add `sandbox` config option

### 1.2 Policy Engine

**Goal:** Declarative security policies in a single config file.

**New files:**
- `src/policy.ts` — Policy loader, validator, enforcer
- `src/policy.test.ts` — Policy enforcement tests

**Policy file:** `.codebot/policy.json`

```json
{
  "version": "1.0",
  "execution": {
    "sandbox": "docker",
    "network": false,
    "timeout_seconds": 120,
    "max_memory_mb": 512
  },
  "filesystem": {
    "writable_paths": ["./src", "./tests", "./docs"],
    "read_only_paths": ["./config", "./.env.example"],
    "denied_paths": ["./.env", "./secrets/", "./.git/config"],
    "allow_outside_project": false
  },
  "tools": {
    "enabled": ["read_file", "write_file", "edit_file", "glob", "grep", "execute", "git", "test_runner"],
    "disabled": ["browser", "ssh_remote", "docker", "database"],
    "permissions": {
      "execute": "always-ask",
      "write_file": "prompt",
      "git": "prompt"
    }
  },
  "secrets": {
    "block_on_detect": false,
    "scan_on_write": true,
    "allowed_patterns": ["sk_test_*"]
  },
  "git": {
    "always_branch": true,
    "branch_prefix": "codebot/",
    "require_tests_before_commit": false,
    "never_push_main": true
  },
  "mcp": {
    "allowed_servers": ["filesystem", "github"],
    "blocked_servers": []
  },
  "limits": {
    "max_iterations": 25,
    "max_file_size_kb": 500,
    "max_files_per_operation": 20,
    "cost_limit_usd": 5.00
  }
}
```

**Integration points:**
- `src/agent.ts` — Load policy at startup, enforce tool enable/disable
- `src/tools/write.ts` — Check `filesystem.writable_paths`
- `src/tools/edit.ts` — Check `filesystem.writable_paths`
- `src/tools/execute.ts` — Check `execution.*` settings
- `src/tools/git.ts` — Check `git.*` settings
- `src/mcp.ts` — Check `mcp.allowed_servers`

**Merge order:** project `.codebot/policy.json` > global `~/.codebot/policy.json` > defaults

### 1.3 Hash-Chained Audit Log

**Goal:** Tamper-evident audit trail.

**Modify:** `src/audit.ts`

```
Current:  { timestamp, sessionId, tool, action, args, result, reason }
Enhanced: { ...current, sequence: number, prevHash: string, hash: string }
```

**Implementation:**
- Each entry includes SHA-256 hash of (prevHash + entry content)
- First entry of each session: `prevHash = "genesis"`
- `verify()` method walks the chain, checks every hash
- CLI command: `codebot --verify-audit [session-id]`

**New files:**
- Update `src/audit.ts` — Add hash chain
- Update `src/audit.test.ts` — Chain verification tests

### 1.4 Deterministic / Replay Mode

**Goal:** Rerun a session with identical tool calls for debugging.

**New files:**
- `src/replay.ts` — Session replay engine
- `src/replay.test.ts` — Replay tests

**Implementation:**
- `codebot --replay <session-id>` reads saved session, replays tool calls
- `--deterministic` flag sets temperature=0, fixed seed (if provider supports)
- Replay mode skips LLM calls, feeds recorded responses
- Compares actual tool output vs recorded output, flags divergences

**Files to modify:**
- `src/cli.ts` — Add `--replay` and `--deterministic` flags
- `src/agent.ts` — Accept replay feed mode

### Phase 1 Gate Criteria

- [ ] `execute` tool runs in Docker container by default (when Docker available)
- [ ] `.codebot/policy.json` controls tool access, filesystem scope, execution limits
- [ ] Audit log entries are hash-chained, `--verify-audit` validates chain
- [ ] `--replay` mode reproduces a session's tool calls
- [ ] 250+ tests passing
- [ ] `codebot --sandbox=docker echo hello` works end-to-end
- [ ] Zero host commands execute outside container in sandbox mode

---

## Phase 2: Trustworthy (v1.8.0) — Weeks 4-6

**Theme:** _"Trust nothing. Verify everything."_

### 2.1 Capability-Based Tool Permissions

**Goal:** Replace binary allow/deny with fine-grained capabilities.

**New files:**
- `src/capabilities.ts` — Capability definitions and checker
- `src/capabilities.test.ts` — Permission matrix tests

**Capability model:**
```typescript
interface ToolCapability {
  tool: string;
  capabilities: {
    fs_read?: string[];      // glob patterns of readable paths
    fs_write?: string[];     // glob patterns of writable paths
    net_access?: string[];   // allowed domains/IPs
    shell_commands?: string[]; // allowed command prefixes
    max_output_kb?: number;  // output size cap
    rate_limit?: number;     // calls per minute
  };
}
```

**Example:** The `execute` tool might have:
```json
{
  "tool": "execute",
  "capabilities": {
    "shell_commands": ["npm", "node", "git", "tsc", "eslint", "pytest"],
    "fs_write": ["./src/**", "./tests/**"],
    "net_access": [],
    "rate_limit": 30
  }
}
```

**Integration:**
- Policy engine feeds capabilities to each tool
- Tools check capabilities before execution
- Violations logged as `security_block` in audit

### 2.2 Session Integrity

**Goal:** Agent cannot silently modify its own history.

**Modify:** `src/history.ts`

**Implementation:**
- HMAC-SHA256 signature on each message in session history
- Key derived from session ID + machine-specific secret
- `saveMessages()` signs each message
- `loadMessages()` verifies signatures, rejects tampered messages
- Separate signing key stored outside session directory

**New files:**
- `src/integrity.ts` — Message signing and verification
- `src/integrity.test.ts` — Tamper detection tests

### 2.3 Git-Native Workflow Mode

**Goal:** Agent always works on a branch, never touches main directly.

**Modify:** `src/tools/git.ts`, `src/agent.ts`

**Implementation:**
- If `policy.git.always_branch === true`:
  - On first write/edit: auto-create `codebot/<timestamp>-<task-slug>` branch
  - All commits go to feature branch
  - `git push` blocked to main/master
  - On session end: offer to create PR (if `gh` available)
- Branch naming: `codebot/20260301-fix-auth-bug`
- Commit messages include session ID for traceability

### 2.4 Token & Cost Tracking

**Goal:** Know exactly what every session costs.

**New files:**
- `src/telemetry.ts` — Token counter, cost calculator
- `src/telemetry.test.ts` — Calculation tests

**Implementation:**
- Track per-request: input tokens, output tokens, model, provider
- Calculate cost using provider pricing tables
- Running total displayed in CLI status line
- Session summary at end: total tokens, cost, tool calls, duration
- `policy.limits.cost_limit_usd` — Hard stop when exceeded
- `codebot --usage` — Show historical usage stats

**Files to modify:**
- `src/providers/anthropic.ts` — Extract token counts from response
- `src/providers/openai.ts` — Extract token counts from response
- `src/agent.ts` — Accumulate and enforce cost limits
- `src/cli.ts` — Display running cost, add `--usage` flag

### Phase 2 Gate Criteria

- [ ] Tool capabilities enforced per-session based on policy
- [ ] Session history tamper-resistant (HMAC chain, verification on load)
- [ ] `always_branch` mode creates feature branches, blocks main pushes
- [ ] Token/cost tracking shows per-session and cumulative usage
- [ ] Cost limit enforcement stops agent when budget exceeded
- [ ] 300+ tests passing

---

## Phase 3: Observable (v1.9.0) — Weeks 7-9

**Theme:** _"If you can't measure it, you can't trust it."_

### 3.1 Structured Telemetry

**New files:**
- `src/telemetry/collector.ts` — Metrics collection
- `src/telemetry/exporters.ts` — Export formats (JSON, OpenTelemetry)
- `src/telemetry/telemetry.test.ts`

**Metrics collected:**
```
session_duration_seconds
tool_calls_total{tool, result}
tool_latency_seconds{tool}
llm_requests_total{provider, model, status}
llm_tokens_total{provider, model, direction}
llm_latency_seconds{provider, model}
cache_hits_total{tool}
cache_misses_total{tool}
security_blocks_total{tool, reason}
permission_denials_total{tool}
files_written_total
files_edited_total
commands_executed_total
errors_total{tool, type}
```

**Export formats:**
- JSON (default) — `~/.codebot/telemetry/`
- OpenTelemetry (optional) — if `OTEL_EXPORTER_OTLP_ENDPOINT` set
- Plain text summary — on session end

### 3.2 Risk Scoring

**New files:**
- `src/risk.ts` — Risk assessment engine
- `src/risk.test.ts`

**Implementation:**
Every tool call gets a risk score (0-100):

| Factor | Weight |
|--------|--------|
| Tool permission level | 30 |
| File path sensitivity | 20 |
| Command destructiveness | 20 |
| Network access | 15 |
| Data volume | 10 |
| Cumulative session risk | 5 |

**Display:**
```
🟢 Low (0-25)    — auto-proceed
🟡 Medium (26-50) — brief confirmation
🟠 High (51-75)   — detailed confirmation with risk factors
🔴 Critical (76+) — requires explicit "I understand the risk" confirmation
```

**Integration:**
- `src/agent.ts` — Compute risk before permission check
- CLI shows risk indicator next to each tool call
- High-risk actions logged with full risk breakdown in audit

### 3.3 SARIF Export

**New files:**
- `src/export/sarif.ts` — SARIF 2.1.0 format export
- `src/export/sarif.test.ts`

**Goal:** Export audit/security events in SARIF format for integration with:
- GitHub Code Scanning
- Azure DevOps
- SonarQube
- Any SARIF-compatible tool

**CLI:** `codebot --export-audit sarif [session-id] > results.sarif`

### 3.4 Action Summaries & Diff Preview

**Modify:** `src/cli.ts`, `src/agent.ts`

**Implementation:**
- Before write/edit: show unified diff preview
- Before execute: show risk assessment
- Session end summary:
  ```
  Session Summary
  ──────────────
  Duration: 4m 32s
  Model: claude-sonnet-4-20250514 via Anthropic
  Tokens: 12,450 in / 3,200 out ($0.08)
  Tool calls: 14 (12 auto, 2 prompted, 0 denied)
  Files modified: 3
  Commands executed: 5 (all sandboxed)
  Risk score: 23/100 (Low)
  Audit log: ~/.codebot/audit/audit-2026-03-15.jsonl
  ```

### Phase 3 Gate Criteria

- [ ] Structured metrics collected for every session
- [ ] Optional OpenTelemetry export working
- [ ] Risk scoring displayed for every tool call
- [ ] SARIF export generates valid SARIF 2.1.0
- [ ] Session end summary shows tokens, cost, risk, files changed
- [ ] Diff preview before writes (opt-out via `--no-preview`)
- [ ] 350+ tests passing

---

## Phase 4: Enterprise (v2.0.0) — Weeks 10-13

**Theme:** _"Ready for teams."_

### 4.1 VS Code Extension

**New directory:** `extensions/vscode/`

**Scope:**
- Sidebar panel with CodeBot chat
- Inline diff preview for write/edit operations
- Status bar: model, tokens, cost, risk
- Command palette: `CodeBot: Start Session`, `CodeBot: Replay Session`, etc.
- Settings UI for policy configuration
- Uses CodeBot as a library (import from `codebot-ai`)

**Architecture:**
```
VS Code Extension
├── extension.ts — Activation, command registration
├── sidebar.ts — Chat UI webview
├── diff-preview.ts — Inline diff display
├── status-bar.ts — Token/cost/risk indicators
└── settings.ts — Policy configuration UI
```

### 4.2 GitHub Action

**New directory:** `actions/codebot/`

**Use cases:**
- PR review bot: Analyze PR, post review comments
- Auto-fix: Run CodeBot on failing CI, push fix
- Security scan: Run CodeBot's secret/path scanning on PRs

**action.yml:**
```yaml
name: 'CodeBot AI'
description: 'Autonomous AI code agent'
inputs:
  task:
    description: 'Task for CodeBot to perform'
    required: true
  model:
    description: 'LLM model to use'
    default: 'claude-sonnet-4-20250514'
  sandbox:
    description: 'Execution sandbox mode'
    default: 'docker'
  policy:
    description: 'Path to policy file'
    default: '.codebot/policy.json'
runs:
  using: 'node20'
  main: 'dist/index.js'
```

### 4.3 Documentation Suite

**New files:**
- `SECURITY.md` — Security model, threat vectors, mitigations
- `docs/THREAT_MODEL.md` — Formal threat model (STRIDE-based)
- `docs/ARCHITECTURE.md` — System architecture with diagrams
- `docs/POLICY_GUIDE.md` — Policy configuration reference
- `docs/DEPLOYMENT.md` — Deployment guide (local, CI, Docker)
- `docs/HARDENING.md` — Hardening guide for production
- `docs/COMPARISON.md` — Feature comparison vs Copilot/Cursor/Claude Code
- `CONTRIBUTING.md` — Contributor guide + CLA reference
- `CHANGELOG.md` — Full changelog from v1.0.0

### 4.4 Legal Framework

**New files:**
- `LICENSE` — Keep MIT (open core model)
- `CLA.md` — Contributor License Agreement
- `PRIVACY.md` — Privacy policy (telemetry opt-in, no PII collection)
- `DISCLAIMER.md` — Liability disclaimer for AI-generated code

### Phase 4 Gate Criteria

- [ ] VS Code extension installable from VSIX, basic chat + diff preview working
- [ ] GitHub Action runs CodeBot in CI, posts results
- [ ] SECURITY.md published with threat model
- [ ] All documentation written and reviewed
- [ ] Legal documents in place
- [ ] 400+ tests passing
- [ ] Full security audit of v2.0.0 codebase
- [ ] README rewritten for production positioning

---

## Version Milestones

| Version | Codename | Key Deliverable | Tests | Target |
|---------|----------|-----------------|-------|--------|
| v1.6.0 | Hardened | Security foundations | 217 | ✅ Done |
| v1.7.0 | Contained | Docker sandbox + policy engine | 250+ | Week 3 |
| v1.8.0 | Trustworthy | Zero-trust tools + session integrity + cost tracking | 300+ | Week 6 |
| v1.9.0 | Observable | Telemetry + risk scoring + SARIF | 350+ | Week 9 |
| v2.0.0 | Enterprise | VS Code + GitHub Action + docs + legal | 400+ | Week 13 |

---

## What We're NOT Building (Scope Control)

To prevent feature creep, these are explicitly **out of scope** for v2.0.0:

- ❌ Multi-agent orchestration (v2.1+)
- ❌ Desktop app (Electron/Tauri) — CLI + VS Code is sufficient
- ❌ Cloud hosted version — self-hosted only
- ❌ Custom model fine-tuning
- ❌ Billing/subscription system
- ❌ Team management / RBAC (v2.1+)
- ❌ Web dashboard
- ❌ Mobile app

These become relevant only after v2.0.0 proves the core is trustworthy.

---

## Competitive Position

After v2.0.0, CodeBot's positioning:

**"The secure, self-hosted AI engineering platform."**

| Feature | Copilot | Cursor | Claude Code | **CodeBot 2.0** |
|---------|---------|--------|-------------|-----------------|
| Self-hosted | ❌ | ❌ | ❌ | ✅ |
| Any LLM | ❌ | Partial | ❌ | ✅ |
| Sandboxed execution | ❌ | ❌ | Partial | ✅ |
| Policy engine | ❌ | ❌ | ❌ | ✅ |
| Audit trail | ❌ | ❌ | ❌ | ✅ |
| Risk scoring | ❌ | ❌ | ❌ | ✅ |
| Zero dependencies | ❌ | ❌ | ❌ | ✅ |
| Open source | ❌ | ❌ | ❌ | ✅ |
| SARIF export | ❌ | ❌ | ❌ | ✅ |

**The only open-source AI coding agent that's secure by default, auditable, and policy-driven.**

---

## Success Metrics

At v2.0.0 launch, we should be able to truthfully say:

1. ✅ It cannot execute arbitrary host commands without sandbox
2. ✅ It cannot exfiltrate secrets by default
3. ✅ It cannot modify outside the repo unless policy allows
4. ✅ It logs every action in a tamper-evident chain
5. ✅ It can be audited (SARIF, JSON, plaintext)
6. ✅ It fails safely (circuit breakers, cost limits, risk scoring)
7. ✅ It is tested (400+ tests)
8. ✅ It has documentation (security, architecture, policy, hardening)
9. ✅ It has a threat model (STRIDE-based)
10. ✅ It has a clear use case and competitive position
