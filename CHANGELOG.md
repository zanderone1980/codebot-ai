# Changelog

## [2.5.2] — 2026-03-04

### Added
- **Command Center** — fully functional interactive dashboard tab with 4 sub-features:
  - **Terminal** — execute shell commands with live streaming output, command history (arrow keys)
  - **Quick Actions** — 8 one-click buttons (Git Status, Run Tests, Git Log, Git Diff, Health Check, List Tools, List Files, NPM Outdated)
  - **Chat** — interactive AI chat with agent (requires `codebot --dashboard`)
  - **Tool Runner** — select any tool, fill parameters via dynamic form, execute with result display
- **Standalone mode** — Terminal + Quick Actions work without agent connection
- **Dual-mode Quick Actions** — AI-powered summaries with agent, direct shell exec standalone
- **Standalone Mode badge** — clear visual indicator when running without agent
- **SSE streaming** for all command execution (chat, exec, quick actions)
- **Concurrency guard** — prevents parallel agent.run() calls (409 Conflict)

### Changed
- Dashboard Command tab defaults to Terminal in standalone mode
- Chat and Tool Runner tabs gracefully disabled (greyed out) without agent
- Version alignment: cli.ts, index.ts, and package.json now all report 2.5.2
- Tests: 1125 → 1135+ (command-api standalone tests added)

### Security
- Terminal commands filtered against BLOCKED_PATTERNS (dangerous command rejection)
- Environment variables sanitized before child process spawn (API keys stripped)
- 30-second timeout on all terminal commands with SIGTERM


## [2.5.1] — 2026-03-03

### Added
- **Graphics toolchain** — OpenAI DALL-E image generation, Replicate ML model connector, graphics processing tool
- **OpenAI Images connector** — generate, edit, and create variations via DALL-E 2/3
- **Replicate connector** — run any ML model on Replicate's API with automatic polling
- **Graphics tool** — resize, crop, rotate, flip, convert, compress, watermark, thumbnail generation

### Fixed
- `pollPrediction` return type in replicate.ts — added missing `id` field


## [2.5.0] — 2026-03-03

### Added
- **App connectors** — GitHub, Jira, Linear, Slack integrations with OAuth/API key auth
- **Credential vault** — encrypted storage for API keys and tokens (AES-256-GCM)
- **Skills system** — reusable prompt-based workflows with parameter templating
- **Connector registry** — discover, configure, and manage external app connections
- **`app-connector` tool** — unified interface for all connector operations

### Changed
- Tests: 1035 → 1114 (connector + vault + skills tests)


## [2.5.2] — 2026-03-04

### Added
- **Command Center** — fully functional interactive dashboard tab with 4 sub-features:
  - **Terminal** — execute shell commands with live streaming output, command history (arrow keys)
  - **Quick Actions** — 8 one-click buttons (Git Status, Run Tests, Git Log, Git Diff, Health Check, List Tools, List Files, NPM Outdated)
  - **Chat** — interactive AI chat with agent (requires `codebot --dashboard`)
  - **Tool Runner** — select any tool, fill parameters via dynamic form, execute with result display
- **Standalone mode** — Terminal + Quick Actions work without agent connection
- **Dual-mode Quick Actions** — AI-powered summaries with agent, direct shell exec standalone
- **Standalone Mode badge** — clear visual indicator when running without agent
- **SSE streaming** for all command execution (chat, exec, quick actions)
- **Concurrency guard** — prevents parallel agent.run() calls (409 Conflict)

### Changed
- Dashboard Command tab defaults to Terminal in standalone mode
- Chat and Tool Runner tabs gracefully disabled (greyed out) without agent
- Version alignment: cli.ts, index.ts, and package.json now all report 2.5.2
- Tests: 1125 → 1135+ (command-api standalone tests added)

### Security
- Terminal commands filtered against BLOCKED_PATTERNS (dangerous command rejection)
- Environment variables sanitized before child process spawn (API keys stripped)
- 30-second timeout on all terminal commands with SIGTERM


