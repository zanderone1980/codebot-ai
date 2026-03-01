# CodeBot AI Examples

Runnable examples demonstrating CodeBot as a library.

## Prerequisites

```bash
npm install codebot-ai
export ANTHROPIC_API_KEY="sk-ant-..."   # or OPENAI_API_KEY
```

## Examples

| # | File | Description |
|---|------|-------------|
| 01 | [basic-chat.ts](01-basic-chat.ts) | Simplest usage — send a message, stream the response |
| 02 | [code-review.ts](02-code-review.ts) | Review a file for bugs, security issues, and quality |
| 03 | [security-scan.ts](03-security-scan.ts) | Scan a codebase and export SARIF report |
| 04 | [multi-model.ts](04-multi-model.ts) | Compare responses across Claude, GPT, and local models |
| 05 | [event-stream.ts](05-event-stream.ts) | Process every event type from the agent generator |
| 06 | [policy-enforcement.ts](06-policy-enforcement.ts) | Policy engine blocks unauthorized tool access |

## Running

```bash
# With tsx (recommended)
npx tsx examples/01-basic-chat.ts

# Or compile first
npx tsc examples/01-basic-chat.ts --outDir /tmp/examples --esModuleInterop
node /tmp/examples/01-basic-chat.js
```

## Key Concepts

### Agent as AsyncGenerator

The core API is `agent.run(prompt)`, which returns an `AsyncGenerator<AgentEvent>`. Each event has a `type` field:

- `text` — Streamed text from the LLM
- `thinking` — Extended thinking (Claude models)
- `tool_call` — Agent is calling a tool (includes risk score)
- `tool_result` — Tool execution result
- `usage` — Token counts and cost
- `error` — Error occurred
- `done` — Agent finished

### Provider Flexibility

Swap providers with one line:

```typescript
// Cloud
const provider = new AnthropicProvider({ apiKey: '...' });
const provider = new OpenAIProvider({ apiKey: '...' });

// Local (Ollama)
const provider = new OpenAIProvider({ baseUrl: 'http://localhost:11434/v1' });

// Auto-detect from environment
const provider = detectProvider();
```

### Project Root

When embedding CodeBot, always set `projectRoot`:

```typescript
const agent = new Agent({
  provider,
  model: 'claude-sonnet-4-20250514',
  projectRoot: '/path/to/project',  // File operations scoped here
});
```
