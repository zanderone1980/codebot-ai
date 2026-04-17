# RFC 003 — Cross-task memory (Tier 4)

**Status**: design, not built. CodeBot has half-built infrastructure
(`src/experiential-memory.ts`, `src/cross-session.ts`,
`src/lesson-extractor.ts`) that this RFC would finish and wire to real
outcomes.

**Author**: Claude (audit session 2026-04-17)
**Estimated effort**: 2–4 weeks for a real implementation
**Expected impact on SWE-bench**: +2–8pp (smaller than RFCs 001/002 —
this is a longer-tail compounding play, not a one-shot lift)

## Problem and current state

CodeBot already has scaffolding for "remember what worked":
- `src/experiential-memory.ts` — stores `LessonRecord` entries
- `src/cross-session.ts` — `CrossSessionLearning` (aggregates patterns
  across sessions)
- `src/lesson-extractor.ts` — extracts lessons from sessions
- `Agent.reinforceLesson` / `Agent.weakenLesson` — methods that exist
  but aren't called from any real outcome path (open thread in user
  memory)

The infrastructure is there but the loop isn't closed: nothing measures
"did the agent's choice in this session actually help?" so nothing can
mark a lesson as good or bad. The result is a memory that grows but
doesn't get *better*.

For SWE-bench specifically: the resolved Django tasks share patterns
(both `django-11119` and `django-11133` involve admin/filters work; both
were solved with similar edits). A memory that captures these patterns
and surfaces them on related tasks would compound gains run-over-run.

## Proposal

### Part A — close the feedback loop on existing infrastructure (1 week)

Wire `reinforceLesson` / `weakenLesson` into the existing flow:

1. After a session ends, if the user explicitly said "thanks" / closed
   the conversation positively → reinforce all lessons used.
2. If the agent's final message contains "I tried X, didn't work" →
   weaken those lessons.
3. For SWE-bench specifically: after `eval.sh` produces a `report.json`,
   walk back through the session that produced each patch and
   reinforce-or-weaken the lessons it relied on based on
   `resolved`/`unresolved` outcome.

This requires:
- Recording `lesson_id`s a session referenced (not currently tracked)
- A small `apply-outcome.ts` script that reads a SWE-bench
  `report.json` + the corresponding session log and dispatches
  reinforce/weaken calls.

### Part B — surface relevant memories in new sessions (1 week)

Currently `experiential-memory` exposes a `query(filter)` API that
returns matching lessons but it's not wired into the system prompt.

Add: at session start, query for top K lessons matching the project's
language and rough domain ("Django ORM", "matplotlib plotting",
"FastAPI endpoint"), include them in the system prompt as:

```
== Lessons from past similar tasks ==
- When editing Django Filter classes, also check field_choices method (high-confidence, n=3)
- For astropy modeling, _cstack and _separable share index conventions (med-confidence, n=2)
```

Domain inference: simple keyword match against the project's package
names + import statements in changed files.

### Part C — first SWE-bench-specific lesson template (1 week)

Define a concrete `SWELesson` schema:
```typescript
interface SWELesson {
  pattern_id: string;
  repo: string;                  // e.g. "django/django"
  problem_keywords: string[];    // extracted from problem statements
  approach_summary: string;      // 1-2 sentence "what worked"
  example_files_modified: string[];
  example_test_passed: string[];
  source_session_ids: string[];  // for provenance
  reinforcements: number;        // success count
  weakenings: number;            // failure count
}
```

Mine the 17 resolved tasks from the 50-task SWE-bench run as the seed
corpus — get a starter set of ~5-10 templates without any new model
calls.

## Validation

- Re-run 50-task SWE-bench slice with cross-task memory enabled
- Compare resolved count vs the 17/50 baseline
- For lift to count, it must come from tasks NOT in the seed corpus —
  otherwise we're measuring overfit, not transfer

## Why this is Tier 4 (lowest priority)

- Per-task lift is small (each lesson nudges, doesn't determine)
- Lift compounds over time and requires many runs to see
- The big-rock lifts come from RFCs 001 and 002 (and Tier 2.1 v2)
- Without enough successful runs in the corpus, the memory has nothing
  to teach from

Build this AFTER 001 and 002 have lifted the success rate. Then there's
enough success-pattern signal to make memory worth mining.

## Non-goals

- Free-form text "memory" (already exists as `~/.codebot/memory/*.md`).
  This RFC is about *structured* lessons that can be queried and
  reinforced.
- Vector embeddings of lesson text. Defer until simple keyword matching
  proves insufficient.
- "Skill packs" pre-shipped with CodeBot. Out of scope; user-specific
  learnings only.

## Open questions

1. Privacy: do user lessons ever sync between machines / users? Default
   should be NO — local-only. Maybe an opt-in `codebot --share-lesson`
   later for a community pool.
2. How aggressively to forget? Lesson decay over time? Probably yes
   (`weakening / (reinforcements + weakenings)` exceeds threshold →
   archive).
3. Conflict resolution: two lessons contradict each other (e.g., "always
   use Q objects" vs "Q objects break on certain JSONField queries"). The
   reinforcer needs to handle both surviving with context.