## [2.5.1] — 2026-03-03

### Added
- **Graphics toolchain** — OpenAI DALL-E image generation, Replicate ML model connector, graphics processing tool
- **OpenAI Images connector** — generate, edit, and create variations via DALL-E 2/3
- **Replicate connector** — run any ML model on Replicate's API with automatic polling
- **Graphics tool** — resize, crop, rotate, flip, convert, compress, watermark, thumbnail generation

### Fixed
- `pollPrediction` return type in replicate.ts — added missing `id` field


## [2.5.0] — 2026-03-03

### Added
- **App connectors** — GitHub, Jira, Linear, Slack integrations with OAuth/API key auth
- **Credential vault** — encrypted storage for API keys and tokens (AES-256-GCM)
- **Skills system** — reusable prompt-based workflows with parameter templating
- **Connector registry** — discover, configure, and manage external app connections
- **`app-connector` tool** — unified interface for all connector operations

### Changed
- Tests: 1035 → 1114 (connector + vault + skills tests)


## [2.5.2] — 2026-03-04

### Added
- **Command Center** — fully functional interactive dashboard tab with 4 sub-features:
  - **Terminal** — execute shell commands with live streaming output, command history (arrow keys)
  - **Quick Actions** — 8 one-click buttons (Git Status, Run Tests, Git Log, Git Diff, Health Check, List Tools, List Files, NPM Outdated)
  - **Chat** — interactive AI chat with agent (requires `codebot --dashboard`)
  - **Tool Runner** — select any tool, fill parameters via dynamic form, execute with result display
- **Standalone mode** — Terminal + Quick Actions work without agent connection
- **Dual-mode Quick Actions** — AI-powered summaries with agent, direct shell exec standalone
- **Standalone Mode badge** — clear visual indicator when running without agent
- **SSE streaming** for all command execution (chat, exec, quick actions)
- **Concurrency guard** — prevents parallel agent.run() calls (409 Conflict)

### Changed
- Dashboard Command tab defaults to Terminal in standalone mode
- Chat and Tool Runner tabs gracefully disabled (greyed out) without agent
- Version alignment: cli.ts, index.ts, and package.json now all report 2.5.2
- Tests: 1125 → 1135+ (command-api standalone tests added)

### Security
- Terminal commands filtered against BLOCKED_PATTERNS (dangerous command rejection)
- Environment variables sanitized before child process spawn (API keys stripped)
- 30-second timeout on all terminal commands with SIGTERM


## [2.5.1] — 2026-03-03

### Added
- **Graphics toolchain** — OpenAI DALL-E image generation, Replicate ML model connector, graphics processing tool
- **OpenAI Images connector** — generate, edit, and create variations via DALL-E 2/3
- **Replicate connector** — run any ML model on Replicate's API with automatic polling
- **Graphics tool** — resize, crop, rotate, flip, convert, compress, watermark, thumbnail generation

### Fixed
- `pollPrediction` return type in replicate.ts — added missing `id` field


## [2.5.0] — 2026-03-03

### Added
- **App connectors** — GitHub, Jira, Linear, Slack integrations with OAuth/API key auth
- **Credential vault** — encrypted storage for API keys and tokens (AES-256-GCM)
- **Skills system** — reusable prompt-based workflows with parameter templating
- **Connector registry** — discover, configure, and manage external app connections
- **`app-connector` tool** — unified interface for all connector operations

### Changed
- Tests: 1035 → 1114 (connector + vault + skills tests)


## [2.3.0] — 2026-03-02

