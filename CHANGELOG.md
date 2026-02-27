# Changelog

## 1.0.0 (2025-02-27)

Initial release.

### Features

- **Agent Loop**: Streaming async generator with tool execution, permission system, and XML/JSON fallback parsing for models without native tool support
- **10 Tools**: read_file, write_file, edit_file, execute, glob, grep, think, memory, web_fetch, browser
- **8 LLM Providers**: Ollama, LM Studio, vLLM (local), Anthropic, OpenAI, Gemini, DeepSeek, Groq, Mistral, xAI (cloud)
- **40+ Models**: Full model registry with context windows, tool calling support flags, and auto-detection from model name
- **Native Anthropic Provider**: Direct Claude API with streaming, tool_use blocks, extended thinking support
- **OpenAI-Compatible Provider**: Works with all OpenAI-compatible APIs (covers most cloud and local providers)
- **Browser Automation**: Chrome control via CDP with zero-dep WebSocket client — navigate, click, type, screenshot, JS eval
- **Web Fetch**: HTTP requests for APIs and web pages
- **Persistent Memory**: Global and project-level memory that survives across sessions, auto-injected into system prompt
- **Session Persistence**: Auto-save conversations to JSONL, resume with --continue or --resume
- **LLM-Powered Context Compaction**: Summarizes dropped messages using the LLM instead of just discarding them
- **Interactive Setup Wizard**: Auto-detects environment, guides configuration on first run
- **Saved Config**: ~/.codebot/config.json — configure once, never pass flags again
- **Autonomous Mode**: --autonomous flag skips all permission prompts
- **Streaming**: Real-time text output, thinking token display, usage stats
- **Permission System**: Three levels (auto, prompt, always-ask) with dangerous command blocking
- **Project Awareness**: Repo map scanner, context-aware system prompt
- **Zero Runtime Dependencies**: Only TypeScript and @types/node as dev dependencies
