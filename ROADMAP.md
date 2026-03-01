# CodeBot AI — Roadmap

**Philosophy:** Ship something hardened at every checkpoint. No big bangs.

---

## Current State (v2.0.0) ✅ SHIPPED

| Metric | Value |
|--------|-------|
| Version | 2.0.0 |
| Tests | 483 passing (379 core + 104 extension/action) |
| Tools | 28 built-in + MCP + plugins |
| Security | 8-layer stack: policy, capabilities, permissions, risk scoring, path safety, secret detection, SSRF, sandbox |
| Platforms | CLI, VS Code extension, GitHub Action |
| npm | [codebot-ai@2.0.0](https://www.npmjs.com/package/codebot-ai) |

### Completed Milestones

| Version | Codename | Key Deliverable | Tests | Status |
|---------|----------|-----------------|-------|--------|
| v1.0.0 | Genesis | Core agent, 10 tools, 8 providers | 54 | ✅ |
| v1.1.0 | Extended | Diff preview, undo, batch edit, plugins, MCP | 83 | ✅ |
| v1.5.0 | Performance | Parallel execution, caching, rate limiting | 148 | ✅ |
| v1.6.0 | Hardened | Security foundations (path safety, secrets, audit, SSRF) | 217 | ✅ |
| v1.7.0 | Contained | Docker sandbox, policy engine, hash-chained audit, replay | 260 | ✅ |
| v1.8.0 | Trustworthy | Capabilities, session integrity (HMAC), git workflow, cost tracking | 307 | ✅ |
| v1.9.0 | Observable | Structured metrics, risk scoring, SARIF export | 376 | ✅ |
| v2.0.0 | Enterprise | VS Code extension, GitHub Action, docs, legal | 483 | ✅ |

### v2.0.0 Success Metrics ✅

1. ✅ Cannot execute arbitrary host commands without sandbox
2. ✅ Cannot exfiltrate secrets by default
3. ✅ Cannot modify outside the repo unless policy allows
4. ✅ Logs every action in a tamper-evident chain
5. ✅ Can be audited (SARIF, JSON, plaintext)
6. ✅ Fails safely (circuit breakers, cost limits, risk scoring)
7. ✅ Tested (483 tests)
8. ✅ Has documentation (security, architecture, policy, hardening)
9. ✅ Has a threat model (STRIDE-based)
10. ✅ Has a clear use case and competitive position

---

## Next: v2.1.0 — Teams & Ecosystem

**Theme:** _"Scale beyond a single developer."_
**Target:** Q2 2026

### Multi-Agent Orchestration
- Agent-to-agent delegation (parent spawns child agents for subtasks)
- Shared context passing between agents
- Parallel tool execution across agents
- Coordinator pattern for complex multi-step workflows

### Team Policies
- Organization-level policy inheritance (org → team → project)
- Role-based tool access (admin, developer, reviewer)
- Shared policy repository via git
- Policy validation CLI: `codebot --validate-policy`

### Plugin Marketplace
- Community plugin registry (searchable, versioned)
- MCP server discovery
- One-click install: `codebot --install-plugin <name>`
- Plugin security audit (dependency scan, permission review)

### Enhanced Provider Support
- Streaming structured output (JSON mode)
- Vision/multimodal support (send screenshots to LLM)
- Prompt caching (Anthropic, Google)
- Model routing (auto-select model by task complexity)

### Gate Criteria
- 550+ tests
- Multi-agent demo working end-to-end
- Plugin registry MVP deployed
- At least 3 community plugins published

---

## v2.2.0 — Platform

**Theme:** _"Run anywhere."_
**Target:** Q3 2026

### Features
- Web dashboard for session monitoring and team analytics
- REST API server mode (`codebot --serve`)
- Webhook integrations (Slack, Discord, Teams)
- Custom model fine-tuning pipeline
- OpenTelemetry dashboard templates (Grafana, Datadog)
- Kubernetes operator for managed deployments

### Gate Criteria
- Web dashboard deployed
- REST API with OpenAPI spec
- At least 2 webhook integrations working
- 650+ tests

---

## What We're NOT Building (Scope Control)

Explicitly **out of scope**:

- ❌ Desktop app (Electron/Tauri) — CLI + VS Code is sufficient
- ❌ Cloud hosted version — self-hosted only
- ❌ Billing/subscription system
- ❌ Mobile app
- ❌ Proprietary license — staying MIT

---

## Competitive Position

**"The secure, self-hosted AI engineering platform."**

The only open-source AI coding agent that is:
- **Secure by default** — 8-layer security stack
- **Auditable** — hash-chained SARIF-exportable audit trail
- **Policy-driven** — declarative JSON security policies
- **Provider-agnostic** — any LLM, local or cloud
- **Zero dependencies** — 135KB npm package
- **Enterprise-ready** — VS Code extension, GitHub Action, CI/CD integration
