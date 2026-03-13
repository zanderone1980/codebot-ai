# CodeBot AI — Pre-Launch Game Plan

Based on 3-prong investor/technical/launch assessment. Every item actionable.

---

## PRONG 1: INVESTOR ASSESSMENT — Action Items

### 1A. Fix "No clear demand proof"
**Problem:** No evidence of user pull, distribution, revenue, or adoption.
**Actions:**
- [ ] Add GitHub star count badge (dynamic, not static)
- [ ] Add npm weekly download badge (dynamic)
- [ ] Add "Used by" section in README (even if empty, shows awareness)
- [ ] Track and display install count on dashboard landing page
- [ ] Create a `/testimonials` or social proof section placeholder
- [ ] If any teams/users exist, get 1-2 quotes and add them
- [ ] Add a "Release Cadence" note showing consistent shipping (link to CHANGELOG)

### 1B. Fix "Messaging ahead of market validation"
**Problem:** Broad platform pitch ("autonomous coding, browsing, search, security, orchestration, integrations") reads as unfocused.
**Actions:**
- [ ] Pick ONE wedge and lead with it everywhere:
  **Recommended wedge:** "The safest local-first autonomous coding agent for teams that can't send code to the cloud."
- [ ] Rewrite README opening to lead with wedge (not feature grid)
- [ ] Rewrite package.json description to match wedge
- [ ] Rewrite extension description to match wedge
- [ ] Rewrite action description to match wedge
- [ ] Move secondary capabilities (browsing, search, integrations) below the fold
- [ ] Add "Who this is for" section: security-sensitive dev teams, local-first power users, regulated industries

### 1C. Fix "Trust hygiene not tight enough"
**Problem:** README contradicts itself on tool count, test count, dependencies.
**Actions (EXACT fixes):**
- [ ] README badge: change `tests-1125%20passing` → `tests-1217%20passing`
- [ ] README badge: change `tools-32` → `tools-31`
- [ ] README heading: change "32 Built-in Tools" → "31 Built-in Tools"
- [ ] README tool table: remove `delegate` row (not in registry), add `deep_research` row
- [ ] README body line 350: change "1,168 tests" → "1,217 tests"
- [ ] README badge: change `dependencies-0` → `dependencies-1` OR move cord-engine to optionalDependencies and keep the badge at 0
- [ ] README connectors section: add Gmail, Google Calendar, Notion, Google Drive (4 missing)
- [ ] ROADMAP "Current State" section: update to v2.7.7, 1,217 tests, 31 tools
- [ ] CHANGELOG: remove duplicate v2.5.0-2.5.2 entries (appears 3x)
- [ ] Extension package.json: update version 2.0.0 → 2.7.7
- [ ] Extension package.json: update description to match wedge
- [ ] Extension package.json: change default provider from "openai" to "ollama" (matches local-first story)
- [ ] Action package.json: update version 2.0.0 → 2.7.7
- [ ] Action action.yml: update description to match wedge
- [ ] .git/description: set to actual repo description

### 1D. "What would make it fundable" — 5 items

**1D-1. Clear user segment**
- [ ] Add "Who This Is For" section to README after the value prop:
  - Security-sensitive development teams
  - Regulated industries (finance, healthcare, government)
  - Teams that can't send code to third-party APIs
  - Solo developers who want autonomous coding without subscription fees
  - Internal platform teams building custom dev tooling

**1D-2. One sharp wedge**
- [ ] Settle on: **"Safe local-first autonomous coding agent"**
- [ ] Every surface must say this within the first sentence
- [ ] README line 1-3 must convey this
- [ ] package.json description must convey this
- [ ] Extension and Action descriptions must convey this

**1D-3. Evidence of pull**
- [ ] Add dynamic npm download badge
- [ ] Add GitHub stars badge
- [ ] Add "active commits" badge or link
- [ ] Track CLI usage metrics (opt-in) for aggregate stats
- [ ] Create a `/stats` dashboard endpoint showing usage

