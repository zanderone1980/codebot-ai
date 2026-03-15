# CodeBot AI — Roadmap

**Philosophy:** Ship something hardened at every checkpoint. No big bangs.

---

## Current State (v2.9.0) — SHIPPED

| Metric | Value |
|--------|-------|
| Version | 2.9.0 |
| Tests | 1,265 passing (242 suites) |
| Tools | 31 built-in + MCP + plugins |
| Connectors | 10 app integrations |
| Providers | 8 LLM providers (local + cloud) |
| Security | 8-layer stack: policy, RBAC, capabilities, risk scoring, path safety, secret detection, SSRF, sandbox |
| Platforms | CLI, VS Code extension, GitHub Action, Web Dashboard |
| CI | 3 OS (macOS, Linux, Windows) x 3 Node versions (18, 20, 22) |
| npm | [codebot-ai@2.9.0](https://www.npmjs.com/package/codebot-ai) |

### Completed Milestones

| Version | Codename | Key Deliverable | Tests | Status |
|---------|----------|-----------------|-------|--------|
| v1.0.0 | Genesis | Core agent, 10 tools, 8 providers | 54 | Shipped |
| v1.1.0 | Extended | Diff preview, undo, batch edit, plugins, MCP | 83 | Shipped |
| v1.5.0 | Performance | Parallel execution, caching, rate limiting | 148 | Shipped |
| v1.6.0 | Hardened | Security foundations (path safety, secrets, audit, SSRF) | 217 | Shipped |
| v1.7.0 | Contained | Docker sandbox, policy engine, hash-chained audit, replay | 260 | Shipped |
| v1.8.0 | Trustworthy | Capabilities, session integrity (HMAC), git workflow, cost tracking | 307 | Shipped |
| v1.9.0 | Observable | Structured metrics, risk scoring, SARIF export | 376 | Shipped |
| v2.0.0 | Enterprise | VS Code extension, GitHub Action, docs, legal | 483 | Shipped |
| v2.1.0 | RBAC | RBAC sweep, encryption at rest, ESLint | 491 | Shipped |
| v2.1.6 | Intelligence | Prompt caching, vision/multimodal, model routing, JSON mode | 586 | Shipped |
| v2.2.0 | Quality | CLI UI polish, permission cards, cost estimation, browser resilience | 907 | Shipped |
| v2.3.0 | Platform | TUI mode, web dashboard, theme system, provider rate limiting | 1,035 | Shipped |
| v2.5.0 | Ecosystem | App connectors (10), credential vault, skills system | 1,114 | Shipped |
| v2.5.2 | Command | Dashboard Command Center, terminal, quick actions, tool runner | 1,135 | Shipped |
| v2.7.0 | Safety | Constitutional AI (CORD engine, VIGIL patrol), security dashboard | 1,168 | Shipped |
| v2.7.7 | Hardening | Centralized CODEBOT_HOME paths, warnNonFatal, cli decomposition | 1,217 | Shipped |
| v2.8.0 | Operational | Dashboard models panel, CodeAGI continuous mode, doc overhaul | 1,265 | Shipped |
| v2.9.0 | Trust | Agent decomposition, offline cache, plugin validation, risk dashboard | 1,265 | Shipped |

---

## Next: v3.0.0 — Teams and Ecosystem

**Theme:** Scale beyond a single developer.

### Planned
- Organization-level policy inheritance (org, team, project)
- Plugin marketplace with community registry
- REST API server mode (`codebot --serve`) with OpenAPI spec
- Webhook integrations (Slack, Discord, Teams)

---

## What We Are NOT Building

- Desktop app (Electron/Tauri) — CLI + VS Code is sufficient
- Cloud hosted version — self-hosted only
- Billing/subscription system — MIT stays free
- Mobile app
- Proprietary license — staying MIT

---

## Competitive Position

**The safe, local-first autonomous coding agent.**

- **Secure by default** — 8-layer security stack from day one
- **Auditable** — hash-chained SARIF-exportable audit trail
- **Policy-driven** — declarative JSON security policies
- **Provider-agnostic** — any LLM, local or cloud
- **Tested** — 1,265 tests across 3 OS and 3 Node versions
- **Enterprise-ready** — VS Code extension, GitHub Action, CI/CD integration
