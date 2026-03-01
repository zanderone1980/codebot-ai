# Architecture

## System Overview

CodeBot AI is a zero-dependency autonomous AI agent that works with any LLM provider. The architecture is designed around streaming, fail-safe operations, and defense-in-depth security.

```
┌─────────────────────────────────────────────────────────┐
│  Entry Points                                           │
│  ├── CLI (src/cli.ts)                                   │
│  ├── VS Code Extension (extensions/vscode/)             │
│  └── GitHub Action (actions/codebot/)                   │
│           │                                             │
│           ▼                                             │
│  ┌─────────────────────────────────────────────┐        │
│  │  Agent Core (src/agent.ts)                  │        │
│  │  ├── Message history management             │        │
│  │  ├── LLM streaming loop                     │        │
│  │  ├── Tool call parsing & validation         │        │
│  │  ├── Permission checking                    │        │
│  │  ├── Parallel tool execution                │        │
│  │  └── Context compaction                     │        │
│  └────┬────────────────────┬───────────────────┘        │
│       │                    │                            │
│       ▼                    ▼                            │
│  ┌──────────┐    ┌─────────────────┐                    │
│  │ Providers │    │ Tool Registry   │                    │
│  │ OpenAI    │    │ 28 built-in     │                    │
│  │ Anthropic │    │ + MCP servers   │                    │
│  │ (any)     │    │ + plugins       │                    │
│  └──────────┘    └────┬────────────┘                    │
│                       │                                 │
│              ┌────────┼────────┐                        │
│              ▼        ▼        ▼                        │
│        ┌──────┐ ┌────────┐ ┌─────────┐                  │
│        │Policy│ │Security│ │  Audit  │                  │
│        │Engine│ │Checks  │ │ Logger  │                  │
│        └──────┘ └────────┘ └─────────┘                  │
│                                                         │
│  ┌──────────────────────────────────────────────┐       │
│  │  Observability Layer                         │       │
│  │  ├── MetricsCollector (counters, histograms) │       │
│  │  ├── RiskScorer (6-factor assessment)        │       │
│  │  ├── TokenTracker (usage & cost)             │       │
│  │  └── SARIF Exporter (audit → CI)             │       │
│  └──────────────────────────────────────────────┘       │
└─────────────────────────────────────────────────────────┘
```

## Data Flow

1. **User input** enters via CLI, VS Code extension, or GitHub Action
2. **Agent** appends user message to history, checks context budget
3. **LLM Provider** streams response (text + tool calls)
4. **Tool calls** are validated (schema, policy, capabilities, permissions)
5. **Risk assessment** computed for each tool call (0-100 score)
6. **Parallel execution** runs independent tools concurrently
7. **Audit logger** records every action with hash chain
8. **Metrics** track latency, counts, cache hits, errors
9. **Results** fed back to LLM for next iteration
10. **Session summary** shows tokens, cost, risk, tool breakdown

## Key Components

### Agent (`src/agent.ts`)
The core orchestration loop. Manages the LLM conversation, dispatches tool calls, enforces policies, and handles errors. Exposes an `AsyncGenerator<AgentEvent>` interface for streaming.

### Providers (`src/providers/`)
Adapters for LLM APIs. OpenAI-compatible (covers Ollama, LM Studio, vLLM, GPT, Gemini, DeepSeek, Groq, Mistral, Grok) and native Anthropic. All implement the `LLMProvider` interface with streaming.

### Tool Registry (`src/tools/`)
28 built-in tools covering file operations, shell execution, git, web browsing, search, code analysis, testing, and more. Extensible via plugins and MCP servers.

### Policy Engine (`src/policy.ts`)
Declarative JSON policies controlling every aspect of agent behavior. Merge order: project > global > defaults.

### Audit System (`src/audit.ts`)
Append-only JSONL logs with SHA-256 hash chains. Supports verification, querying, and SARIF export.

## Extension Points

- **Plugins**: Drop `.js` files in `.codebot/plugins/` to add custom tools
- **MCP Servers**: Configure Model Context Protocol servers for external tool integration
- **Custom Providers**: Implement the `LLMProvider` interface for any LLM API
- **Policy Files**: Customize security policies per-project
