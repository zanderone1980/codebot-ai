<div align="center">

# CodeBot AI

**Autonomous code execution with built-in governance.**

The only AI coding agent that runs locally, works with any LLM, and enforces safety policies on every action it takes.

[![npm version](https://img.shields.io/npm/v/codebot-ai.svg?style=flat-square&color=6366f1)](https://www.npmjs.com/package/codebot-ai)
[![npm downloads](https://img.shields.io/npm/dw/codebot-ai.svg?style=flat-square&color=6366f1)](https://www.npmjs.com/package/codebot-ai)
[![license](https://img.shields.io/npm/l/codebot-ai.svg?style=flat-square)](https://github.com/Ascendral/codebot-ai/blob/main/LICENSE)
![tests](https://img.shields.io/badge/tests-1413%20passing-22c55e?style=flat-square)
![node](https://img.shields.io/node/v/codebot-ai.svg?style=flat-square)
[![GitHub stars](https://img.shields.io/github/stars/Ascendral/codebot-ai?style=flat-square)](https://github.com/Ascendral/codebot-ai)
[![last commit](https://img.shields.io/github/last-commit/Ascendral/codebot-ai?style=flat-square)](https://github.com/Ascendral/codebot-ai)

</div>

## The Problem

AI coding agents can write code, run commands, browse the web, and modify your filesystem. Most of them do this with zero oversight — no audit trail, no policy enforcement, no way to prove what happened or why.

That's fine for side projects. It's a dealbreaker for teams shipping production software, companies in regulated industries, and anyone who needs to answer the question: *what did the AI actually do?*

## What CodeBot Does Differently

**Governance-first architecture.** Every tool call passes through a constitutional safety engine ([CORD](https://github.com/Ascendral/artificial-persistent-intelligence)) that risk-scores actions across 14 dimensions before execution. Every action is logged to a SHA-256 hash-chained audit trail with SARIF export. Destructive operations require explicit approval. The agent can't bypass its own safety layer.

**Any LLM, anywhere.** Run fully local with Ollama, LM Studio, or vLLM — zero API keys, code never leaves your machine. Or connect to Anthropic, OpenAI, Google, DeepSeek, Groq, Mistral, or xAI. Switch models mid-session.

**Zero external dependencies.** The entire agent runtime — HTTP server, policy engine, audit system, tool execution, provider abstraction — is built on Node.js built-ins. No Express, no Axios, no ORM. The dependency tree is the codebase.

```bash
npm install -g codebot-ai
codebot --setup                    # auto-detects local and cloud LLMs
codebot "refactor auth to use JWT" # single task
codebot --dashboard                # web UI at localhost:3120
```

## Who This Is For

- **Security-sensitive development teams** — code never leaves your machine with local LLMs
- **Regulated industries** (finance, healthcare, government) — audit trail meets compliance requirements
- **Teams that can't send code to third-party APIs** — fully self-hosted, no cloud dependency
- **Solo developers** who want autonomous coding without subscription fees
- **Internal platform teams** building custom dev tooling on top of an extensible agent

## Architecture

```
User ──> Agent Loop ──> Tool Router ──> CORD Safety Engine ──> Execution
              │              │                │                    │
              │              │           14-dimension          32 tools
              │              │           risk scoring          (code, shell,
              │              │           + policy gates         browser, git,
              │              │           + audit trail          network, DB...)
              │              │                │
              │         Permission Model      │
              │         (auto/prompt/         Audit Logger
              │          always-ask)     (hash-chained, SARIF)
              │
         8 LLM Providers
         (local + cloud)
```

| Layer | Implementation |
|-------|---------------|
| **Constitutional Safety (CORD)** | 14 risk dimensions, 5-phase evaluation pipeline, hard-block rules for injection/drift/impersonation |
| **Audit Trail** | SHA-256 hash-chained logs, tamper-evident, SARIF export for CI integration |
| **Policy Engine** | Declarative JSON rules — scope file paths, block network targets, restrict commands |
| **Sandbox** | Docker-based execution with network/CPU/memory limits |
| **Secret Detection** | 15+ patterns (AWS keys, tokens, private keys) blocked before exposure |
| **SSRF Protection** | Blocks localhost, private IPs, cloud metadata endpoints |

## Capabilities

**32 built-in tools** covering code editing, shell execution, Chrome automation (CDP), web search, deep research, Git operations, Docker management, database queries, SSH, scheduled routines, and persistent memory.

**10 app connectors** — GitHub, Jira, Linear, Slack, Gmail, Google Calendar, Notion, Google Drive, OpenAI Images, Replicate. Credentials stored in AES-256-GCM encrypted vault.

**Web dashboard** at localhost:3120 — sessions, audit trail, metrics, security feed, command center.

<details>
<summary><strong>All 32 tools</strong></summary>

| Tool | Permission | Description |
|------|:----------:|-------------|
| `read_file` | auto | Read files with line numbers |
| `write_file` | prompt | Create or overwrite files (undo snapshots) |
| `edit_file` | prompt | Find-and-replace edits with diff preview |
| `batch_edit` | prompt | Multi-file atomic find-and-replace |
| `execute` | always-ask | Run shell commands (security-filtered) |
| `glob` | auto | Find files by pattern |
| `grep` | auto | Search file contents with regex |
| `git` | prompt | Git operations (status, diff, log, commit, branch) |
| `browser` | prompt | Chrome automation via CDP |
| `web_fetch` | prompt | HTTP requests and API calls |
| `web_search` | prompt | Internet search with summaries |
| `deep_research` | prompt | Multi-source research with synthesis |
| `think` | auto | Internal reasoning scratchpad |
| `memory` | auto | Persistent memory across sessions |
| `routine` | prompt | Schedule recurring tasks with cron |
| `code_analysis` | auto | Symbol extraction, imports, outline |
| `code_review` | auto | Security scanning and complexity analysis |
| `multi_search` | auto | Fuzzy search: filenames, content, symbols |
| `task_planner` | auto | Hierarchical task tracking |
| `diff_viewer` | auto | File comparison and git diffs |
| `test_runner` | prompt | Auto-detect and run tests (jest, vitest, pytest, go, cargo) |
| `docker` | prompt | Container management (ps, run, build, compose) |
| `database` | prompt | Query SQLite databases (blocks destructive SQL) |
| `http_client` | prompt | Advanced HTTP with auth and headers |
| `image_info` | auto | Image dimensions and metadata |
| `pdf_extract` | auto | Extract text and metadata from PDFs |
| `ssh_remote` | always-ask | Remote command execution via SSH |
| `notification` | prompt | Webhook notifications (Slack, Discord) |
| `package_manager` | prompt | Dependency management (npm, yarn, pip, cargo, go) |
| `app_connector` | prompt | 10 app integrations via encrypted vault |
| `graphics` | prompt | Image processing: resize, crop, watermark, convert |

`auto` = runs silently. `prompt` = asks first (skipped in `--autonomous`). `always-ask` = always confirms.

</details>

<details>
<summary><strong>8 LLM providers</strong></summary>

| Provider | Models |
|----------|--------|
| **Local (Ollama/LM Studio/vLLM)** | qwen2.5-coder, qwen3, deepseek-coder, llama3.x, mistral, phi-4, codellama, starcoder2 |
| **Anthropic** | claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5 |
| **OpenAI** | gpt-4o, gpt-4.1, o1, o3, o4-mini |
| **Google** | gemini-2.5-pro, gemini-2.5-flash, gemini-2.0-flash |
| **DeepSeek** | deepseek-chat, deepseek-reasoner |
| **Groq** | llama-3.3-70b, mixtral-8x7b |
| **Mistral** | mistral-large, codestral |
| **xAI** | grok-3, grok-3-mini |

Cloud providers route through OpenAI-compatible APIs. Local providers connect directly.

</details>

## Comparison

| | CodeBot AI | GitHub Copilot | Cursor | Claude Code |
|---|:---:|:---:|:---:|:---:|
| **Self-hosted / local LLM** | Yes | No | No | No |
| **Any LLM provider** | 8 providers | GPT only | Mixed | Claude only |
| **Constitutional safety engine** | Yes | No | No | No |
| **Cryptographic audit trail** | Yes | No | No | No |
| **Sandboxed execution** | Yes | No | No | No |
| **Free / MIT** | Yes | $10-39/mo | $20/mo | $20/mo |

## Extensibility

**Programmatic API:**
```typescript
import { Agent, AnthropicProvider } from 'codebot-ai';

const agent = new Agent({
  provider: new AnthropicProvider({
    apiKey: process.env.ANTHROPIC_API_KEY,
    model: 'claude-sonnet-4-6',
  }),
  model: 'claude-sonnet-4-6',
  autoApprove: true,
});

for await (const event of agent.run('list all TypeScript files')) {
  if (event.type === 'text') process.stdout.write(event.text || '');
}
```

**Custom tools** — drop `.js` files in `.codebot/plugins/`.
**MCP servers** — configure in `.codebot/mcp.json`.
**VS Code extension** — sidebar chat, inline diffs, status bar.
**GitHub Action** — `uses: Ascendral/codebot-ai/actions/codebot@v2`

## Testing

1,413 tests across 242 suites. CI runs on 3 OS (macOS, Linux, Windows) x 3 Node versions (18, 20, 22). Zero network calls in the test suite — all providers mocked. Security tests cover SSRF, path traversal, injection, and secret detection.

```bash
npm test
```

## Build from Source

```bash
git clone https://github.com/Ascendral/codebot-ai.git
cd codebot-ai
npm install && npm run build
./bin/codebot
```

---

<div align="center">

**[npm](https://www.npmjs.com/package/codebot-ai)** · **[GitHub](https://github.com/Ascendral/codebot-ai)** · **[Security](SECURITY.md)** · **[Changelog](CHANGELOG.md)** · **[Docs](docs/)**

MIT — [Ascendral](https://github.com/Ascendral)

</div>
