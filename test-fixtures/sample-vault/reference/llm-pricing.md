# LLM pricing reference (as of 2026-04)

Notes on provider costs for sizing CodeBot usage and setting monthly caps.

## Claude (Anthropic)

- **Sonnet 4.6**: $3/M input, $15/M output, $0.30/M cache-read, $3.75/M cache-create
- **Haiku 4.5**: $1/M input, $5/M output
- **Opus 4.6**: $15/M input, $75/M output  ← expensive, avoid for routine use
- Prepaid credits model. Hit "credit balance too low" error when depleted.
- Set monthly spend limit at console.anthropic.com/settings/limits.

## OpenAI

- **gpt-5.4**: lives on /v1/responses endpoint, not chat-completions
- **gpt-4o**: standard chat-completions, ~$5/M input, $15/M output
- Project-level keys (sk-proj-*) have per-project budgets — check
  platform.openai.com/settings/organization/projects.

## Gemini (Google)

- **gemini-2.5-flash**: free tier 10 RPM / 250K TPM / 250 RPD
- **gemini-2.5-pro**: free tier 2 RPM — too tight for agents with tool calls
- OpenAI-compatible endpoint at generativelanguage.googleapis.com/v1beta/openai

## Groq

- **llama-3.3-70b-versatile**: free tier 12K TPM — too tight for
  CodeBot's full 36-tool system prompt (~13K tokens/turn)
- **llama-3.1-8b-instant**: free tier 6K TPM — worse
- Dev Tier ($10/mo): 300K+ TPM, unlocks agent usage

## Local (Ollama)

- **qwen2.5-coder:32b**: free, local, ~30 tok/s on M1 Max
- **qwen2.5-coder:7b**: faster, lower quality, ~60 tok/s
- Zero API cost. The "free forever" option.

## Expected CodeBot spend by pattern

- Light (Q&A, short sessions): $5-15/month on Sonnet 4.6
- Medium (regular coding): $20-50/month on Sonnet 4.6
- Heavy (SWE-bench runs, long sessions): $50-150/month
- Benchmarking (occasional): $150-250 per full SWE-bench 500 run
