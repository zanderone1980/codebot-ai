---
project: codebot
status: active
updated: 2026-04-17
---

# CodeBot GTM notes

## Positioning (current working theory)

CodeBot is **not** a Cursor or Copilot competitor. Those tools sell
"AI-enhanced editor" to individual developers. CodeBot sells
*delegation with an audit trail* to teams that need to verify what an
AI did after the fact. Different category, different buyer.

Three pillars, in order:
1. **Autonomous** — the agent runs end-to-end, not inline suggestions.
2. **Cryptographic audit trail** — every tool call hash-chained, SARIF export.
3. **Runs where your code can't leave** — local LLM support, MIT, zero telemetry.

## Target ICP

- Security-conscious engineering teams at regulated-industry companies
  (fintech, healthcare, gov-adjacent).
- Solo builders / small teams running AI on long tasks unattended.
- Anyone whose InfoSec team has said "we can't use Copilot because the
  code leaves our network."

## Price anchors

- Cursor: $20/month individual.
- Devin (AI contractor): $500/month.
- CodeBot: MIT, free, bring your own LLM.

## Hypotheses to test

- H1: the "governance" angle differentiates enough that developers
  pick CodeBot over Cursor *when their buyer is a CISO*, not themselves.
- H2: open-source + local-first is enough moat against the $500/mo
  closed-source alternatives.
- H3: a single SWE-bench Verified number ≥ 40% is sufficient
  credibility to move beyond word-of-mouth.

## Next steps

- Ship the 3-post X thread (in docs/X_LAUNCH_THREAD.md).
- 20 LinkedIn DMs to InfoSec titles at mid-size fintechs.
- Record a 30-second demo video showing the audit log catching a
  destructive command and refusing it.