### Added
- **TUI mode** (`--tui`) — full terminal UI with plan/output/details panels, keyboard-driven navigation (Tab=cycle, arrows=scroll, y/n=approve/deny, q=quit), real-time step tracking
- **Web dashboard** (`--dashboard`) — local browser UI on port 3120 with session history, audit chain viewer with integrity verification, metrics summary, and SARIF export
- **Theme system** (`--theme <name>`) — dark, light, and mono themes with semantic color roles; respects `NO_COLOR` env; persisted in config; `/theme` slash command
- **Provider-aware rate limiting** — proactive sliding-window RPM/TPM tracking per provider (Anthropic, OpenAI, Gemini, DeepSeek, Groq, Mistral, xAI); automatic backoff on 429; `/rate` slash command
- **Per-tool cost breakdown** — `TokenTracker.getToolCostBreakdown()` with per-tool input/output tokens, USD cost, call count, and percentage of total; `/toolcost` slash command
- **`codebot doctor`** (`--doctor`) — 12 environment health checks (Node, npm, config, sessions, audit integrity, disk, local LLM, cloud API keys, encryption, git, Docker); `/doctor` slash command
- **Enhanced streaming display** — `streamingIndicator()` with tokens/sec, `budgetBar()` with color gradient, `costBadge()` for REPL prompt, `timedStep()` for step timing, `collapsibleSection()` for verbose output
- **TUI layout engine** — `LayoutEngine` with panel management, focus cycling, scroll, bordered rendering; `Screen` abstraction with alt screen buffer; `KeyboardListener` with raw stdin parsing
- **Dashboard REST API** — 9 endpoints: `/api/health`, `/api/sessions` (paginated), `/api/sessions/:id`, `/api/audit` (filterable), `/api/audit/verify`, `/api/audit/:sessionId`, `/api/metrics/summary`, `/api/usage`, `POST /api/audit/export`
- **`--no-stream` flag** — disable streaming token display

### Changed
- CLI help text updated with all new flags (`--tui`, `--dashboard`, `--doctor`, `--theme`, `--no-stream`)
- UI component library: hardcoded colors replaced with theme-aware `getTheme().colors`
- Banner system: local color constants replaced with theme integration
- Agent loop: yields `stream_progress` events every 500ms during LLM streaming
- Agent loop: `ProviderRateLimiter` integrated — acquire/release/backoff around provider calls
- Tests: 907 → 1035+ (128 new tests across 12 test files)

### Security
- Dashboard server binds to `127.0.0.1` only (no network exposure)
- Dashboard static file serving prevents directory traversal
- Dashboard frontend uses `escapeHtml()` for all user-data rendering (XSS prevention)
- Audit chain verification endpoint validates SHA-256 hash chains


## [2.2.0] — 2026-03-02

### Added
- **907 comprehensive tests** — every tool has dedicated test file, 0 failures
- **UI component library** (`src/ui.ts`) — `box()`, `riskBar()`, `permissionCard()`, `spinner()`, `progressStep()`, `diffPreview()`, `sessionHeader()`, `summaryBox()` for premium CLI output
- **Permission cards** — bordered cards with tool name, risk bar, risk factors, sandbox/network status, approve/deny action bar
- **`--verbose` flag** — detailed output for tool results, usage events, and debugging
- **`--dry-run` / `--estimate` flags** — preview estimated cost before running a task
- **Cost estimation** — `estimateRunCost()` with heuristic task complexity classification (simple/medium/complex), model pricing lookup, confidence levels
- **`CostEstimate` interface** — `estimatedInputTokens`, `estimatedOutputTokens`, `estimatedCost`, `estimatedToolCalls`, `estimatedIterations`, `confidence`
- **`BrowserSession` class** — encapsulates browser connection state, replaces module-level globals
- **Browser auto-reconnect** — 3 retries with exponential backoff on WebSocket disconnect
- **Fetch-only fallback** — automatic HTTP fetch mode when Chrome is unavailable
- **`CHROME_PATH` env var** — custom Chrome installation path support
- **`onDisconnect` callback** — CDPClient connection monitoring
- **`TokenTracker` export** — `TokenTracker`, `UsageRecord`, `SessionSummary`, `CostEstimate` types exported from index
- **`BrowserSession` export** — browser session state accessible from library API
- **Multi-agent orchestration** — parent/child task delegation with `Orchestrator` and `DelegateTool`