**1D-4. Tightened credibility**
- [ ] All number claims match reality (see 1C above)
- [ ] Add clear onboarding path (see Prong 3 item 4)
- [ ] Tag a proper release (v2.7.7 if not already tagged)
- [ ] Verify npm published version matches repo version
- [ ] Add reproducible demo (see Prong 3 item 5)

**1D-5. Commercial story**
- [ ] Add "Enterprise" section or page covering:
  - What's free (MIT core, all tools, local-first)
  - What enterprise adds (managed deployment, SSO, team audit aggregation, priority support)
  - Why open source alone doesn't commoditize it (governance, compliance, support)
- [ ] This doesn't need to be built yet, just clearly articulated

---

## PRONG 2: TECHNICAL DUE DILIGENCE — Action Items

### 2A. Fix "Docs/repo drift"
**Same as 1C above — all number inconsistencies must be resolved.**

### 2B. Fix "Too much surface area"
**Problem:** CLI + dashboard + extension + action + providers + safety/policy + browser/search/tooling is a lot for one maturity level.
**Actions:**
- [ ] In README, clearly mark maturity levels:
  - **Stable:** CLI, 31 tools, 8 providers, policy engine, audit trail
  - **Beta:** Dashboard, VS Code extension, GitHub Action
  - **Alpha:** Browser automation, swarm mode, SPARK integration
- [ ] Add stability badges per surface (stable/beta/alpha)
- [ ] In docs/ARCHITECTURE.md, add a maturity matrix table
- [ ] Consider moving alpha features behind a flag or separate section

### 2C. Fix "Test confidence unclear"
**Problem:** High test count doesn't prove test quality. Investors want to know unit vs integration, determinism, flakiness.
**Actions:**
- [ ] Add "Testing" section to README:
  ```
  ## Testing
  - 1,217 tests across 232 suites
  - CI matrix: 3 OS (macOS, Linux, Windows) × 3 Node versions (18, 20, 22)
  - Test types: unit tests, integration tests, security tests (SSRF, path traversal)
  - Deterministic: no network calls in test suite, all mocked
  - Run: `npm test`
  ```
- [ ] Add test type breakdown to docs/ARCHITECTURE.md
- [ ] Verify no flaky tests exist (run suite 3x, compare results)
- [ ] Add `npm run test:unit` and `npm run test:integration` scripts if they don't exist

### 2D. Fix "Architecture needs decomposition"
**Status: PARTIALLY DONE**
- [x] cli.ts decomposed (1,397 → 385 lines + 4 sub-modules)
- [ ] agent.ts decomposition (1,044 lines) — extract:
  - agent/tool-executor.ts (~200 lines): tool execution, parallel batching, cache, audit
  - agent/prompt-builder.ts (~120 lines): buildSystemPrompt(), non-technical detection
  - agent/message-repair.ts (~120 lines): repairToolCallMessages(), validateToolArgs()
  - agent.ts slim: Agent class with run() generator (~500 lines)
- [ ] browser.ts decomposition (886 lines) — extract:
  - tools/browser/connection.ts (~280 lines): BrowserSession, ensureConnected(), Chrome launch
  - tools/browser/actions.ts (~500 lines): 15 action methods
  - tools/browser.ts slim: BrowserTool with execute() dispatch (~120 lines)

### 2E. "Pilot before standardize" → make piloting easy
**Actions:**
- [ ] Ensure `npx codebot-ai` works without global install
- [ ] Add `--demo` flag that runs a self-contained demo on a temp repo
- [ ] Add docker-compose.yml for one-command trial with Ollama included

---

## PRONG 3: PRE-LAUNCH CHECKLIST — Every Item

### Item 1: Unify public claims
**Exact changes needed:**

