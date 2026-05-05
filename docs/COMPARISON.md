# How CodeBot AI compares

CodeBot is an autonomous coding agent, not an AI-powered editor. The comparisons below reflect what CodeBot is competing with — and what it deliberately isn't.

## CodeBot is NOT trying to replace these

| | What it is | Why CodeBot doesn't compete |
|---|---|---|
| **Cursor** | AI-enhanced IDE (VS Code fork) | Cursor wins on tab-completion + in-flow ergonomics. CodeBot has no editor. |
| **GitHub Copilot** | Inline-suggestion AI in your IDE | Same category as Cursor. Different job than CodeBot. |
| **Zed + AI** | Next-gen editor with AI built-in | Editor category. CodeBot runs outside the editor. |
| **Claude Code CLI** | Interactive CLI assistant for Claude | Interactive-first; no autonomous issue-to-PR; no audit trail. |

If you want tab completion and inline suggestions *while you type*, pick one of these. CodeBot will not make them obsolete and isn't trying to.

## CodeBot IS competing with these

| | Cursor / Copilot | Aider | Devin | **CodeBot** |
|---|:---:|:---:|:---:|:---:|
| **Autonomous issue-to-PR** | No | Partial | Yes | **Yes** |
| **Cryptographic audit trail** (hash-chained) | No | No | No | **Yes** |
| **Local LLM supported** | No | Yes | No | **Yes** |
| **Policy + risk-scoring layer** | No | No | Partial | **Yes** |
| **SARIF 2.1.0 export for CI** | No | No | No | **Yes** |
| **Constitutional safety engine (CORD)** | No | No | No | **Yes** |
| **MIT / open source** | No | Yes | No | **Yes** |
| **Runs fully offline** (with local LLM) | No | Yes | No | **Yes** |
| **Zero telemetry by default** | No | Yes | No | **Yes** |
| **Any LLM provider** (7 cloud + local) | GPT only | Yes | Proprietary | **Yes** |
| **Price** | $20/mo | Free | $500/mo | **Free / MIT** |

The headline axes where CodeBot is genuinely differentiated are the first two: **autonomous + auditable**. Every other row is either a cost advantage or a sovereignty advantage — real, but supporting.

## Why autonomous + auditable matters

**Autonomous**: the agent does end-to-end work. You delegate a task, not a keystroke. It runs tests, iterates until green, opens a PR. Interactive tools make *you* faster; an autonomous agent does *work that otherwise wouldn't happen* because you were busy.

**Auditable**: every tool call (read, write, execute, git, HTTP) is written to a hash-chained log. Tampering breaks the chain. SARIF export pipes into existing code-scanning dashboards. The question "what did the AI do to our codebase?" has a proof-backed answer, not a hand-wave.

Most AI coding tools ship without this because their buyer (an individual developer) doesn't ask for it. CodeBot's buyer is someone who does ask — a security engineer, a compliance officer, an engineering manager in a regulated industry. The audit log is the entire point.

## Choosing between CodeBot and something else

**Pick Cursor / Copilot if**: you want faster typing and inline suggestions inside a polished editor. You don't need an audit trail. Your company is fine with code going to OpenAI / Anthropic / Microsoft servers.

**Pick Aider if**: you're an individual developer who likes a terse CLI, wants local LLM support, and doesn't need governance features. You're running on your own box and don't need to prove anything to anyone else.

**Pick Devin if**: you have $500/month per seat, you trust a closed-source agent with your codebase, and "autonomous" is more valuable than "verifiable."

**Pick CodeBot if**:
- You need AI to do coding work end-to-end (not just suggest completions)
- And you (or your auditor, your CISO, your ops lead) need to verify what it actually did
- And your codebase can't leave your network, or you don't want to pay for a closed-source agent to run on servers you don't control
- And you want to configure policy, risk tolerance, and safety rules per-project, in YAML

## Honest limits

CodeBot is worse than Cursor at being an editor. It's worse than Devin at raw benchmark pass rates (Devin is ~50-65% on SWE-bench Verified full 500; CodeBot is 48% on a 50-task slice). It's worse than Aider at minimal-install simplicity (Aider is a single pip install; CodeBot has a TypeScript build + optional Docker sandbox + optional Electron dashboard).

What CodeBot is better at than all of them is the governance + auditability axis. That's the axis this project is built around. If that axis doesn't matter to you, something else is probably a better fit.

---

*Last updated: 2026-04-17. Comparisons reflect publicly-documented features as of that date; check the linked vendors' docs for current status.*
