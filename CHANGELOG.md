# Changelog

## [2.0.0] — 2026-02-28

### Added
- **VS Code Extension** (`codebot-ai-vscode`) — sidebar chat panel, inline diff preview, status bar (tokens, cost, risk level), webview with VS Code theme integration
- **GitHub Action** (`@codebot-ai/action`) — PR review, auto-fix CI failures, security scan with SARIF upload to GitHub Code Scanning
- **Library API: `projectRoot`** — Agent constructor accepts optional `projectRoot` for embedding in VS Code, GitHub Actions, or custom integrations
- **Library API: `VERSION` export** — `import { VERSION } from 'codebot-ai'`
- **Documentation suite** — SECURITY.md, ARCHITECTURE.md, POLICY_GUIDE.md, THREAT_MODEL.md, DEPLOYMENT.md, HARDENING.md, COMPARISON.md, CONTRIBUTING.md
- **Legal framework** — CLA.md, PRIVACY.md, DISCLAIMER.md
- 104 new tests (483 total: 379 core + 104 extension/action)

### Changed
- Agent constructor: `process.cwd()` replaced with configurable `projectRoot` (backward-compatible)
- Package version bumped to 2.0.0

## [1.9.0] — 2026-02-28

### Added
- **Structured metrics** — `MetricsCollector` with counters, histograms, JSONL persistence, optional OpenTelemetry OTLP export
- **Risk scoring** — `RiskScorer` with 6-factor weighted assessment (0-100): permission level, file path sensitivity, command destructiveness, network access, data volume, cumulative session risk
- **SARIF 2.1.0 export** — `exportSarif()` converts audit entries to SARIF for GitHub Code Scanning, Azure DevOps, SonarQube
- **Per-tool latency tracking** — `tool_latency_seconds` histogram for every tool execution
- **Risk indicators in CLI** — colored `[Risk: N level]` display on each tool call
- **Enhanced session summaries** — per-tool breakdown with call counts, timing, risk average
- **`/metrics` command** — show session metrics snapshot
- **`/risk` command** — show risk assessment history
- **`--export-audit sarif` flag** — export audit log as SARIF to stdout
- 69 new tests (376 total)

## [1.1.0] — 2026-02-26

### Added
- **Diff preview** on file edits — shows before/after context before writing
- **Undo support** — automatic file snapshots before edits, `/undo` command to restore
- **Multi-file batch editing** — new `batch_edit` tool for atomic multi-file changes
- **Token usage tracking** — cumulative session cost tracking with `/usage` command
- **Plugin system** — load custom tools from `.codebot/plugins/`
- **MCP server support** — connect external tool servers via Model Context Protocol
- **GitHub Actions CI** — automated test pipeline on push/PR
- Hardened command blocklist with 20+ dangerous patterns

### Fixed
- npm bin script path warning on publish

## [1.0.2] — 2026-02-26

### Security
- Fixed **CRITICAL** selector injection XSS in browser tool
- Fixed **CRITICAL** path traversal in memory tool
- Fixed **HIGH** SSRF in web fetch — blocks private IPs, file://, metadata endpoints
- Fixed **HIGH** invalid regex crash in grep tool
- Fixed **HIGH** content buffer loss on stream end in OpenAI provider
- Fixed **MEDIUM** symlink loop in glob tool
- Added input validation guards to all 10 tools
- Added 21 security-focused tests (83 total)

## [1.0.1] — 2026-02-26

### Fixed
- Garbled streaming output from qwen3/deepseek models — `<think>` tag filtering
- Setup wizard showing hardcoded model list instead of actual Ollama models

## [1.0.0] — 2026-02-26

Initial release.

### Features
- **Agent Loop**: Streaming async generator with tool execution, permission system, and XML/JSON fallback parsing
- **10 Tools**: read_file, write_file, edit_file, execute, glob, grep, think, memory, web_fetch, browser
- **8 LLM Providers**: Ollama, LM Studio, vLLM (local), Anthropic, OpenAI, Gemini, DeepSeek, Groq, Mistral, xAI (cloud)
- **40+ Models**: Full model registry with context windows, tool calling support flags, and auto-detection
- **Native Anthropic Provider**: Direct Claude API with streaming, tool_use blocks, extended thinking support
- **Browser Automation**: Chrome control via CDP with zero-dep WebSocket client
- **Persistent Memory**: Global and project-level memory that survives across sessions
- **Session Persistence**: Auto-save conversations to JSONL, resume with --continue or --resume
- **LLM-Powered Context Compaction**: Summarizes dropped messages using the LLM
- **Interactive Setup Wizard**: Auto-detects environment, guides configuration on first run
- **Autonomous Mode**: --autonomous flag skips all permission prompts
- **Permission System**: Three levels (auto, prompt, always-ask) with dangerous command blocking
- **Zero Runtime Dependencies**: Only TypeScript and @types/node as dev dependencies