### Changed
- CLI tool results: color-coded risk indicators (green/yellow/orange/red), multi-line args display, compact output with `--verbose` hint
- Session summary: boxed output with `summaryBox()`, risk average display
- Permission prompts: full permission cards with risk scoring and sandbox status
- Chrome error messages: actionable suggestions with installation options and `CHROME_PATH` hint
- Browser navigate: fallback to HTTP fetch when in fallback mode
- README: badges (907 tests, 0 deps, 28 tools), comparison table, Quick Local Start, Security at a Glance, Troubleshooting
- ROADMAP: all milestones through v2.1.6 marked as shipped
- Tests: 586 → 907 (321 new tests across 20 test files)

### Security
- Permission cards display risk score, exact arguments, sandbox status before tool execution
- Browser tool respects `CHROME_PATH` env var for reproducible CI environments


## [2.1.6] — 2026-03-01

### Added
- **Prompt caching** — Anthropic: `cache_control` on system prompt and tool definitions with `anthropic-beta: prompt-caching-2024-07-31` header; OpenAI: `stream_options.include_usage` for cache token tracking; cache metrics (`cache_creation_tokens_total`, `cache_read_tokens_total`, `cache_hits_total`) in MetricsCollector
- **Vision / multimodal** — `ImageAttachment` type on messages; Anthropic `image` content blocks with base64 source; OpenAI `image_url` content blocks with data URIs; browser screenshots auto-attached to tool messages for vision-capable models; image-aware token estimation (~1000 tokens/image) in ContextManager
- **Model routing** — `src/router.ts`: heuristic task classifier (fast/standard/powerful tiers); auto-detects tier models from provider family (Anthropic, OpenAI, Gemini, DeepSeek, Groq); `classifyComplexity()` and `classifyToolTier()` for per-turn model selection
- **JSON mode / structured output** — `buildToolCallSchema()` generates JSON schema for tool calling; `parseJsonModeResponse()` parses structured tool responses; OpenAI provider uses `response_format` with JSON schema when native tools unavailable; integrated as first fallback in `parseToolCalls()`

### Changed
- `UsageStats` extended with `cacheCreationTokens` and `cacheReadTokens` fields
- `ModelInfo` extended with `supportsCaching`, `supportsVision`, `supportsJsonMode`, and `tier` fields
- `Message` type extended with `images?: ImageAttachment[]` for multimodal content
- `ContextManager.fitsInBudget()` and `compact()` now use `estimateMessageTokens()` for image-aware budgeting
- 559 tests passing (up from 491)

## [2.1.5] — 2026-02-28

### Security
- **RBAC consistency sweep** — all 14 `PolicyEnforcer` methods now use `getEffectivePolicy()` instead of reading `this.policy` directly. Role overrides are now applied universally across filesystem, execution, git, secrets, MCP, and limits checks
- **Execute tool hardened** — uses `PolicyEnforcer` with RBAC instead of raw `loadPolicy()`, sandbox/network/memory settings now respect role overrides
- **Browser tool safety** — `killExistingChrome()` gated behind policy check; uses SIGTERM before SIGKILL for graceful shutdown; RBAC enforcement added to `BrowserTool.execute()`

### Added
- **Encryption at rest wired in** — `encryptLine`/`decryptLine` integrated into `SessionManager` (save, saveAll, load, verifyIntegrity, list) and `AuditLogger` (log, query); `encryptContent`/`decryptContent` integrated into `MemoryManager` (readGlobal, readProject, writeGlobal, writeProject, readDir). Opt-in via `CODEBOT_ENCRYPTION_KEY` env var

### Changed
- Version bumped to 2.1.5

## [2.1.4] — 2026-02-28

### Fixed
- **Animation visibility** — increased timing presets (~2x) so terminal animations are perceptible; changed CLI from 'fast' to 'normal' speed; added phase pauses between animation stages

