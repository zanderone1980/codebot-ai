# Installation Guide

## Requirements

- **Node.js 18+** (check with `node --version`)
- **Git** (optional, for git-related features)
- **An LLM provider** — pick one:
  - **Local (free):** [Ollama](https://ollama.ai) with any model
  - **Cloud:** OpenAI, Anthropic, Google, Groq, Mistral, DeepSeek, or Grok API key

---

## Quick Install

```bash
npm install -g codebot-ai
```

Verify:

```bash
codebot --version
# → codebot v2.5.2
```

If `npm` isn't found (common on macOS with Homebrew):

```bash
# Find your node install
which node

# Use npm directly
node $(dirname $(which node))/../lib/node_modules/npm/bin/npm-cli.js install -g codebot-ai
```

---

## First-Time Setup

Just run `codebot` — setup happens automatically on first launch:

```bash
codebot
```

It auto-detects your environment:
- **Ollama running locally?** Picks the best model and starts immediately
- **API key in environment?** (`OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, etc.) Uses it automatically
- **Nothing found?** Shows a one-question menu to pick your provider

Autonomous mode is **enabled by default** — no permission prompts, just works.

To reconfigure later: `codebot --setup`

Your settings are saved to `~/.codebot/config.json` and persist across sessions.

---

## Provider Setup

### Ollama (Free, Local)

```bash
# Install Ollama
curl -fsSL https://ollama.ai/install.sh | sh

# Pull a model
ollama pull qwen2.5-coder

# Run CodeBot
codebot --provider ollama --model qwen2.5-coder
```

### OpenAI

```bash
export OPENAI_API_KEY=sk-...
codebot --provider openai --model gpt-4.1
```

### Anthropic (Claude)

```bash
export ANTHROPIC_API_KEY=sk-ant-...
codebot --provider anthropic --model claude-sonnet-4-20250514
```

### Google (Gemini)

```bash
export GOOGLE_API_KEY=AIza...
codebot --provider google --model gemini-2.5-pro
```

### Groq

```bash
export GROQ_API_KEY=gsk_...
codebot --provider groq --model llama-3.3-70b-versatile
```

### DeepSeek

```bash
export DEEPSEEK_API_KEY=sk-...
codebot --provider deepseek --model deepseek-chat
```

---

## Running CodeBot

### Interactive Mode

```bash
# Navigate to your project
cd my-project

# Start CodeBot
codebot
```

Type a task in natural language. CodeBot reads your codebase, writes code, runs tests, and iterates.

### Autonomous Mode (Recommended)

```bash
codebot --autonomous
```

Skips all permission prompts. CodeBot executes commands freely. Dangerous commands (`rm -rf /`, `curl | sh`, etc.) are still blocked by the security filter.

### One-Shot Mode

```bash
codebot --autonomous "add input validation to the signup form and run tests"
```

Executes the task and exits when done.

### Dashboard

```bash
codebot --dashboard
```

Opens a web dashboard at `http://localhost:3120` with:

- **Terminal** — run shell commands
- **Quick Actions** — one-click Git Status, Run Tests, Health Check, Git Log, Git Diff
- **Sessions** — view session history
- **Metrics** — usage stats

### Health Check

```bash
codebot --doctor
```

Runs diagnostics on your environment.

---

## CLI Flags

| Flag | Description |
|------|-------------|
| `--setup` | Run the setup wizard |
| `--autonomous` | Skip all permission prompts |
| `--provider <name>` | LLM provider (openai, anthropic, ollama, etc.) |
| `--model <name>` | Model name (gpt-4.1, claude-sonnet-4, etc.) |
| `--dashboard` | Open the web dashboard |
| `--doctor` | Run environment diagnostics |
| `--version` | Show version |
| `--help` | Show all options |

---

## Updating

```bash
npm install -g codebot-ai@latest
```

---

## Uninstalling

```bash
npm uninstall -g codebot-ai
rm -rf ~/.codebot    # remove saved config (optional)
```

---

## Troubleshooting

**`npm: command not found`** — Your Node.js install doesn't have npm in PATH. Use the direct path:
```bash
node $(dirname $(which node))/../lib/node_modules/npm/bin/npm-cli.js install -g codebot-ai
```

**`codebot` still shows old version** — The symlink points to an old install. Reinstall with the correct prefix:
```bash
npm install -g codebot-ai@latest --prefix $(npm config get prefix)
```

**Dashboard says "Port 3120 is already in use"** — Kill the existing process:
```bash
lsof -i :3120 | grep LISTEN | awk '{print $2}' | xargs kill
```

**Permission prompts on every command** — Run with `--autonomous` or run `codebot --setup` and enable autonomous mode.

**Docker sandbox errors** — CodeBot tries Docker if available. Disable with:
```bash
CODEBOT_NO_DOCKER=1 codebot
```
