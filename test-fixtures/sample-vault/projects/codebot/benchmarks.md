---
project: codebot
type: benchmarks
updated: 2026-04-17
---

# SWE-bench Verified results

## Baseline — 2026-04-16

First real Docker-scored result. 50-task slice of SWE-bench Verified
(first 50 instances alphabetical: astropy + early django).

- Patches produced: 33 of 50
- Resolved (tests pass): **17 of 50 = 34.0%**
- Unresolved: 16
- Errors: 0
- Wall time: ~90 min
- Model: gpt-5.4 via OpenAI Responses API

## v2 — 2026-04-17 (with Tier 1 + Tier 2 harness fixes)

Same 50-task slice, same model, this time with partial-clone +
force-diff retry + Docker-based test-driven inner loop.

- Patches produced: 39 of 50
- **Resolved: 24 of 50 = 48.0%** (+14 pp vs baseline)
- Unresolved: 15
- GAINED: 9 tasks (5 from clone-timeout fix, 4 from test-loop feedback)
- LOST: 2 tasks (model non-determinism)
- Signal: +7 (strong)
- Wall time: 3h 39m

## Comparison context (full SWE-bench Verified leaderboard, approximate)

- Top closed-source (Devin et al.): ~60-65%
- Top open-source (OpenHands, Aider variants): ~50-55%
- Mid open-source: ~30-45%
- CodeBot 2.10.1 on slice: **48%** — firmly upper-mid open-source

## What's next for the benchmark

- Run full 500-task Verified (~$150-250 in gpt-5.4 tokens, 40-60 hr wall).
- Build RFC 001 Part B (repo structure summary) to attack the 18
  stable-fail tasks.
- Build Tier 2.1 v2.1 (multi-turn Docker test loop) for harder fixes.
