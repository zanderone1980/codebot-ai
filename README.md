<div align="center">

# CodeBot AI

**Autonomous AI coding agent with built-in governance. Any LLM. Runs locally. MIT licensed.**

[![npm version](https://img.shields.io/npm/v/codebot-ai.svg?style=flat-square&color=6366f1)](https://www.npmjs.com/package/codebot-ai)
[![license](https://img.shields.io/npm/l/codebot-ai.svg?style=flat-square)](https://github.com/Ascendral/codebot-ai/blob/main/LICENSE)
![tests](https://img.shields.io/badge/tests-1571%20passing-22c55e?style=flat-square)

<!-- TODO: Replace with screenshot or gif of dashboard -->

</div>

## Quick Start

```bash
npm install -g codebot-ai
codebot --setup                    # auto-detects local and cloud LLMs
codebot "refactor auth to use JWT" # run a task
codebot --dashboard                # web UI at localhost:3120
codebot --solve https://github.com/you/repo/issues/42  # autonomous fix -> PR
```

## Hero Workflow: --solve

Point CodeBot at a GitHub issue and walk away. It delivers a tested PR with a full audit trail.

```
codebot --solve https://github.com/you/repo/issues/42
```

**8-phase pipeline:**

1. **Parse issue** -- extract requirements from the GitHub issue
2. **Clone repo** -- shallow-clone the target repository
3. **Analyze** -- map the codebase and locate relevant files
4. **Install deps** -- detect package manager, install dependencies
5. **Fix** -- apply code changes guided by the issue description
6. **Test** -- run the project's test suite, iterate until green
7. **Self-review** -- audit the diff for regressions and style violations
8. **PR** -- open a pull request with a structured audit trail

## Key Features

- **Governance-first** — every tool call passes through a constitutional safety engine (CORD) that risk-scores actions using 7 weighted factors (6 heuristic + 1 constitutional) before execution
- **Any LLM, anywhere** — 8 providers: run fully local with Ollama/LM Studio/vLLM, or connect to Anthropic, OpenAI, Google, DeepSeek, Groq, Mistral, xAI
- **35 built-in tools** — code editing, shell, Chrome automation, Git, Docker, databases, web search, deep research, scheduled routines, and more
- **Cryptographic audit trail** — SHA-256 hash-chained logs with SARIF export for CI integration

## Comparison

| | CodeBot AI | Copilot | Cursor | Claude Code | Devin | SWE-agent |
|---|:---:|:---:|:---:|:---:|:---:|:---:|
| Self-hosted / local LLM | Yes | No | No | No | No | Yes |
| Any LLM provider | 8 | GPT | Mixed | Claude | Proprietary | Any |
| Safety engine + audit trail | Yes | No | No | No | No | No |
| Autonomous issue-to-PR | Yes | No | No | No | Yes | Yes |
| Free / MIT | Yes | $10-39/mo | $20/mo | $20/mo | $500/mo | Free |

## Demo

See the --solve pipeline in action: [Live Demo](https://ascendral.github.io/codebot-ai/demo.html)

## Architecture

```
User --> Agent Loop --> Tool Router --> CORD Safety Engine --> Execution
              |                              |                    |
         8 LLM Providers              7-factor risk         35 tools
         (local + cloud)              scoring + audit      (code, shell,
                                                            browser, git...)
```

## Extend

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

Custom tools via `.codebot/plugins/` · MCP servers via `.codebot/mcp.json` · [VS Code extension](extensions/vscode) · [GitHub Action](actions/codebot)

---

<div align="center">

**[Docs](docs/)** · **[Changelog](CHANGELOG.md)** · **[Security](SECURITY.md)** · **[Contributing](CONTRIBUTING.md)**

MIT — [Ascendral](https://github.com/Ascendral)

</div>
