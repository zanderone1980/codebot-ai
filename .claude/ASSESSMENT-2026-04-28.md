# CodeBot AI — Independent Assessment, 2026-04-28

Branch: `claude/assess-code-bot-ZKFgx` · `package.json` version: `2.10.1`

**Empirically tested**: ran `npm install`, `npm test` (which auto-builds via
`pretest`), and instantiated the runtime tool/provider registries. Numbers
below are observed from execution, not just file-reading.

---

## Empirical results

### Tests — `npm test`

```
# tests 1979
# suites 388
# pass 1979
# fail 0
# cancelled 0
# skipped 0
# todo 0
# duration_ms 136295.163324
```

**1,979 passing / 388 suites / 0 fails / 0 skips / 136s wall.**
Run on Linux 6.18, Node v22.22.2, this branch HEAD.

### Public claims vs reality

| Surface | Claim | Reality | Drift |
|---|---|---|---|
| `README.md` badge (line 11) | **1630** | **1,979** | **−349** |
| `README.md` body (line 76) | **1,265** | **1,979** | **−714** |
| `ROADMAP.md` Current State | **1,265** | **1,979** | **−714** |
| `CHANGELOG.md` v2.10.0 | **1,493** | **1,979** | **−486** |

Every public test number is stale. None of them is correct. Pick `1,979`,
update all four surfaces in one commit.

### Tools — runtime registry

```
new ToolRegistry(cwd).getToolCount() → { core: 12, standard: 12, labs: 12, total: 36 }
```

**36 tools registered.** README claim "36 tools" is correct. Names:

```
app, batch_edit, browser, code_analysis, code_review, database,
decompose_goal, deep_research, delegate, diff_viewer, docker, edit_file,
execute, find_symbol, git, glob, graphics, grep, http_client, image_info,
memory, multi_search, notification, package_manager, pdf_extract,
plugin_forge, read_file, routine, skill_forge, ssh_remote, task_planner,
test_runner, think, web_fetch, web_search, write_file
```

### Providers — runtime registry

```
PROVIDER_DEFAULTS keys: anthropic, deepseek, gemini, groq, mistral, openai, xai
Cloud provider count: 7
MODEL_REGISTRY distinct providers: anthropic, deepseek, gemini, groq, mistral, openai, xai
```

**7 cloud providers + 3 local (Ollama / LM Studio / vLLM) = 10 total.**

