# CodeBot AI — Independent Assessment, 2026-04-28

Branch: `claude/assess-code-bot-ZKFgx` · package.json version: `2.10.1`

This is a read-only assessment grounded in what I could verify by inspecting
the working tree on the branch above. I did NOT install dependencies, build
`dist/`, or run `npm test`, so any claim that depends on test execution is
flagged "unverified."

---

## What's real (verified by reading code)

| Claim | Source | Verified |
|---|---|---|
| 36 built-in tools | `src/tools/index.ts` (36 `regIf(new ...Tool(...))` calls) | YES |
| Hash-chained audit log, never throws | `src/audit.ts:1-60`, `AuditEntry` schema, comments + structure | YES (structure exists; tamper detection logic not exercised) |
| 7 cloud providers wired in registry | `src/providers/registry.ts` PROVIDER_DEFAULTS: anthropic, openai, gemini, deepseek, groq, mistral, xai | YES (7, not 8) |
| 3 local providers (Ollama / LM Studio / vLLM) | model registry entries + setup flows | YES (model entries present; runtime not exercised) |
| 10 app connectors | `src/connectors/`: github, slack, jira, linear, replicate, gmail, google-calendar, notion, google-drive, x-twitter | YES (10 files; ROADMAP says 10) |
| SARIF export | `src/sarif.ts` + `sarif.test.ts` | File exists, behavior unverified |
| Vault mode (read-only over markdown notes) | `src/vault.ts`, `src/tools/vault-filter.test.ts`, recent commits "Vault Mode" | YES (code path exists) |
| MIT licensed | `LICENSE`, `package.json` | YES |
| Single hard dep + two optional | `package.json`: `cord-engine` runtime; `@ai-operations/*` optional | YES |
| Post-commit local-app sync hook | `electron/scripts/install-git-hook.sh` referenced in `CLAUDE.md` | Script exists in repo; hook installation per-clone (not in `.git/`) |

## What I could NOT verify here

- **Test pass count.** No `node_modules/`, no `dist/`. I counted 120 `.test.ts`
  files containing 388 `test(...)` / `describe(...)` blocks, but the assertion
  count (which the badge measures) is unknown without running.
- **SWE-bench 34% (17/50).** Report at
  `docs/benchmarks/swe-bench-verified-2026-04-16-50tasks.md` is internally
  consistent and the run JSON is checked in (`bench/swe/codebot-ai-2.10.0.verified-50-20260416-202834.json`).
  Reproducing it requires Docker + the harness.
- **Local app freshness** (`~/Applications/CodeBot AI.app`) — sandboxed env,
  not on Alex's machine.

---

## Trust hygiene — inconsistencies the README is shipping today

These are public-facing and contradict each other. They should be cleaned up
before any launch push.

### 1. Test count: four different numbers, all live

| Surface | Number |
|---|---|
| `README.md` badge (line 11) | **1630** passing |
| `README.md` body (line 76) | **1,265 tests** |
| `ROADMAP.md` "Current State (v2.9.0)" | **1,265 passing** |
| `CHANGELOG.md` v2.10.0 entry | **1,265 → 1,493 (+228)** |

Pick one truth, run `npm test`, paste the count, update all four. The badge
saying 1630 is the most exposed and the most undocumented anywhere else in
the repo.

### 2. Provider count: README contradicts itself in two places

- `README.md:21` — *"any of **eight cloud** providers"*
- `README.md:117` — *"**Eight providers**: Ollama / LM Studio / vLLM **and** Anthropic / OpenAI / Google / DeepSeek / Groq / Mistral / xAI"* — that's 3 + 7 = 10 names listed under "Eight providers."
- `README.md:130` (architecture diagram) — *"**8 providers** (local+cloud)"*
- `src/providers/registry.ts` PROVIDER_DEFAULTS — **7** cloud entries.

Reality is **7 cloud + 3 local = 10 total**, OR **7 cloud** if you count only
non-local. There is no consistent reading of "8."

