---
project: codebot
type: rfc-index
updated: 2026-04-17
---

# CodeBot RFCs — index

## Shipped

- **RFC 001 Part A** — `find_symbol` tool for precise localization
  (src/tools/find-symbol.ts, shipped 2026-04-17). Scans project with
  regex per language (Python / TS / JS / Go / Rust / Ruby / Java),
  returns declaration sites only — not every textual hit like grep
  would. Complements rather than replaces grep.

## Designed, not built

- **RFC 001 Part B** — repo structure summary in system prompt.
  Top-2-level package tree + first-line-of-each-__init__ docstring.
  Expected +3-5pp on SWE-bench. ~1 day.
- **RFC 001 Part C** — call-graph awareness via tree-sitter. When
  agent edits `foo()`, surface "functions that call foo" automatically.
  Expected +5-10pp. ~1 week.
- **RFC 002** — multi-agent architecture (planner → coder → reviewer).
  Depends on RFC 001 landing first. 4-8 weeks.
- **RFC 003** — cross-task memory. Close the reinforce/weaken loop on
  experiential-memory.ts + cross-session.ts. Part A (wire to outcomes)
  = 1 week. Part B (query-relevant lessons in system prompt) = 1 week.

## Priority rationale

RFC 001 Part B is the highest ROI next technical build — cheap,
compounds with find_symbol, targets the 18 stable-fail SWE-bench tasks.

RFC 002 is expensive and wrong-order: without real test-loop feedback
(Tier 2.1 v2, which shipped today), the critic agent has nothing to
react to.

RFC 003 pays off long-term but slowly — correct order is after RFCs
001 and 002 have lifted pass rate enough that the memory has good
patterns to mine from.
