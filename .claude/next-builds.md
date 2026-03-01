# Next Builds — v2.2.0 → v2.3.0

**Previous builds (completed):** v2.1.6 (caching, vision, routing, JSON mode) + v2.2.0-alpha (orchestrator)

**Current state:** 586 tests, 0 failures, v2.1.6 on npm, orchestrator committed on main.

---

## Phase 1: Code Quality & Stability (v2.2.0)

### Build 1: Standardize Error Handling

**Why:** Tools are inconsistent — some throw, some return error strings. This makes agent.ts fragile and debugging hard.

**Files:**
- `src/tools/read.ts` — Change thrown errors to returned error strings (match write.ts pattern)
- `src/tools/edit.ts` — Same: return error strings instead of throwing
- `src/tools/batch-edit.ts` — Audit and standardize
- `src/tools/browser.ts` — Replace empty catch blocks with proper error handling + logging
- `src/tools/execute.ts` — Same
- `src/agent.ts` — Simplify error handling now that all tools return consistently
- `src/history.ts` — Replace empty catches with logged fallbacks
- `src/audit.ts` — Same

**Pattern:** All `tool.execute()` methods return `string` on success or `"Error: <message>"` on failure. Never throw. Agent loop doesn't need try/catch for tool calls.

**Tests:** Verify each standardized tool returns error strings for invalid inputs (not throws)

**Gate:** Build clean, 600+ tests

---

### Build 2: Constants, Performance & Secret Filtering

**Why:** Magic numbers scattered everywhere, regex recompiled on every call, newer provider keys not filtered.

**Files:**
- `src/context/manager.ts` — Extract `RESERVED_FOR_OUTPUT = 2048`, `RESERVED_FOR_SYSTEM = 1500`, `RESERVED_FOR_TOOLS = 2000`, `TOKENS_PER_IMAGE = 1000`, `CHARS_PER_TOKEN = 3.5` as named constants
- `src/orchestrator.ts` — Extract defaults as named constants
- `src/router.ts` — Same for word count thresholds
- `src/security.ts` — Pre-compile BLOCKED_PATTERNS as static class property (compile once)
- `src/tools/execute.ts` — Pre-compile 40+ regex patterns at module level (not per-call)
- `src/secrets.ts` — Add patterns for GROQ_API_KEY, MISTRAL_API_KEY, XAI_API_KEY
- `src/tools/execute.ts` — Add GROQ_API_KEY, MISTRAL_API_KEY, XAI_API_KEY to env filtering
- `src/cache.ts` — Use hash-based cache keys instead of JSON.stringify

**Tests:** Secret detection for new providers, perf benchmark for regex pre-compilation

**Gate:** Build clean, 615+ tests

---

### Build 3: High-Priority Tool Tests

**Why:** 22+ tools have no dedicated tests. These 6 are highest risk.

**New test files:**
- `src/tools/batch-edit.test.ts` — Multi-file atomic edits, partial failure rollback, path validation
- `src/tools/database.test.ts` — SELECT allowed, DROP/DELETE blocked, SQL injection prevention
- `src/tools/docker.test.ts` — Container commands, image validation, socket access control
- `src/tools/ssh-remote.test.ts` — Connection handling, key validation, command injection prevention
- `src/tools/package-manager.test.ts` — Install/uninstall, malicious package detection, lock file handling
- `src/tools/git.test.ts` — Status, diff, commit, branch, force-push blocking

**Gate:** Build clean, 660+ tests

---

### Build 4: Remaining Tool Tests

**Why:** Get to comprehensive test coverage for all 28 tools.

**New test files:**
- `src/tools/code-analysis.test.ts` — Symbol extraction, import tracing
- `src/tools/code-review.test.ts` — Security scanning, complexity scoring
- `src/tools/diff-viewer.test.ts` — File comparison, git diff parsing
- `src/tools/glob.test.ts` — Pattern matching, symlink safety
- `src/tools/grep.test.ts` — Regex search, binary file skipping
- `src/tools/http-client.test.ts` — Auth headers, SSRF blocking
- `src/tools/image-info.test.ts` — PNG/JPEG/GIF/SVG metadata
- `src/tools/multi-search.test.ts` — Fuzzy matching, result ranking
- `src/tools/notification.test.ts` — Webhook payload, URL validation
- `src/tools/pdf-extract.test.ts` — Text extraction, page ranges
- `src/tools/routine.test.ts` — Cron parsing, scheduling, timeout enforcement
- `src/tools/task-planner.test.ts` — Task CRUD, priority ordering
- `src/tools/think.test.ts` — Basic passthrough
- `src/tools/web-search.test.ts` — Query sanitization, result parsing

