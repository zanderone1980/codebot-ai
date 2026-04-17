# RFC 002 — Multi-agent architecture (Tier 4)

**Status**: design, not built
**Author**: Claude (audit session 2026-04-17)
**Estimated effort**: 4–8 weeks
**Expected impact**: +10–25pp on SWE-bench Verified — IF the test-driven
loop (Tier 2.1 v2) is in place. Without test signal feedback to the
critic, this becomes architecture-for-architecture's-sake.

## Problem

Current CodeBot uses a single agent loop: the model sees a problem,
makes tool calls in sequence, eventually stops or runs out of iterations.
There is no separation between *planning*, *execution*, *validation*,
and *self-review*. Failures cascade — a bad plan produces bad edits which
the same agent then has to debug while still in plan-execute mode.

Top SWE-bench leaders (Cognition / Devin, OpenHands, AutoCodeRover) all
use multi-agent or multi-phase architectures. The gap between mid-tier
single-agent systems (~30-40%) and leader systems (~55-65%) is largely
this.

## Proposal

Three roles, sequential, with explicit handoff contracts:

```
┌──────────┐    plan.md    ┌──────────┐   patch.diff   ┌──────────┐
│ PLANNER  │ ─────────────▶│  CODER   │ ──────────────▶│ REVIEWER │
└──────────┘               └──────────┘                └──────────┘
     │                          │                          │
     │ files_to_read            │ failing_tests            │ accept | revise
     │ acceptance_criteria      │ tool_calls               │ comments
                                │                          │
                                ▼                          ▼
                            (test loop)              (back to CODER if revise)
```

### PLANNER (~1 model call, low temperature)

Input: problem statement, repo structure summary, symbol index lookups.
Output: a structured plan markdown:
```yaml
files_to_modify: [django/db/models/fields/related.py, ...]
files_to_read_first: [django/db/models/fields/related.py:1247-1340, ...]
acceptance_criteria:
  - "RelatedFieldListFilter respects Model.ordering when no Meta.ordering set"
  - "test_get_choices_default_ordering passes"
risk: medium
```

Planner does NOT edit code. Just reads + writes the plan.

### CODER (current Agent loop, agnostic to multi-agent context)

Input: problem statement + the planner's `plan.md`.
Output: a `git diff` against the base commit + a list of FAIL_TO_PASS
tests it believes its patch fixes.
This is essentially the current Agent — minimal changes.
Test-driven inner loop (Tier 2.1 v2) lives here.

### REVIEWER (~1 model call, low temperature)

Input: problem statement, plan.md, the patch, the inner-loop test
results, and the patch's effect (`git diff --stat`).
Output: `accept` OR `revise` with specific comments.

If `revise`: comments fed back to the CODER for one more pass. Cap at
2 review cycles to avoid runaway.

### Orchestrator

A small TypeScript script that wires the three together. Each role
gets a separate Agent instance with its own system prompt. They share
nothing except the artifact files (`plan.md`, `patch.diff`,
`review.md`). This makes the whole thing inspectable post-hoc.

## Why three roles, not two or five

- **One** (current): no separation — failures compound.
- **Two** (planner + coder): no critic, so the coder marks its own
  homework. We have evidence this fails: in the 50-task run CodeBot
  often produced patches that "looked right" and stopped without
  noticing they didn't actually fix the failing test.
- **Three** (this RFC): minimal viable separation of concerns. The
  reviewer reads the diff with fresh context — the same reason human
  code review works.
- **Four+** (e.g., add a "tester" role separate from the inner test
  loop): adds latency and cost without clear benefit. The inner test
  loop already handles "did the tests pass" mechanically; a tester
  agent would just be re-rendering that into prose.

## Concrete implementation plan

Phase 1 — add a `--plan` mode to the CLI (1 week)
- New flag: `codebot --plan "fix the bug"` — runs planner only,
  outputs plan.md, doesn't touch code.
- Verify the planner produces parseable plans on 5-10 tasks.

Phase 2 — wire the orchestrator (2 weeks)
- New entry point `bench/swe/run-multi-agent.sh` that does:
  `codebot --plan` → save plan → `codebot --plan-file=plan.md` (existing
  Agent reads this as additional context) → after diff captured, invoke
  `codebot --review --diff=patch.diff` → if revise, loop once.

Phase 3 — measure (1 week)
- Re-run the 50-task SWE-bench slice with multi-agent vs single.
- A/B comparison. Cost/wall comparison.

## Non-goals

- Distinct LLMs per role. Use the same model (gpt-5.4) for all three with
  different system prompts. Different models add complexity that should
  be backed by data, not prior.
- Inter-agent message passing beyond file artifacts. KISS: write file,
  invoke next role.
- Persistent agent memory across roles. Each invocation is fresh — that's
  the point. Cross-task memory is RFC 003.

## Cost / wall impact

Per task: ~3x current LLM cost (planner small, coder same, reviewer
small) and ~2x wall (planner + reviewer add ~1 min each on top of
current ~1 min coder time).

For a 50-task run: ~$30-45 (vs current ~$15) and ~3 hrs gen (vs current
~1 hr). Acceptable for a benchmark run; not for routine use until lift
is proven.

## Pre-requisites

This RFC's lift is **dependent on Tier 2.1 v2 being built first**. Without
real test signal in the inner loop, the reviewer has nothing to react to
and the architecture is theater.

Order of work:
1. Tier 2.1 v2 (Docker-based test loop) — 1 week
2. RFC 001 (better localization) — 1-2 weeks
3. THIS RFC (multi-agent) — 4-8 weeks

If we shipped this RFC without (1), expected lift is 0-5pp. With (1), the
10-25pp range becomes plausible.

## Risks

- **Cost overhead may not pay for itself.** If the reviewer just rubber-
  stamps everything, we paid 3x for nothing. Validation: measure how often
  the reviewer says "revise" and how often that revision flips the result.
- **Planner-coder mismatch.** The planner says "modify file X" and the
  coder modifies file Y because it sees better evidence. Need clear
  protocol for the coder deviating from the plan.
- **Latency.** 3x wall per task. May be fine for batch (SWE-bench), bad for
  interactive use. Keep multi-agent OFF by default; opt-in flag.
