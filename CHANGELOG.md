# Changelog

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