**Gate:** Build clean, 720+ tests, every tool file has a corresponding test

---

## Phase 2: README & Discoverability (v2.2.1)

### Build 5: README Overhaul

**Why:** README is the #1 conversion tool. Currently good but missing killer elements.

**Changes to README.md:**

1. **Add badges row** (right after title):
   - npm version (already have)
   - tests passing: `![tests](https://img.shields.io/badge/tests-586%20passing-brightgreen)`
   - coverage badge (if we add it)
   - zero dependencies: `![dependencies](https://img.shields.io/badge/dependencies-0-brightgreen)`
   - downloads badge

2. **Move Supported Models table** up to right after Quick Start (before Usage section)

3. **Add "Quick Local Start" block** after Quick Start:
   ```
   ## Quick Local Start (Ollama)
   ollama pull qwen2.5-coder
   npm install -g codebot-ai
   codebot --setup    # select "ollama", model "qwen2.5-coder"
   ```

4. **Add Troubleshooting section** with common errors:
   - "Chrome not launching" → install Chrome or set CHROME_PATH
   - "Context overflow" → use /compact or reduce --max-iterations
   - "Rate limit hit" → auto-retries, or switch to local model
   - "ENOENT: no such file" → check projectRoot / cwd
   - "Connection refused (Ollama)" → ensure `ollama serve` is running

5. **Add Comparison section** — short table vs Aider, Open Interpreter, Cursor, Continue.dev:
   | Feature | CodeBot AI | Aider | Open Interpreter | Cursor |
   |---------|-----------|-------|------------------|--------|
   | Zero dependencies | ✅ | ❌ | ❌ | ❌ |
   | Local LLM support | ✅ | ✅ | ✅ | ❌ |
   | Security/RBAC | ✅ | ❌ | ❌ | ❌ |
   | Browser automation | ✅ | ❌ | ✅ | ❌ |
   | VS Code extension | ✅ | ❌ | ❌ | ✅ |
   | Audit trail | ✅ | ❌ | ❌ | ❌ |

6. **Update version references** — README says "v2.1.5" in Security section, update to current

7. **Update test count** — "469+ tests" → "720+ tests" (after Phase 1)

8. **Link ROADMAP.md prominently** — add "See our [Roadmap](ROADMAP.md) for what's next" after Architecture section

**Gate:** README renders correctly on GitHub, all links valid

---

### Build 6: ROADMAP Update & GitHub Repo Polish

**Why:** ROADMAP.md is stale (still says v2.1.0 is "next"), need to update for current state and create enhancement issues for visibility.

**Files:**
- `ROADMAP.md` — Update:
  - Mark v2.1.0 through v2.1.6 as SHIPPED with actual dates/test counts
  - Mark multi-agent orchestration as SHIPPED
  - Add v2.2.0 (current) and v2.3.0 (next) sections
  - Update competitive position stats (test count, tool count, etc.)
  - Add "Near-term priorities" section for contributors

- `CONTRIBUTORS.md` (NEW) — Template with contribution guidelines, thanks section

- **GitHub Issues** (create via `gh issue create`):
  1. "Add OpenHands-style browser eval harness"
  2. "Support image/vision models for screenshot analysis" (mark as done)
  3. "Add `--dry-run` / `--estimate` flag for cost prediction"
  4. "Add provider-aware rate limiting"
  5. "Per-tool cost breakdown in /metrics"
  6. "Streaming response display (token-by-token output)"

**Gate:** ROADMAP matches reality, 6+ open enhancement issues on GitHub

---

## Phase 3: UX & Reliability (v2.2.2)

### Build 7: Cost Transparency

**Why:** Users need to know what a run will cost before committing. No one wants surprise $20 bills.

**Files:**
- `src/telemetry.ts` — Add `estimateRunCost(taskDescription, model)` using average tokens-per-tool-call heuristics
- `src/cli.ts` — Add `--dry-run` flag: runs planning phase only, shows estimated tokens/tools/cost
- `src/cli.ts` — Add `--estimate` flag: alias for --dry-run
- `src/cli.ts` — Enhance `/usage` to show per-tool cost breakdown
- `src/agent.ts` — Track cost per tool in metrics
- `src/context/manager.ts` — Make compaction threshold configurable via config.json: `"compactionThreshold": 0.85`

