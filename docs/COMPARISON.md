# Feature Comparison

How CodeBot AI compares to other AI coding assistants.

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

## Key Differentiators

### Security-First
CodeBot is the only AI coding agent with a full security stack: policy engine, capability-based permissions, sandbox execution, hash-chained audit logs, secret detection, SSRF protection, and risk scoring.

### Provider Agnostic
Works with any LLM: Ollama, Claude, GPT, Gemini, DeepSeek, Groq, Mistral, Grok — or any OpenAI-compatible API. Switch models with a single flag.

### Zero Dependencies
The core package has zero runtime dependencies. Everything is built on Node.js built-ins. This means fewer supply chain risks and smaller attack surface.

### Self-Hosted
All data stays on your machine. No cloud accounts required. No telemetry sent (unless you opt in via OpenTelemetry).

### Auditable
Every action is logged in a tamper-evident chain. Export to SARIF for CI/CD integration. Verify integrity with `--verify-audit`.
