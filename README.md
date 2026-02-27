# CodeBot AI

Local-first AI coding assistant. Zero runtime dependencies. Works with Ollama, LM Studio, vLLM, Claude, GPT, Gemini, DeepSeek, Groq, Mistral, and Grok.

## Quick Start

```bash
# Install globally
npm install -g codebot-ai

# Run — setup wizard launches automatically on first use
codebot
```

Or run without installing:

```bash
npx codebot-ai
```

Or from source:

```bash
git clone https://github.com/AscendralSoftware/codebot-ai.git
cd codebot-ai
npm install && npm run build
./bin/codebot
```

## Setup

On first run, CodeBot detects your environment and walks you through configuration:

- Scans for local LLM servers (Ollama, LM Studio, vLLM)
- Detects API keys from environment variables
- Lets you pick a provider and model
- Saves config to `~/.codebot/config.json`

To reconfigure anytime: `codebot --setup`

### Environment Variables

Set an API key for your preferred cloud provider:

```bash
export ANTHROPIC_API_KEY="sk-ant-..."    # Claude
export OPENAI_API_KEY="sk-..."           # GPT
export GEMINI_API_KEY="..."              # Gemini
export DEEPSEEK_API_KEY="sk-..."         # DeepSeek
export GROQ_API_KEY="gsk_..."            # Groq
export MISTRAL_API_KEY="..."             # Mistral
export XAI_API_KEY="xai-..."             # Grok
```

For local models, just have Ollama/LM Studio/vLLM running — CodeBot auto-detects them.

## Usage

### Interactive Mode

```bash
codebot
```

### Single Message

```bash
codebot "fix the bug in app.ts"
codebot --model claude-sonnet-4-6 "explain this codebase"
```

### Pipe Mode

```bash
echo "write a function that sorts by date" | codebot
cat error.log | codebot "what's causing this?"
```

### Autonomous Mode

Skip all permission prompts — full auto:

```bash
codebot --autonomous "refactor the auth module and run tests"
```

### Session Resume

CodeBot auto-saves every conversation. Resume anytime:

```bash
codebot --continue              # Resume last session
codebot --resume <session-id>   # Resume specific session
```

## CLI Options

```
--setup              Run the setup wizard
--model <name>       Model to use (default: qwen2.5-coder:32b)
--provider <name>    Provider: openai, anthropic, gemini, deepseek, groq, mistral, xai
--base-url <url>     LLM API base URL
--api-key <key>      API key (or use env vars)
--autonomous         Skip all permission prompts
--resume <id>        Resume a session by ID
--continue, -c       Resume the most recent session
--max-iterations <n> Max agent loop iterations (default: 50)
```

## Interactive Commands

```
/help      Show commands
/model     Show or change model
/models    List all supported models
/sessions  List saved sessions
/auto      Toggle autonomous mode
/clear     Clear conversation
/compact   Force context compaction
/config    Show configuration
/quit      Exit
```

## Tools

CodeBot has 10 built-in tools:

| Tool | Description | Permission |
|------|-------------|-----------|
| `read_file` | Read files with line numbers | auto |
| `write_file` | Create or overwrite files | prompt |
| `edit_file` | Find-and-replace edits | prompt |
| `execute` | Run shell commands | always-ask |
| `glob` | Find files by pattern | auto |
| `grep` | Search file contents with regex | auto |
| `think` | Internal reasoning scratchpad | auto |
| `memory` | Persistent memory across sessions | auto |
| `web_fetch` | HTTP requests and API calls | prompt |
| `browser` | Chrome automation via CDP | prompt |

### Permission Levels

- **auto** — Runs without asking
- **prompt** — Asks for approval (skipped in `--autonomous` mode)
- **always-ask** — Always asks, even in autonomous mode

### Browser Tool

Controls Chrome via the Chrome DevTools Protocol. Actions:

- `navigate` — Go to a URL
- `content` — Read page text
- `screenshot` — Capture the page
- `click` — Click an element by CSS selector
- `type` — Type into an input field
- `evaluate` — Run JavaScript on the page
- `tabs` — List open tabs
- `close` — Close browser connection

Chrome is auto-launched with `--remote-debugging-port` if not already running.

### Memory

CodeBot has persistent memory that survives across sessions:

- **Global memory** (`~/.codebot/memory/`) — preferences, patterns
- **Project memory** (`.codebot/memory/`) — project-specific context
- Memory is automatically injected into the system prompt
- The agent can read/write its own memory using the `memory` tool

## Supported Models

### Local (Ollama / LM Studio / vLLM)

qwen2.5-coder (3b/7b/14b/32b), qwen3, deepseek-coder, codellama, llama3.x, mistral, mixtral, phi-3/4, starcoder2, granite-code, gemma2, command-r

### Cloud

- **Anthropic**: claude-opus-4-6, claude-sonnet-4-6, claude-haiku-4-5
- **OpenAI**: gpt-4o, gpt-4.1, o1, o3, o4-mini
- **Google**: gemini-2.5-pro, gemini-2.5-flash, gemini-2.0-flash
- **DeepSeek**: deepseek-chat, deepseek-reasoner
- **Groq**: llama-3.3-70b, mixtral-8x7b (fast inference)
- **Mistral**: mistral-large, codestral
- **xAI**: grok-3, grok-3-mini

## Architecture

```
src/
  agent.ts              Agent loop with streaming, tool execution, permissions
  cli.ts                CLI interface, REPL, slash commands
  types.ts              TypeScript interfaces
  parser.ts             XML/JSON tool call parser (for models without native tool support)
  history.ts            Session persistence (JSONL)
  memory.ts             Persistent memory system
  setup.ts              Interactive setup wizard
  context/
    manager.ts          Context window management, LLM-powered compaction
    repo-map.ts         Project structure scanner
  providers/
    openai.ts           OpenAI-compatible provider (covers most cloud APIs)
    anthropic.ts        Native Anthropic Messages API provider
    registry.ts         Model registry, provider detection
  browser/
    cdp.ts              Chrome DevTools Protocol client (zero-dep WebSocket)
  tools/
    read.ts, write.ts, edit.ts, execute.ts
    glob.ts, grep.ts, think.ts
    memory.ts, web-fetch.ts, browser.ts
```

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
});

for await (const event of agent.run('list all TypeScript files')) {
  if (event.type === 'text') process.stdout.write(event.text || '');
}
```

## Configuration

Config is loaded in this order (later values win):

1. `~/.codebot/config.json` (saved by setup wizard)
2. Environment variables (`CODEBOT_MODEL`, `CODEBOT_PROVIDER`, etc.)
3. CLI flags (`--model`, `--provider`, etc.)

## License

MIT - Ascendral Software Development & Innovation
