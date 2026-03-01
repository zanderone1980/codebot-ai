# Feature Comparison

How CodeBot AI compares to other AI coding assistants and autonomous agent frameworks.

## vs. AI Coding Assistants

| Feature | GitHub Copilot | Cursor | Claude Code | **CodeBot 2.0** |
|---------|---------------|--------|-------------|-----------------|
| Self-hosted | No | No | No | **Yes** |
| Any LLM provider | No | Partial | No | **Yes** |
| Sandboxed execution | No | No | Partial | **Yes** |
| Policy engine | No | No | No | **Yes** |
| Audit trail | No | No | No | **Yes** |
| Risk scoring | No | No | No | **Yes** |
| Zero dependencies | No | No | No | **Yes** |
| Open source | No | No | No | **Yes** |
| SARIF export | No | No | No | **Yes** |
| VS Code extension | Yes | Built-in | No | **Yes** |
| GitHub Action | Partial | No | No | **Yes** |
| CLI interface | No | No | Yes | **Yes** |
| Secret detection | No | No | No | **Yes** |
| Cost tracking | No | No | No | **Yes** |
| Session replay | No | No | No | **Yes** |

## vs. Autonomous Agent Frameworks

| Feature | Auto-GPT | CrewAI | LangChain Agents | MetaGPT | **CodeBot 2.0** |
|---------|----------|--------|-------------------|---------|-----------------|
| **Focus** | General tasks | Multi-agent | General tasks | Software dev | **Software dev** |
| Zero dependencies | No (100+ deps) | No (50+ deps) | No (200+ deps) | No (60+ deps) | **Yes (0 deps)** |
| Self-hosted | Yes | Yes | Yes | Yes | **Yes** |
| Any LLM provider | Yes | Yes | Yes | Partial | **Yes** |
| Sandboxed execution | No | No | No | No | **Yes** |
| Policy engine | No | No | No | No | **Yes** |
| Audit trail | No | No | No | No | **Yes** |
| Risk scoring | No | No | No | No | **Yes** |
| SARIF export | No | No | No | No | **Yes** |
| VS Code extension | No | No | No | No | **Yes** |
| GitHub Action | No | No | No | No | **Yes** |
| CLI interface | Yes | No | No | Yes | **Yes** |
| Browser automation | Via plugin | No | Via tool | No | **Built-in (CDP)** |
| Secret detection | No | No | No | No | **Yes** |
| Cost tracking | Basic | No | Via callback | No | **Built-in** |
| Session replay | No | No | No | No | **Yes** |
| Persistent memory | Via plugin | No | Via store | No | **Built-in** |
| Plugin system | Yes | No | Yes | No | **Yes** |
| MCP support | No | No | No | No | **Yes** |

### CodeBot vs. Auto-GPT: In Depth

Auto-GPT pioneered the autonomous agent concept but takes a fundamentally different approach:

**Architecture:**
- Auto-GPT: Plugin-heavy architecture with 100+ dependencies including Redis, Docker SDK, ChromeDriver, and numerous Python packages
- CodeBot: Zero runtime dependencies — everything built on Node.js built-ins, resulting in a 135KB package

**Security:**
- Auto-GPT: Relies on workspace-level file isolation but has no policy engine, no risk scoring, and no audit trail
- CodeBot: 8-layer security stack — policy engine, capability-based permissions, Docker sandbox, secret detection, SSRF protection, path safety, risk scoring, and hash-chained audit logs

**LLM Support:**
- Auto-GPT: Primarily OpenAI-focused, with adapters for other providers
- CodeBot: First-class support for 8+ providers (Ollama, Claude, GPT, Gemini, DeepSeek, Groq, Mistral, Grok) with automatic detection

**Stability:**
- Auto-GPT: Known for looping behavior and high token consumption
- CodeBot: Configurable iteration limits, cost caps, risk-based confirmation gates, and automatic context compaction

**Enterprise Readiness:**
- Auto-GPT: No VS Code extension, no GitHub Action, no SARIF export, no policy-as-code
- CodeBot: Full enterprise stack — VS Code extension, GitHub Action for CI/CD, SARIF export for code scanning, declarative policy engine

**When to use Auto-GPT:** General-purpose autonomous tasks beyond software development — web research, data analysis, business automation.

**When to use CodeBot:** Software development workflows where security, auditability, and enterprise integration matter — code review, bug fixing, security scanning, CI/CD automation.

## Key Differentiators

### Security-First
CodeBot is the only AI coding agent with a full security stack: policy engine, capability-based permissions, sandbox execution, hash-chained audit logs, secret detection, SSRF protection, and risk scoring.

### Provider Agnostic
Works with any LLM: Ollama, Claude, GPT, Gemini, DeepSeek, Groq, Mistral, Grok — or any OpenAI-compatible API. Switch models with a single flag.

### Zero Dependencies
The core package has zero runtime dependencies. Everything is built on Node.js built-ins. This means fewer supply chain risks and smaller attack surface. Compare: Auto-GPT has 100+ dependencies, LangChain has 200+.

### Self-Hosted
All data stays on your machine. No cloud accounts required. No telemetry sent (unless you opt in via OpenTelemetry).

### Auditable
Every action is logged in a tamper-evident chain. Export to SARIF for CI/CD integration. Verify integrity with `--verify-audit`.

### Lightweight
The npm package is 135KB. Install in seconds, run instantly. No Docker required (but recommended for sandboxing). No database. No Redis. No external services.