README is internally inconsistent:
- Line 21 — *"any of **eight cloud** providers"* (wrong; it's 7)
- Line 117 — *"**Eight providers**"* then lists 10 names (wrong both ways)
- Line 130 architecture diagram — *"**8 providers** (local+cloud)"* (wrong; 10)

There is no consistent reading of "8." Pick "7 cloud + 3 local (10 total)"
and apply it everywhere.

### Connectors

`src/connectors/` contains: github, slack, jira, linear, replicate, gmail,
google-calendar, notion, google-drive, x-twitter — **10 connector modules**,
matches ROADMAP.

---

## What's real (verified by code + runtime)

| Claim | Verified by |
|---|---|
| 36 built-in tools | `ToolRegistry.getToolCount()` at runtime |
| Hash-chained audit log code path | `src/audit.ts` schema + tests in suite (1,979 pass) |
| 7 cloud providers in registry | runtime introspection of `PROVIDER_DEFAULTS` |
| 3 local providers via model registry | model entries for ollama/lmstudio/vllm targets |
| 10 app connectors | `src/connectors/*` |
| SARIF export | `src/sarif.ts` + tests in green suite |
| Vault mode (read-only over markdown) | `src/vault.ts` + vault tests in green suite |
| MIT licensed | `LICENSE`, `package.json` |
| 1 hard dep (`cord-engine`) + 2 optional | `package.json` |
| Post-commit local-app sync hook | `electron/scripts/install-git-hook.sh` (per-clone install) |

## What I still cannot verify in this sandbox

- **SWE-bench 34% (17/50).** The report
  (`docs/benchmarks/swe-bench-verified-2026-04-16-50tasks.md`) is internally
  consistent and the run JSON is checked in. Reproducing requires Docker +
  the harness on a machine with the model API keys.
- **Local app freshness** (`~/Applications/CodeBot AI.app`) — not running
  on Alex's machine, can't `defaults read` it.
- **Ollama / LM Studio / vLLM end-to-end** — no local LLM in sandbox.

---

## Trust-hygiene findings (the actionable list)

### 1. Test count is wrong in 4 places — fix in one commit

| File / line | Replace |
|---|---|
| `README.md:11` (badge URL) | `tests-1630%20passing` → `tests-1979%20passing` |
| `README.md:76` | `1,265 tests` → `1,979 tests` |
| `ROADMAP.md` Current State table | `1,265 passing (242 suites)` → `1,979 passing (388 suites)` |
| `CHANGELOG.md` v2.10.0 entry | `1,265 → 1,493 (+228 new tests)` → re-derive against HEAD |

### 2. Provider count is wrong in 3 places

| File / line | Replace |
|---|---|
| `README.md:21` | "any of eight cloud providers" → "any of 7 cloud providers" |
| `README.md:117` | "Eight providers: …" → "7 cloud + 3 local (10 total)" |
| `README.md:130` (architecture) | `8 providers (local+cloud)` → `10 providers (7 cloud + 3 local)` |

### 3. ROADMAP is one minor version stale

`package.json` is `2.10.1`. `ROADMAP.md` Current State header still says
`v2.9.0`. Add a v2.10.0 / v2.10.1 row to the milestones table and bump the
header.

### 4. `.claude/GAME_PLAN.md` is itself stale

Lines 35–49 prescribe fixes assuming v2.7.7 / 1,217 tests. Repo is at v2.10.1
/ 1,979 tests. The fix list no longer matches reality. Either regenerate it
against HEAD or mark it historical.

---

## Architecture observations

| File | Lines | Note |
|---|---|---|
| `src/agent.ts` | 1,622 | GAME_PLAN target was ~500 lines after decomposition. Direction is wrong. |
| `src/cli.ts` | 796 | GAME_PLAN said decomposed to 385. Drifted up. |
| `src/tools/browser.ts` | 117 | Decomposition into `src/tools/browser/` happened. Target hit. |
| `src/policy.ts` | 708 | Reasonable for an enforcer module. |
| `src/risk.ts` | 513 | Reasonable. |
| `src/audit.ts` | 282 | Tight. |

`agent.ts` and `cli.ts` are growing back toward the pre-decomposition state
they were carved out of. Worth a follow-up audit before the next refactor
cycle.

---

## Risks I'd flag to anyone evaluating this repo

1. **Number-mismatch is the single biggest credibility leak.** A reader who
   spots that the badge says 1630 while the body says 1,265 stops trusting
   any other number on the page. The actual number is 1,979 and none of the
   four published surfaces show it.
2. **`gpt-5.4` model identifier** appears in README, code, and benchmark
   reports. If that's an aspirational name rather than a real published API
   model, anyone trying to reproduce will fail at the API call. Verify it
   resolves at OpenAI before any launch push.
3. **One non-optional runtime dep (`cord-engine`)** drives the
   "fully local / air-gapped" claim. If `cord-engine` itself does any
   network init or telemetry, the air-gap claim isn't end-to-end. Worth a
   one-line confirmation in `SECURITY.md`.
4. **Telemetry framing.** README says "Zero telemetry by default." A
   "heartbeat ping" exists per CHANGELOG and per code (`src/heartbeat.ts`),
   "off by default and won't turn itself on." Reconcile in `SECURITY.md`
   so an auditor doesn't have to dig through changelog to learn telemetry
   exists at all.

---

## Recommended single next commit

Run nothing else first — the suite is already green at 1,979. Edit:

- `README.md:11` badge → 1979
- `README.md:76` body → 1,979 tests
- `README.md:21,117,130` provider count → "7 cloud + 3 local (10 total)"
- `ROADMAP.md` Current State → v2.10.1, 1,979 tests, 388 suites

One commit, four files, closes the highest-impact trust gap with the
smallest diff.

---

*Tested 2026-04-28. Numbers are observed runtime values, not parsed claims.*
*Test command: `npm test` (auto-builds via `pretest`). Wall time: 136 s.*