### 3. ROADMAP is one minor version stale

`package.json` is `2.10.1`. `ROADMAP.md` "Current State" header still says
`v2.9.0` and reports `1,265 tests`. `CHANGELOG.md` already documents v2.10.0
and the +228-test bump. Either the ROADMAP table needs a v2.10 row or the
"Current State" pointer needs to advance.

### 4. `.claude/GAME_PLAN.md` is itself a stale plan

Lines 35-49 of `.claude/GAME_PLAN.md` prescribe fixes assuming v2.7.7 and
1,217 tests. The repo is now at v2.10.1. The fix list is no longer the
right delta. If you want a punch-list, generate a new one against current
counts; otherwise mark this file historical.

---

## Architecture observations (not problems, just observations)

- **`src/agent.ts` is 1,622 lines.** GAME_PLAN.md flagged it at 1,044 lines
  with a decomposition target. It has grown, not shrunk. Recent commits
  reference an "Agent decomposition" deliverable in v2.9.0 — either the
  decomposition extracted helpers but kept the main file long, or it
  hasn't really happened. Worth a closer look.
- **`src/tools/browser.ts` is 117 lines.** Decomposition target hit; logic
  moved into `src/tools/browser/`.
- **`src/cli.ts` is 796 lines.** GAME_PLAN noted cli was decomposed
  "1,397 → 385 lines + 4 sub-modules." Current 796 suggests it has been
  drifting back up. Worth re-checking the sub-module split.
- **Test layout is co-located** (`src/foo.ts` next to `src/foo.test.ts`).
  Clean, easy to navigate, but the lack of a `tests/integration/` split
  means the "unit vs integration vs security" breakdown that GAME_PLAN
  recommended adding to README still isn't surfaceable from the file tree.

## Repo signals worth keeping

- Commit log uses the `[TAG]` convention enforced by `.agent-guardrails.json`.
  The recent run is consistent: `[INFRA]`, `[FIX]`, `[SECURITY]`, `[REFACTOR]`.
  This is real discipline — keep it.
- The SWE-bench report is unusually honest: it leads with "17 empty diffs"
  as the dominant failure mode and explicitly notes the alphabetical slice
  caveat. That kind of writeup is a credibility asset.
- `CLAUDE.md` anti-theater protocol + `.agent-guardrails.json` + the
  `electron/scripts/sync-local-app.sh` hook chain is a coherent
  no-bullshit-during-development system. Most projects don't have this.

## Risks I'd flag to someone considering using or evaluating this

1. **The number-mismatch problem is the single biggest credibility leak.**
   A reader who notices the badge says 1630 but the body says 1,265 will
   stop trusting any other number on the page.
2. **`gpt-5.4` references in README, code, and benchmark.** If that model
   identifier is aspirational rather than published, anyone trying to
   reproduce will fail at the API call. Verify it's a real model ID at
   the provider before launch, or label it as the placeholder it is.
3. **One non-optional dependency (`cord-engine`) drives "fully local /
   air-gapped" claims.** If `cord-engine` itself does any network init
   or telemetry, the air-gap claim isn't end-to-end. Worth a one-line
   confirmation in SECURITY.md.
4. **README claims "Zero telemetry by default"** and CHANGELOG mentions
   a "heartbeat ping" that's "off by default and won't turn itself on."
   These two statements need to be reconciled in SECURITY.md so an
   auditor doesn't have to dig through the changelog to learn that
   telemetry exists at all.

## Recommended next single commit (small, high signal)

Run `npm test`, capture the real pass count, then in one commit:

- Update README badge → real number
- Update README body line 76 → same number
- Update ROADMAP "Current State" header → v2.10.1, same number
- Fix README provider count to "7 cloud + 3 local (10 total)" or pick a
  consistent framing and apply it everywhere

That's it. That single PR closes the highest-impact trust gap with the
least surface area touched.

---

*Generated read-only against working tree at HEAD. No source files modified.*