## [2.1.3] — 2026-02-28

### Added
- **Terminal animation system** — 6 animation functions: `animateReveal`, `animateVisorScan`, `animateEyeBoot`, `animateBootSequence`, `animateTyping`, `animateSessionEnd`
- **`--no-animate` flag** — disable startup animations
- `shouldAnimate()` — auto-detects TTY, CI, dumb terminal
- Injectable `AnimationWriter` for testable animation output
- 15 new animation tests (469 total)

## [2.1.2] — 2026-02-28

### Changed
- Updated mascot ASCII art tests to match v3 enterprise block-character designs
- Updated BRANDING.md with final design names (Core, Terminal, Sentinel) and accurate ASCII art

## [2.1.1] — 2026-02-28

### Changed
- Mascot ASCII art redesigned — third iteration using solid block characters (█ ▄ ▀ ░ ▒ ▓) for enterprise-grade terminal presence
- Three canonical designs: Core (primary), Terminal (IDE), Sentinel (autonomous/CI)
- Inline status indicators using geometric symbols

## [2.1.0] — 2026-03-01

### Added
- **Role-Based Access Control (RBAC)** — `PolicyRole`, `PolicyRbac` interfaces, user-to-role mapping, role-scoped tool permissions, filesystem restrictions, and cost/iteration limits. Three built-in roles: `admin`, `developer`, `reviewer`
- **Encryption at rest** (`src/encryption.ts`) — AES-256-GCM encryption for audit logs, session files, and memory. PBKDF2-SHA512 key derivation (100K iterations). Opt-in via `CODEBOT_ENCRYPTION_KEY` env var or policy config
- **Distributed tracing** — `Span`, `SpanEvent` interfaces, `startSpan()`, `endSpan()`, `addSpanEvent()`, `exportTraces()` on `MetricsCollector`. OTLP `/v1/traces` HTTP export alongside existing `/v1/metrics`
- **ESLint + Prettier** — flat config ESLint with `@typescript-eslint`, Prettier for code formatting. New scripts: `lint`, `lint:fix`, `format`, `format:check`, `typecheck`
- **Library API exports** — `PolicyEnforcer`, `loadPolicy`, `generateDefaultPolicyFile`, `Policy`, `PolicyRbac`, `PolicyRole`, `Span`, `SpanEvent`, `EncryptionConfig` types
- 48 new tests (427 total: 379 core + 48 enterprise)

### Changed
- `PolicyEnforcer` methods (`isToolAllowed`, `getToolPermission`, `getToolCapabilities`, `checkCapability`) now use RBAC-aware effective policy
- `MetricsCollector` OTLP scope version bumped from `1.9.0` to `2.1.0`
- `generateDefaultPolicyFile()` includes RBAC example configuration
- CONTRIBUTING.md test count updated to 427+

## [2.0.1] — 2026-03-01

### Added
- **SOC 2 compliance guide** (`docs/SOC2_COMPLIANCE.md`) — full Trust Services Criteria mapping, readiness checklists, sample policies, auditor evidence guide
- **GitHub Copilot comparison** — in-depth head-to-head in `docs/COMPARISON.md` covering architecture, security, cost, extensibility
- **Auto-GPT comparison** — feature matrix and analysis vs CrewAI, LangChain, MetaGPT
- **Examples directory** — 6 runnable TypeScript demos (basic chat, code review, security scan, multi-model, event stream, policy enforcement)
- `.editorconfig` for consistent formatting across editors
- CI badge in README
- 13 new npm keywords for discoverability

### Changed
- Enhanced CI workflow with npm caching and extension/action test job
- Updated ROADMAP with completed milestones and v2.1/v2.2 plans
- Excluded `src/games/` from TypeScript compilation

### Fixed
- VERSION export in `src/index.ts` now matches `package.json`
- CONTRIBUTING.md test count updated from 376 to 483

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
