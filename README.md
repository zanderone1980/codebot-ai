<div align="center">

# CodeBot AI

### The safe, local-first autonomous coding agent

**Run AI-assisted development entirely on your machine. No API keys required. Policy-governed, audit-trailed, sandboxed — built for teams that take code security seriously.**

[![npm version](https://img.shields.io/npm/v/codebot-ai.svg?style=flat-square&color=6366f1)](https://www.npmjs.com/package/codebot-ai)
[![CI](https://github.com/Ascendral/codebot-ai/actions/workflows/ci.yml/badge.svg)](https://github.com/Ascendral/codebot-ai/actions/workflows/ci.yml)
[![license](https://img.shields.io/npm/l/codebot-ai.svg?style=flat-square)](https://github.com/Ascendral/codebot-ai/blob/main/LICENSE)
![tests](https://img.shields.io/badge/tests-1217%20passing-22c55e?style=flat-square)
![tools](https://img.shields.io/badge/tools-31-6366f1?style=flat-square)
![swarm](https://img.shields.io/badge/swarm-multi--LLM-f59e0b?style=flat-square)
![node](https://img.shields.io/node/v/codebot-ai.svg?style=flat-square)
[![downloads](https://img.shields.io/npm/dw/codebot-ai.svg?style=flat-square)](https://www.npmjs.com/package/codebot-ai)

</div>

---

## Why This Exists

Most AI coding tools require sending your code to third-party servers. That's a non-starter for security-sensitive teams, regulated industries, and developers who want to keep their code local.

CodeBot AI runs entirely on your machine with local LLMs (Ollama, LM Studio, vLLM) — or connects to any cloud provider when you choose. Every action is policy-governed, risk-scored, and audit-trailed.

### Who This Is For

- **Security-sensitive teams** — code never leaves your machine unless you opt in
- **Regulated industries** — finance, healthcare, government teams with compliance requirements
- **Solo developers** — autonomous coding without subscription fees
- **Internal platform teams** — extensible agent runtime with plugins, MCP, and API

---

## Quick Start

```bash
# Install
npm install -g codebot-ai

# Auto-detects Ollama, LM Studio, or cloud providers
codebot --setup

# Start coding
codebot "explain what this project does"

# Launch the web dashboard
codebot --dashboard
```

Local LLM with zero API keys:
```bash
ollama pull qwen2.5-coder && codebot --provider ollama --model qwen2.5-coder
```

---

## Why CodeBot vs. Alternatives?

| | CodeBot AI | GitHub Copilot | Cursor | Claude Code |
|---|:---:|:---:|:---:|:---:|
| **Self-hosted** | Yes | No | No | No |
| **Any LLM** | 8 providers | GPT only | Mixed | Claude only |
| **Policy engine** | Yes | No | No | No |
| **Audit trail** | Yes | No | No | No |
| **Sandboxed execution** | Yes | No | No | No |
| **Free / MIT** | Yes | $10-39/mo | $20/mo | $20/mo |

[Full comparison →](docs/COMPARISON.md)

---

## Built for Safety

Every tool call is risk-scored before execution. Every action is logged to a tamper-evident audit trail.

| Layer | What It Does |
|-------|-------------|
| **Policy Engine** | Declarative JSON rules defining what the agent can and cannot do |
| **Risk Scoring** | 6-factor scoring on every tool call (0-100) with configurable thresholds |
| **Audit Trail** | SHA-256 hash-chained, tamper-evident logs with SARIF export |
| **Sandbox** | Docker-based execution with network/CPU/memory limits |
| **Permission Model** | Interactive approval for risky operations, auto-approve for safe ones |
| **Secret Detection** | 15+ patterns (AWS keys, tokens, private keys) blocked before exposure |
| **SSRF Protection** | Blocks localhost, private IPs, cloud metadata endpoints |
| **Session Integrity** | HMAC-based tamper detection on session state |

See [SECURITY.md](SECURITY.md) for the full threat model.

---

## What It Does

| Capability | How |
|-----------|-----|
| **Write & edit code** | Reads your codebase, makes targeted edits, runs tests |
| **Run commands** | Shell execution with security filtering and sandbox support |
| **Browse the web** | Controls Chrome via DevTools Protocol — navigate, click, type, screenshot |
| **Search the internet** | Real-time web search for docs, APIs, current info |
| **Deep research** | Multi-source research with synthesis across web, docs, and code |
| **Web dashboard** | Sessions, audit trail, metrics, and Command Center at localhost:3120 |
| **Schedule routines** | Cron-based recurring tasks — monitoring, reports, automation |
| **Persistent memory** | Remembers preferences and context across sessions |
| **Multi-LLM Swarm** | Multiple AI models collaborate using debate, pipeline, fan-out, and more |
| **App integrations** | GitHub, Jira, Slack, Gmail, Notion, and more via encrypted connector vault |

---

## 8 LLM Providers

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

All cloud providers route through OpenAI-compatible APIs. Local providers connect directly via Ollama/LM Studio/vLLM.

```bash
export ANTHROPIC_API_KEY="sk-ant-..."    # or any provider
codebot --model claude-sonnet-4-6
```

---

## 31 Built-in Tools

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

**Permission levels:** `auto` = runs silently, `prompt` = asks first (skipped in `--autonomous`), `always-ask` = always confirms.

---

## 10 App Connectors

Connect to external services with OAuth or API keys. Credentials stored in encrypted vault (AES-256-GCM).

| Connector | Capabilities |
|-----------|-------------|
| **GitHub** | Issues, PRs, repos, code search |
| **Jira** | Issues, projects, sprints, transitions |
| **Linear** | Issues, projects, teams, cycles |
| **Slack** | Messages, channels, users, threads |
| **Gmail** | Read, send, search, label management |
| **Google Calendar** | Events, scheduling, availability |
| **Notion** | Pages, databases, search, content blocks |
| **Google Drive** | Files, folders, search, sharing |
| **OpenAI Images** | DALL-E generation, editing, variations |
| **Replicate** | Run any ML model via API |

---

## Multi-LLM Swarm

Launch a swarm of AI agents that collaborate on complex tasks. Mix cloud and local models freely.

```bash
codebot --dashboard   # open http://localhost:3120, click "Launch Swarm"
```

**6 Strategies:**
- **Auto** — Router analyzes your task and picks the best strategy
- **Debate** — Multiple agents propose solutions and vote on the best
- **Mixture of Agents** — Diverse proposals merged by a synthesizer
- **Pipeline** — Sequential stages: plan → research → code → review → test
- **Fan-Out** — Parallel subtasks gathered and synthesized
- **Generator-Critic** — One agent generates, another critiques, iterate to quality

---

## Web Dashboard

Launch with `codebot --dashboard` — opens at `http://localhost:3120`.

**Sessions** — Browse and inspect every conversation with message counts and timestamps.

**Audit Trail** — Cryptographic hash-chained log of every tool execution. One-click chain verification.

**Metrics** — Session counts, audit events, tool usage breakdown, and activity charts.

**Command Center** — Interactive terminal, quick actions, AI chat, and tool runner.

**Security** — Live constitutional AI decision feed, block rate metrics, risk dimension breakdown.

---

## Ecosystem

### VS Code Extension

```bash
code --install-extension codebot-ai-vscode-2.7.7.vsix
```

Sidebar chat panel, inline diff preview, status bar (tokens, cost, risk level), theme integration.

### GitHub Action

```yaml
- uses: Ascendral/codebot-ai/actions/codebot@v2
  with:
    task: review    # or: fix, scan
    api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

### Programmatic API

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

### Plugins & MCP

**Custom tools:** Drop `.js` files in `.codebot/plugins/`:

```javascript
module.exports = {
  name: 'my_tool',
  description: 'Does something useful',
  permission: 'prompt',
  parameters: { type: 'object', properties: { input: { type: 'string' } }, required: ['input'] },
  execute: async (args) => \`Result: \${args.input}\`,
};
```

**MCP servers:** Create `.codebot/mcp.json`:

```json
{
  "servers": [{ "name": "my-server", "command": "npx", "args": ["-y", "@my/mcp-server"] }]
}
```

---

## CLI Reference

```bash
codebot                                        # Interactive REPL
codebot "fix the bug in app.ts"                # Single task
codebot --autonomous "refactor auth and test"  # Full auto
codebot --continue                             # Resume last session
codebot --dashboard                            # Web dashboard
codebot --tui                                  # Terminal UI (panels)
codebot --doctor                               # Environment health check
echo "explain this error" | codebot            # Pipe mode
```

<details>
<summary><strong>All CLI flags</strong></summary>

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
--tui                Full terminal UI mode
--dashboard          Web dashboard on localhost:3120
--doctor             Environment health checks
--theme <name>       Color theme: dark, light, mono
--no-animate         Disable animations
--no-stream          Disable streaming display
--verbose            Debug output
```

</details>

<details>
<summary><strong>Interactive commands</strong></summary>

```
/help       Show commands           /model     Show or change model
/models     List supported models   /sessions  List saved sessions
/routines   List routines           /auto      Toggle autonomous mode
/undo       Undo last edit          /usage     Token usage
/clear      Clear conversation      /compact   Force context compaction
/metrics    Session metrics         /risk      Risk assessment history
/config     Show configuration      /doctor    Health checks
/toolcost   Per-tool cost breakdown /rate      Rate limit status
/theme      Switch color theme      /quit      Exit
```

</details>

---

## Testing & Reliability

| Metric | Value |
|--------|-------|
| **Tests** | 1,217 passing across 232 suites |
| **CI Matrix** | 3 OS (macOS, Linux, Windows) × 3 Node versions (18, 20, 22) |
| **Test types** | Unit, integration, security (SSRF, path traversal, secret detection) |
| **Deterministic** | No network calls in test suite, all providers mocked |
| **Run** | `npm test` |

**Stability features:**
- Auto-retry with exponential backoff on network errors and rate limits
- Stream recovery — reconnects if the LLM drops mid-response
- Context compaction — smart summarization when hitting context limits
- Process resilience — catches unhandled exceptions, keeps the REPL running

---

## Build from Source

```bash
git clone https://github.com/Ascendral/codebot-ai.git
cd codebot-ai
npm install && npm run build
./bin/codebot
```

---

<div align="center">

**[npm](https://www.npmjs.com/package/codebot-ai)** · **[GitHub](https://github.com/Ascendral/codebot-ai)** · **[Changelog](CHANGELOG.md)** · **[Docs](docs/)** · **[Security](SECURITY.md)**

MIT — [Ascendral](https://github.com/Ascendral)

</div>
