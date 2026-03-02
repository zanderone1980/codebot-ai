# CodeBot AI

[![CI](https://github.com/zanderone1980/codebot-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/zanderone1980/codebot-ai/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/codebot-ai.svg)](https://www.npmjs.com/package/codebot-ai)
[![license](https://img.shields.io/npm/l/codebot-ai.svg)](https://github.com/zanderone1980/codebot-ai/blob/main/LICENSE)
[![node](https://img.shields.io/node/v/codebot-ai.svg)](https://nodejs.org)
![tests](https://img.shields.io/badge/tests-880%20passing-brightgreen)
![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)
![tools](https://img.shields.io/badge/tools-28-blue)

**Zero-dependency autonomous AI coding agent with enterprise security.** Works with any LLM — local or cloud. Code, browse the web, run commands, search, automate routines, and more. Includes VS Code extension, GitHub Action, policy engine with RBAC, risk scoring, encryption at rest, and hash-chained audit trail.

Built by [Ascendral Software Development & Innovation](https://github.com/AscendralSoftware).

## Why CodeBot AI?

| Feature | CodeBot AI | Aider | Open Interpreter | Cursor |
|---------|-----------|-------|------------------|--------|
| Zero dependencies | Yes | No | No | No |
| Local LLM support | Yes | Yes | Yes | No |
| Security/RBAC | Yes | No | No | No |
| Browser automation | Yes | No | Yes | No |
| Risk scoring | Yes | No | No | No |
| Audit trail (SARIF) | Yes | No | No | No |
| VS Code extension | Yes | No | No | Yes |
| Programmatic API | Yes | No | Yes | No |

CodeBot AI is the only agent that combines zero-dependency simplicity with enterprise-grade security. It runs with any LLM provider (including fully local), ships with 28 built-in tools, and provides a complete audit trail for every action.

## Quick Start

```bash
npm install -g codebot-ai
codebot
```

That's it. The setup wizard launches on first run — pick your model, paste an API key (or use a local LLM), and you're coding.

```bash
# Or run without installing
npx codebot-ai
```

## Quick Local Start (Ollama)

```bash
ollama pull qwen2.5-coder
npm install -g codebot-ai
codebot --setup    # select "ollama", model "qwen2.5-coder"
```

No API keys, no cloud — everything runs on your machine.

## Supported Models

Pick any model during setup. CodeBot works with all of them:

| Provider | Models |
|----------|--------|
| **Local (Ollama/LM Studio/vLLM)** | qwen2.5-coder, qwen3, deepseek-coder, llama3.x, mistral, phi-4, codellama, starcoder2, and any model your server runs |
| **Anthropic** | claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5 |
| **OpenAI** | gpt-4o, gpt-4.1, o1, o3, o4-mini |
| **Google** | gemini-2.5-pro, gemini-2.5-flash, gemini-2.0-flash |
| **DeepSeek** | deepseek-chat, deepseek-reasoner |
| **Groq** | llama-3.3-70b, mixtral-8x7b |
| **Mistral** | mistral-large, codestral |
| **xAI** | grok-3, grok-3-mini |

For local models, just have Ollama/LM Studio/vLLM running — CodeBot auto-detects them.

For cloud models, set an environment variable:

```bash
export OPENAI_API_KEY="sk-..."           # GPT
export ANTHROPIC_API_KEY="sk-ant-..."    # Claude
export GEMINI_API_KEY="..."              # Gemini
export DEEPSEEK_API_KEY="sk-..."         # DeepSeek
export GROQ_API_KEY="gsk_..."            # Groq
export MISTRAL_API_KEY="..."             # Mistral
export XAI_API_KEY="xai-..."             # Grok
```

Or paste your key during setup — either way works.

### VS Code Extension

Install from the VS Code Marketplace: search for **CodeBot AI**, or:

```bash
code --install-extension codebot-ai-vscode-2.0.0.vsix
```

Features: sidebar chat panel, inline diff preview, status bar (tokens, cost, risk level), and full theme integration.

### GitHub Action

```yaml
- uses: zanderone1980/codebot-ai/actions/codebot@v2
  with:
    task: review    # or: fix, scan
    api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

Tasks: `review` (PR code review), `fix` (auto-fix CI failures), `scan` (security scan with SARIF upload).

### Release Pipeline

The release pipeline runs CI, builds artifacts, publishes to npm, and produces GitHub Releases with changelogs. Badge status reflects the latest pipeline result.

## What Can It Do?

- **Write & edit code** — reads your codebase, makes targeted edits, runs tests
- **Run shell commands** — system checks, builds, deploys, git operations
- **Browse the web** — navigates Chrome, clicks, types, reads pages, takes screenshots
- **Search the internet** — real-time web search for docs, APIs, current info
- **Automate routines** — schedule recurring tasks with cron (daily posts, email checks, monitoring)
- **Call APIs** — HTTP requests to any REST endpoint
- **Persistent memory** — remembers preferences and context across sessions
- **Self-recovering** — retries on network errors, recovers from API failures, never drops out

## Usage

```bash
codebot                                        # Interactive REPL
codebot "fix the bug in app.ts"                # Single task
codebot --autonomous "refactor auth and test"  # Full auto — no permission prompts
codebot --continue                             # Resume last session
echo "explain this error" | codebot            # Pipe mode
```

### CLI Options

```
--setup              Run the setup wizard
--model <name>       Model to use
--provider <name>    Provider: openai, anthropic, gemini, deepseek, groq, mistral, xai
--base-url <url>     LLM API base URL
--api-key <key>      API key (or use env vars)
--autonomous         Skip all permission prompts
--resume <id>        Resume a session by ID
--continue, -c       Resume the most recent session
--max-iterations <n> Max agent loop iterations (default: 50)
--no-animate         Disable mascot and banner animations
--verbose            Show detailed debug output
```

### Interactive Commands

```
/help       Show commands
/model      Show or change model
/models     List all supported models
/sessions   List saved sessions
/routines   List scheduled routines
/auto       Toggle autonomous mode
/undo       Undo last file edit (/undo [path])
/usage      Show token usage for this session
/clear      Clear conversation
/compact    Force context compaction
/metrics    Show session metrics (token counts, latency, costs)
/risk       Show risk assessment history
/config     Show configuration
/quit       Exit
```

## Tools

CodeBot has 28 built-in tools:

| Tool | Description | Permission |
|------|-------------|-----------|
| `read_file` | Read files with line numbers | auto |
| `write_file` | Create or overwrite files (with undo snapshots) | prompt |
| `edit_file` | Find-and-replace edits with diff preview + undo | prompt |
| `batch_edit` | Multi-file atomic find-and-replace | prompt |
| `execute` | Run shell commands | always-ask |
| `glob` | Find files by pattern | auto |
| `grep` | Search file contents with regex | auto |
| `think` | Internal reasoning scratchpad | auto |
| `memory` | Persistent memory across sessions | auto |
| `web_fetch` | HTTP requests and API calls | prompt |
| `web_search` | Internet search with result summaries | prompt |
| `browser` | Chrome automation via CDP | prompt |
| `routine` | Schedule recurring tasks with cron | prompt |
| `git` | Git operations (status, diff, log, commit, branch, etc.) | prompt |
| `code_analysis` | Symbol extraction, find references, imports, outline | auto |
| `multi_search` | Fuzzy search across filenames, content, and symbols | auto |
| `task_planner` | Hierarchical task tracking with priorities | auto |
| `diff_viewer` | File comparison and git diffs | auto |
| `docker` | Container management (ps, run, build, compose) | prompt |
| `database` | Query SQLite databases (blocks destructive SQL) | prompt |
| `test_runner` | Auto-detect and run tests (jest, vitest, pytest, go, cargo) | prompt |
| `http_client` | Advanced HTTP requests with auth and headers | prompt |
| `image_info` | Image dimensions and metadata (PNG, JPEG, GIF, SVG) | auto |
| `ssh_remote` | Remote command execution and file transfer via SSH | always-ask |
| `notification` | Webhook notifications (Slack, Discord, generic) | prompt |
| `pdf_extract` | Extract text and metadata from PDF files | auto |
| `package_manager` | Dependency management (npm, yarn, pip, cargo, go) | prompt |
| `code_review` | Security scanning and complexity analysis | auto |

### Permission Levels

- **auto** — Runs without asking
- **prompt** — Asks for approval (skipped in `--autonomous` mode)
- **always-ask** — Always asks, even in autonomous mode

### Browser Automation

Controls Chrome via the Chrome DevTools Protocol. Actions:

- `navigate` — Go to a URL
- `content` — Read page text
- `screenshot` — Capture the page
- `click` — Click an element by CSS selector
- `find_by_text` — Find and interact with elements by visible text
- `type` — Type into an input field
- `scroll`, `press_key`, `hover` — Page interaction
- `evaluate` — Run JavaScript on the page
- `tabs` — List open tabs
- `close` — Close browser connection

Chrome is auto-launched with `--remote-debugging-port` if not already running.

### Routines & Scheduling

Schedule recurring tasks with cron expressions:

```
> Set up a routine to check my server health every hour
> Create a daily routine at 9am to summarize my GitHub notifications
```

CodeBot creates the cron schedule, and the built-in scheduler runs tasks automatically while the agent is active. Manage with `/routines`.

### Memory

Persistent memory that survives across sessions:

- **Global memory** (`~/.codebot/memory/`) — preferences, patterns
- **Project memory** (`.codebot/memory/`) — project-specific context
- Automatically injected into the system prompt
- The agent reads/writes its own memory to learn your style

### Plugins

Extend CodeBot with custom tools. Drop `.js` files in `.codebot/plugins/` (project) or `~/.codebot/plugins/` (global):

```javascript
// .codebot/plugins/my-tool.js
module.exports = {
  name: 'my_tool',
  description: 'Does something useful',
  permission: 'prompt',
  parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
  execute: async (args) => { return `Result: ${args.input}`; }
};
```

### MCP Servers

Connect external tool servers via [Model Context Protocol](https://modelcontextprotocol.io). Create `.codebot/mcp.json`:

```json
{
  "servers": [
    {
      "name": "my-server",
      "command": "npx",
      "args": ["-y", "@my/mcp-server"],
      "env": {}
    }
  ]
}
```

MCP tools appear automatically with the `mcp_<server>_<tool>` prefix.

## Security

CodeBot v2.1.6 is built with security as a core architectural principle:

- **Policy engine with RBAC** — declarative JSON policies control tool access, filesystem scope, execution limits, and role-based access control for multi-user environments
- **Encryption at rest** — AES-256-GCM encryption for sensitive data stored on disk, including session history and audit logs
- **Risk scoring** — every tool call receives a 0-100 risk score based on 6 weighted factors
- **Secret detection** — scans for AWS keys, GitHub tokens, JWTs, private keys before writing
- **Sandbox execution** — Docker-based sandboxing with network, CPU, and memory limits
- **Hash-chained audit trail** — JSONL log with `--verify-audit` integrity check; each entry is chained to the previous via SHA-256
- **SARIF export** — `--export-audit sarif` for GitHub Code Scanning integration
- **SSRF protection** — blocks localhost, private IPs, cloud metadata endpoints
- **Path safety** — blocks writes to system directories, detects path traversal
- **Session integrity** — HMAC-based session integrity verification to detect tampering
- **Browser kill safety** — graceful browser process shutdown to prevent orphaned Chrome instances

See [SECURITY.md](SECURITY.md), [docs/HARDENING.md](docs/HARDENING.md), and [docs/SOC2_COMPLIANCE.md](docs/SOC2_COMPLIANCE.md) for the full security model and compliance readiness.

### Security at a Glance

```
  6-factor risk scoring on every tool call (0-100)
  AES-256-GCM encryption at rest
  SHA-256 hash-chained audit trail
  Docker sandbox with network/CPU/memory limits
  RBAC policy engine with per-tool permissions
  SARIF export for GitHub Code Scanning
  SSRF protection + path traversal blocking
  Secret detection (15+ patterns)
```

## Stability

CodeBot is hardened for continuous operation:

- **Automatic retry** — network errors, rate limits (429), and server errors (5xx) retry with exponential backoff
- **Stream recovery** — if the LLM connection drops mid-response, the agent loop retries on the next iteration
- **Context compaction** — when the conversation exceeds the model's context window, messages are intelligently summarized
- **Process resilience** — unhandled exceptions and rejections are caught, logged, and the REPL keeps running
- **Routine timeouts** — scheduled tasks are capped at 5 minutes to prevent the scheduler from hanging
- **880+ tests** — comprehensive suite covering core agent, security, extension, and action

## Programmatic API

CodeBot can be used as a library:

```typescript
import { Agent, OpenAIProvider, AnthropicProvider } from 'codebot-ai';

const provider = new AnthropicProvider({
  baseUrl: 'https://api.anthropic.com',
  apiKey: process.env.ANTHROPIC_API_KEY,
  model: 'claude-sonnet-4-6',
});

const agent = new Agent({
  provider,
  model: 'claude-sonnet-4-6',
  autoApprove: true,
  projectRoot: '/path/to/project', // optional, defaults to cwd
});

for await (const event of agent.run('list all TypeScript files')) {
  if (event.type === 'text') process.stdout.write(event.text || '');
}
```

## Architecture

```
src/
  agent.ts              Agent loop — streaming, tool execution, error recovery
  cli.ts                CLI interface, REPL, slash commands
  types.ts              TypeScript interfaces
  parser.ts             XML/JSON tool call parser (for models without native tool support)
  history.ts            Session persistence (JSONL)
  memory.ts             Persistent memory system
  setup.ts              Interactive setup wizard (model-first UX)
  scheduler.ts          Cron-based routine scheduler
  retry.ts              Exponential backoff with jitter
  audit.ts              Hash-chained audit trail (SHA-256 chaining)
  policy.ts             Policy engine with RBAC
  encryption.ts         AES-256-GCM encryption at rest
  risk.ts               Risk scoring engine
  metrics.ts            Structured metrics collection
  sarif.ts              SARIF export for code scanning integration
  integrity.ts          HMAC-based session integrity
  replay.ts             Session replay
  capabilities.ts       Per-tool capability restrictions
  banner.ts             Mascot and banner animation system
  context/
    manager.ts          Context window management, LLM-powered compaction
    repo-map.ts         Project structure scanner
  providers/
    openai.ts           OpenAI-compatible provider (covers most cloud APIs)
    anthropic.ts        Native Anthropic Messages API provider
    registry.ts         Model registry, provider detection
  browser/
    cdp.ts              Chrome DevTools Protocol client (zero-dep WebSocket)
  plugins.ts            Plugin loader (.codebot/plugins/)
  mcp.ts                MCP (Model Context Protocol) client
  tools/
    read.ts, write.ts, edit.ts, execute.ts
    batch-edit.ts       Multi-file atomic editing
    glob.ts, grep.ts, think.ts
    memory.ts, web-fetch.ts, web-search.ts
    browser.ts, routine.ts
```

See our [Roadmap](ROADMAP.md) for what's next.

## Configuration

Config is loaded in this order (later values win):

1. `~/.codebot/config.json` (saved by setup wizard)
2. Environment variables (`CODEBOT_MODEL`, `CODEBOT_PROVIDER`, etc.)
3. CLI flags (`--model`, `--provider`, etc.)

## From Source

```bash
git clone https://github.com/zanderone1980/codebot-ai.git
cd codebot-ai
npm install && npm run build
./bin/codebot
```

## Troubleshooting

**Chrome not launching**
Install Chrome or set the `CHROME_PATH` environment variable to point to your Chrome/Chromium binary.

**Context overflow**
Use the `/compact` interactive command to force context compaction, or reduce `--max-iterations` to limit how long the agent runs before stopping.

**Rate limit hit**
CodeBot automatically retries with exponential backoff on 429 responses. If you're hitting limits frequently, switch to a local model via Ollama to avoid rate limits entirely.

**ENOENT: no such file**
Check that `projectRoot` or your current working directory is correct. CodeBot resolves all file paths relative to the project root.

**Connection refused (Ollama)**
Make sure the Ollama server is running. Start it with `ollama serve` before launching CodeBot.

## License

MIT - [Ascendral Software Development & Innovation](https://github.com/AscendralSoftware)