**Tests:** Cost estimation accuracy, --dry-run exits cleanly, per-tool breakdown formatting

**Gate:** Build clean, 740+ tests

---

### Build 8: Browser Resilience

**Why:** CDP is powerful but fragile. Chrome version mismatches, headless issues, and page crashes cause silent failures.

**Files:**
- `src/browser/cdp.ts` — Add auto-reconnect on WebSocket close/error (3 retries with backoff)
- `src/tools/browser.ts` — Add fallback to fetch-only mode when Chrome unavailable
- `src/tools/browser.ts` — Better error messages: "Chrome not found at path X — install Chrome or set CHROME_PATH env var"
- `src/tools/browser.ts` — Fix global state coupling: create BrowserSession class instead of module-level variables
- `src/tools/browser.ts` — Add `lastScreenshotData` to BrowserSession (not module export)
- `src/agent.ts` — Update browser screenshot handling to use BrowserSession

**Tests:** Reconnect on disconnect, fallback mode, error messages, concurrent session isolation

**Gate:** Build clean, 760+ tests

---

### Build 9: VS Code Extension Polish

**Why:** Extension exists but needs better documentation and screenshot in README.

**Files:**
- `README.md` — Add VS Code section with:
  - Screenshot placeholder comment (user adds actual screenshot)
  - Feature list: sidebar chat, inline diff, status bar, theme integration
  - Link to Marketplace (if published) or build instructions
  - Note on token usage display, interrupt button

- `vscode-extension/README.md` (if exists) — Update with current features

**Gate:** VS Code section in README is clear and complete

---

## Phase 4: Version Bump & Publish

### Build 10: Ship v2.2.0

**Files:**
- `package.json` — Bump to 2.2.0
- `src/index.ts` — Update VERSION
- `src/cli.ts` — Update version string
- `CHANGELOG.md` — Full v2.2.0 entry covering all 9 builds

**Release:**
- `git tag v2.2.0 && git push --tags`
- `npm publish`
- Verify on npmjs.com

**Gate:** 760+ tests, 0 failures, clean build, published to npm

---

## Build Order & Version Plan

| Build | Name | Version | Test Target | Focus |
|-------|------|---------|-------------|-------|
| 1 | Standardize Error Handling | 2.2.0-alpha.1 | 600+ | Code quality |
| 2 | Constants, Perf & Secrets | 2.2.0-alpha.2 | 615+ | Code quality |
| 3 | High-Priority Tool Tests | 2.2.0-alpha.3 | 660+ | Test coverage |
| 4 | Remaining Tool Tests | 2.2.0-alpha.4 | 720+ | Test coverage |
| 5 | README Overhaul | 2.2.0-beta.1 | 720+ | Discoverability |
| 6 | ROADMAP & GitHub Polish | 2.2.0-beta.2 | 720+ | Discoverability |
| 7 | Cost Transparency | 2.2.0-rc.1 | 740+ | UX |
| 8 | Browser Resilience | 2.2.0-rc.2 | 760+ | Reliability |
| 9 | VS Code Section | 2.2.0-rc.3 | 760+ | Discoverability |
| 10 | Ship v2.2.0 | 2.2.0 | 760+ | Release |

## Post-Release: Community & Marketing (Manual Steps)

These are things the developer does themselves, not code changes:

1. **Record 2-4 demo screencasts** (30-60 seconds each):
   - CLI fixing a real bug
   - Browser automation session
   - VS Code inline edits
   - Routine scheduling

2. **Post on social/community**:
   - X/Twitter thread showcasing real sessions
   - Reddit: r/LocalLLaMA, r/MachineLearning, r/programming
   - Hacker News: "Show HN: CodeBot AI — zero-dep autonomous coding agent"
   - Dev.to / Hashnode blog post

3. **GitHub visibility**:
   - Pin repo to profile
   - Add topics: ai-agent, autonomous-coding, developer-tools
   - Star from personal accounts to seed social proof
   - Respond to any issues/discussions within 24h

4. **Demo GIFs in README** — after recording screencasts, add GIF at top of README

---

## Release Checklist

- [ ] Each build: `npm run build && npm test` before moving on
- [ ] Update CHANGELOG.md incrementally
- [ ] Bump version in package.json, src/index.ts, src/cli.ts at the end
- [ ] `git tag v2.2.0 && git push --tags` → triggers release pipeline
- [ ] Verify npm publish + GitHub Release
- [ ] Create enhancement issues on GitHub for visibility