| Surface | Field | Current | Fix To |
|---------|-------|---------|--------|
| README badge | tests | 1125 | 1217 |
| README badge | tools | 32 | 31 |
| README badge | dependencies | 0 | 1 (or move cord-engine to optional) |
| README heading | tool count | "32 Built-in Tools" | "31 Built-in Tools" |
| README body | test count | "1,168 tests" | "1,217 tests" |
| README tool table | delegate | listed | remove (not registered) |
| README tool table | deep_research | missing | add |
| README connectors | count | 6 | 10 (add Gmail, Calendar, Notion, Drive) |
| ROADMAP | version | 2.1.6 / 2.3.0 | 2.7.7 |
| ROADMAP | tests | 1,035+ | 1,217 |
| ROADMAP | tools | 28 | 31 |
| ROADMAP | npm link | codebot-ai@2.1.6 | codebot-ai@2.7.7 |
| CHANGELOG | duplicates | v2.5.0-2.5.2 3x | remove duplicates |
| Extension pkg | version | 2.0.0 | 2.7.7 |
| Extension pkg | description | "AI-powered coding assistant..." | match wedge |
| Extension pkg | default provider | openai | ollama |
| Action pkg | version | 2.0.0 | 2.7.7 |
| Action yml | description | "autonomous code review..." | match wedge |
| Action yml | default model | claude-sonnet-4-20250514 | verify current |
| package.json | description | "Zero-dependency autonomous AI agent..." | match wedge, fix "zero-dependency" |

### Item 2: Rewrite the opening message
**Current first 3 lines:**
```
# CodeBot AI
### Zero-dependency autonomous AI agent
Your local-first AI coding agent. Runs with Ollama (no API keys)...
```

**Rewrite to:**
```
# CodeBot AI
### The safe, local-first autonomous coding agent

Run AI-assisted development entirely on your machine. No API keys required.
Policy-governed, audit-trailed, sandboxed — built for teams that take
code security seriously.
```

### Item 3: State one wedge clearly
**Wedge:** "Safe local-first autonomous coding agent"
**Apply to:**
- README line 1-3
- package.json description
- Extension description
- Action description
- ROADMAP header
- npm page (via package.json)
- GitHub repo description (Settings → About)

### Item 4: Simplify getting started
**Create this exact section in README:**
```markdown
## Quick Start

# Install
npm install -g codebot-ai

# Auto-detects Ollama, LM Studio, or cloud providers
codebot --setup

# Start coding
codebot "explain what this project does"

# Or launch the dashboard
codebot --dashboard
```

### Item 5: Add one real demo
**Actions:**
- [ ] Record a terminal GIF showing:
  1. `codebot "find and fix the bug in src/utils.ts"`
  2. Agent reads file, identifies issue, proposes fix
  3. Agent writes fix, runs tests, confirms passing
- [ ] Save as `docs/demo.gif` (keep under 5MB)
- [ ] Embed in README after Quick Start section
- [ ] Alternative: create an SVG terminal recording using `svg-term-cli` or `asciinema`

### Item 6: Surface trust signals
**Add to README after badges:**
```markdown
**Tested:** 1,217 tests | 3 OS × 3 Node versions | `npm test`
**Platforms:** macOS, Linux, Windows
**Status:** Active development, regular releases
```

### Item 7: Surface safety early
**Move security section UP in README — it's currently buried at line 200+.**
**Create a condensed "Safety" section right after Quick Start:**
```markdown
## Built for Safety

| Layer | What It Does |
|-------|-------------|
| Policy Engine | Define what the agent can and cannot do |
| Risk Scoring | Every tool call scored 0-100 before execution |
| Audit Trail | Tamper-evident SHA-256 chain of all actions |
| Sandbox | Docker isolation for untrusted operations |
| Permission Model | Interactive approval for risky operations |
| Secret Detection | Prevents accidental credential exposure |
```

### Item 8: Add comparison section
**docs/COMPARISON.md exists (7,701 bytes) — good.**
**Actions:**
- [ ] Add a condensed "Why CodeBot?" section to README linking to full comparison:
  ```markdown
  ## Why CodeBot vs. Alternatives?

  | | CodeBot | Copilot | Cursor | Claude Code |
  |---|---------|---------|--------|-------------|
  | Self-hosted | Yes | No | No | No |
  | Any LLM | Yes (8) | GPT only | Mixed | Claude only |
  | Policy engine | Yes | No | No | No |
  | Audit trail | Yes | No | No | No |
  | Zero cloud dependency | Yes | No | No | No |
  | Free | MIT | $10-39/mo | $20/mo | $20/mo |

  [Full comparison →](docs/COMPARISON.md)
  ```
