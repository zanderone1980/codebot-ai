# Deployment Guide

## Local Installation

### npm (recommended)
```bash
npm install -g codebot-ai
codebot --setup
```

### npx (no install)
```bash
npx codebot-ai "explain this codebase"
```

### From source
```bash
git clone https://github.com/zanderone1980/codebot-ai.git
cd codebot-ai
npm install && npm run build
node dist/cli.js --setup
```

## VS Code Extension

1. Install from the VS Code Marketplace: search for "CodeBot AI"
2. Or install from VSIX: `code --install-extension codebot-ai-vscode-2.0.0.vsix`
3. Configure your provider and API key in VS Code Settings > CodeBot

## GitHub Action

Add to your workflow:

```yaml
name: CodeBot Review
on: [pull_request]

jobs:
  review:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: zanderone1980/codebot-ai/actions/codebot@v2
        with:
          task: review
          api-key: ${{ secrets.ANTHROPIC_API_KEY }}
```

### Action Tasks

| Task | Description |
|------|-------------|
| `review` | Analyze PR diff and post review comments |
| `fix` | Attempt to fix failing CI tests |
| `scan` | Security scan with SARIF output for Code Scanning |

## Docker

### Using Docker for sandboxed execution
CodeBot automatically detects Docker and runs shell commands in disposable containers:

```bash
# Check sandbox status
codebot --sandbox-info

# Force Docker sandbox
codebot --sandbox docker
```

### Running CodeBot itself in Docker
```bash
docker run -v $(pwd):/workspace -w /workspace \
  -e ANTHROPIC_API_KEY=$ANTHROPIC_API_KEY \
  node:20-slim npx codebot-ai "fix the tests"
```

## Configuration

### Environment Variables
| Variable | Description |
|----------|-------------|
| `CODEBOT_MODEL` | Default model name |
| `CODEBOT_PROVIDER` | Default provider |
| `CODEBOT_BASE_URL` | LLM API base URL |
| `CODEBOT_API_KEY` | API key (fallback) |
| `ANTHROPIC_API_KEY` | Anthropic API key |
| `OPENAI_API_KEY` | OpenAI API key |
| `GEMINI_API_KEY` | Google Gemini API key |
| `DEEPSEEK_API_KEY` | DeepSeek API key |
| `GROQ_API_KEY` | Groq API key |
| `MISTRAL_API_KEY` | Mistral API key |
| `XAI_API_KEY` | xAI API key |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | OpenTelemetry collector URL (optional) |

### Config File
Saved at `~/.codebot/config.json` after `codebot --setup`.

### Policy File
Project-level: `.codebot/policy.json` (see [Policy Guide](POLICY_GUIDE.md))