- [ ] Update COMPARISON.md to reflect current v2.7.7 capabilities
- [ ] Verify competitor claims are still accurate (March 2026)

### Item 9: Clean repo structure
**Current root has 13 markdown files. Reduce noise.**
**Actions:**
- [ ] Keep in root: README.md, LICENSE, CHANGELOG.md, CONTRIBUTING.md, SECURITY.md
- [ ] Move to docs/: BRANDING.md, CLA.md, DISCLAIMER.md, PRIVACY.md, ROADMAP.md
- [ ] Update any cross-references after moving files
- [ ] Remove or archive stale content in ROADMAP.md
- [ ] Clean CHANGELOG.md duplicate entries

### Item 10: Show proof of maintenance
**Actions:**
- [ ] Ensure CI badge in README is green (already done)
- [ ] Add "Last commit" dynamic badge: `![last commit](https://img.shields.io/github/last-commit/Ascendral/codebot-ai)`
- [ ] Tag and publish v2.7.7 release on GitHub if not done
- [ ] Write release notes for v2.7.7 highlighting hardening work
- [ ] Ensure npm has latest version published

### Item 11: Make extension/action pages consistent
**Actions:**
- [ ] Extension package.json description → match README wedge
- [ ] Extension version → 2.7.7
- [ ] Extension default provider → ollama (not openai)
- [ ] Extension provider options → add all 8 (currently only openai, anthropic)
- [ ] Action action.yml description → match README wedge
- [ ] Action package.json version → 2.7.7
- [ ] Action default model → verify it's current (claude-sonnet-4-20250514 may be outdated)
- [ ] Both should link back to main repo README

### Item 12: Send-out test
**The 30-second cold-landing test. Someone arrives at the repo and must know:**
1. What it does → first 3 lines of README
2. Why they should care → wedge + differentiators
3. How to try it → Quick Start section (4 commands)
4. Whether they can trust it → badges + safety section + CI + test count

**Verify by reading ONLY the above-fold content of README (first 50 lines).**

---

## HOMEPAGE REWRITE STRUCTURE

Apply this exact order to README.md:

1. **Name + one-line value prop** (line 1-3)
2. **Badges** (dynamic: npm version, CI, license, last commit, downloads; static: tests, tools)
3. **Short "why it exists"** (2-3 sentences on the problem)
4. **Key differentiators** (6-item table: self-hosted, any LLM, policy, audit, sandbox, free)
5. **Who it's for** (4 bullet user segments)
6. **60-second quickstart** (install, setup, run, dashboard)
7. **Demo GIF** (terminal workflow recording)
8. **Safety/governance** (condensed table of 6 security layers)
9. **Tool overview** (31 tools grouped by category, not a flat list)
10. **Provider support** (8 providers with logos/links)
11. **Connectors** (10 app integrations)
12. **Comparison table** (vs Copilot/Cursor/Claude Code, link to full doc)
13. **Ecosystem** (CLI + Dashboard + VS Code Extension + GitHub Action)
14. **Testing & reliability** (test count, CI matrix, platforms)
15. **Contributing / License**
16. **Roadmap link**

---

## EXECUTION ORDER

### Wave 1: Truth (fix all lies/inconsistencies) — DO FIRST
1. Fix all README numbers (tools, tests, deps, connectors)
2. Fix ROADMAP numbers
3. Fix CHANGELOG duplicates
4. Fix extension/action versions and descriptions
5. Fix package.json description

### Wave 2: Story (rewrite messaging) — DO SECOND
6. Rewrite README opening (wedge + value prop)
7. Add "Who This Is For" section
8. Add condensed "Why CodeBot?" comparison
9. Move safety section up
10. Add Quick Start section
11. Add Testing section

### Wave 3: Polish (visual proof) — DO THIRD
12. Record demo GIF
13. Add dynamic badges (downloads, last commit, stars)
14. Clean repo root (move files to docs/)
15. Restructure README to homepage order above

### Wave 4: Release (ship it) — DO LAST
16. Tag v2.7.7 release
17. Publish to npm
18. Write release notes
19. Update GitHub repo description
20. Run the 30-second cold-landing test
