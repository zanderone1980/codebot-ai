# Compliance Mapping

**Purpose:** map CodeBot AI's actual built-in controls to specific clauses in SOC 2, HIPAA, and NIST 800-53 so security and compliance teams can evaluate the tool against their existing framework. **No aspirational claims** — every row points at code that exists today, or honestly says "gap."

**Scope:** This is a developer-tool compliance map for the agent itself, not a full GRC posture for an organization deploying it. Using CodeBot does not make your organization compliant; it gives you specific control evidence you can include in your own audit.

**Last reviewed against source:** 2026-04-15 (commits `424af1a` and earlier on `main`).

---

## What CodeBot actually provides

Verified by inspecting `src/risk.ts`, `src/audit.ts`, `src/sarif.ts`, `src/policy.ts`, `src/sandbox.ts`, and `src/constitutional/`:

| Control surface | Implementation | Source file | Configurable per-project? |
|---|---|---|---|
| Hash-chained audit log | SHA-256 chain over each `AuditEntry` (timestamp, sessionId, sequence, tool, action, args, result) | `src/audit.ts` | No — always on |
| SARIF 2.1.0 export | `exportSarif(entries) → SarifLog`; converts the audit log to the OASIS SARIF format consumed by GitHub Code Scanning, Defender for DevOps, etc. | `src/sarif.ts` | Yes — opt-in via `--export-audit sarif` |
| Risk scoring (per tool call) | 7 named factors: `constitutional`, `permission_level`, `file_path`, `command`, `network`, `data_volume`, `cumulative` → green / yellow / orange / red | `src/risk.ts` | Yes — thresholds in `policy.json` |
| Policy engine | YAML/JSON policy controlling tool allow-list, filesystem scope, secret patterns, git workflow, MCP servers, limits, RBAC roles | `src/policy.ts` (+ `src/policy-presets.ts`) | Yes — `.codebot/policy.json` per project |
| Constitutional safety engine | Pluggable rule engine that evaluates each tool call against named principles before execution | `src/constitutional/` | Yes — rules registered via adapter |
| Sandboxed execution | Optional Docker isolation for shell tools | `src/sandbox.ts` | Yes — opt-in via policy |
| Secret detection | Pattern-based scanning before any tool call that could exfiltrate secrets; `block_on_detect` policy halts on match | `src/policy.ts` `PolicySecrets` | Yes |
| Local-first LLM support | Ollama / LM Studio / vLLM via OpenAI-compatible adapter — no code leaves the machine | `src/providers/openai.ts` + registry | Yes — set `model` to a local one |

## What CodeBot does NOT provide (be honest)

These are real gaps. Don't paper over them in a CISO conversation:

- **No SSO / SAML / OIDC.** It's a CLI; authentication is OS-level (the user running it).
- **No multi-tenant RBAC at the install level.** The `PolicyRbac` block is for tool-permission roles within a project, not "user A vs user B." Each install is single-user.
- **No FIPS 140-2 validated crypto.** Uses Node.js `crypto` module (SHA-256 is correct algorithm but the implementation isn't a FIPS-validated module — matters if you're FedRAMP/DoD).
- **No FedRAMP authorization.** Achievable only via formal accreditation process by the deploying organization; the project itself can't be "FedRAMP approved."
- **Hash chain is local-only.** A determined attacker with disk write access could rebuild the chain. For tamper-evident audit you need to ship the chain to immutable external storage (S3 Object Lock, Cloudflare R2 with retention, write-once log appliance).
- **No vendor SOC 2 report.** This is an open-source project, not a SaaS company. There's no SOC 2 to share. Compensating control: read the source, run `--verify-audit`, deploy on hardware you control.
- **MIT license, no enterprise support contract.** If your procurement requires a paid support contract for any tool that touches code, that's a procurement gap, not a technical one.

---

## SOC 2 — Trust Services Criteria mapping

| TSC | Criterion | CodeBot provides | Evidence |
|---|---|---|---|
| **CC6.1** | Logical access controls protect against unauthorized access | Policy engine restricts tool allow-list, filesystem scope, network egress | `src/policy.ts` — `PolicyTools.enabled/disabled`, `PolicyFilesystem.allow/deny` |
| **CC6.6** | Logical access removal upon termination | **N/A** — single-user OS-level access; org-level user lifecycle is upstream |
| **CC6.7** | Restricts transmission of data | Local-first LLM option means code never leaves machine; sandbox isolates shell exec | `src/sandbox.ts`, provider registry |
| **CC7.1** | System monitoring detects anomalies | Risk scorer evaluates each tool call; thresholds trigger blocks | `src/risk.ts` `RiskScorer.score()` |
| **CC7.2** | Anomalies are evaluated for security incidents | Risk level `red` blocks execution; logged as `policy_block` / `constitutional_block` action | `AuditEntry.action` enum |
| **CC7.3** | Incident response procedures | Audit chain enables forensic reconstruction; `--verify-audit` proves chain integrity | `src/audit.ts`, `bin/codebot --verify-audit` |
| **CC8.1** | Change management before deployment to production | All file modifications captured in audit; SARIF export integrates with PR review (GitHub Code Scanning) | `src/sarif.ts` + `actions/codebot/` |
| **CC8.1** | (continued) — segregation of duties | Policy `roles` allow per-role tool permissions; `human_approval_required` actions force human gate | `PolicyRbac`, `PolicyConstitutional` |

## HIPAA Technical Safeguards (45 CFR §164.312) mapping

| Safeguard | Requirement | CodeBot provides | Evidence |
|---|---|---|---|
| **§164.312(a)(1)** | Access control | Policy-based tool allow-list and filesystem scope per project | `src/policy.ts` |
| **§164.312(a)(2)(i)** | Unique user identification | Each session has a unique `sessionId`; OS user is the principal | `AuditLogger.sessionId` |
| **§164.312(a)(2)(iv)** | Encryption / decryption | **Partial** — TLS to LLM provider when applicable; at-rest encryption is OS-level (FileVault / LUKS / BitLocker), not provided by CodeBot |
| **§164.312(b)** | Audit controls | Hash-chained audit log of every tool call: timestamp, action, args, result | `src/audit.ts` `AuditEntry` schema |
| **§164.312(c)(1)** | Integrity controls | SHA-256 hash chain detects tampering of any prior entry; `--verify-audit` reports integrity | `src/audit.ts` `prevHash`, `GENESIS_HASH` |
| **§164.312(d)** | Person or entity authentication | **N/A** — single-user CLI; auth is OS-level |
| **§164.312(e)(1)** | Transmission security | Local-LLM mode = zero PHI transmission; cloud-LLM mode = TLS to provider's API only | Provider registry, no other network egress except declared tool calls |
| **§164.312(e)(2)(i)** | Integrity (transmission) | Hash chain protects audit; tool result integrity is delegated to TLS for cloud providers | `src/providers/*.ts` |

**Caveat for HIPAA:** Using CodeBot with a cloud LLM provider that is NOT a HIPAA Business Associate means you're shipping PHI to a third party that hasn't signed a BAA. Local-LLM mode is the only path that keeps PHI inside your trust boundary without a signed BAA. CodeBot does not validate this for you — the deploying organization owns this decision.

## NIST 800-53 (Rev 5) mapping

Selected controls most relevant to an AI coding agent:

| Control | Description | CodeBot provides | Evidence |
|---|---|---|---|
| **AC-3** | Access enforcement | Policy engine enforces tool allow-list and filesystem scope at the agent level | `src/policy.ts` |
| **AC-4** | Information flow enforcement | Network egress is per-declared-tool-call; sandbox can isolate further | `src/sandbox.ts` |
| **AC-6** | Least privilege | Per-role tool permissions; per-project capability declarations | `PolicyRbac`, `PolicyTools.capabilities` |
| **AU-2** | Audit events | Every tool call generates an `AuditEntry` with action type | `src/audit.ts` |
| **AU-3** | Content of audit records | Schema includes timestamp, sessionId, sequence, tool, action, args, result, reason | `AuditEntry` interface |
| **AU-9** | Protection of audit information | SHA-256 hash chain detects in-place tampering; rotation creates a new chain per session | `src/audit.ts` |
| **AU-9(3)** | Cryptographic protection | SHA-256 (per `crypto.createHash('sha256')`); not FIPS-validated implementation | `src/audit.ts` (gap noted above) |
| **AU-12** | Audit generation | Automatic for all tool calls | `AuditLogger.append()` |
| **CM-3** | Configuration change control | All file edits captured in audit; `policy.git.always_branch` forces work onto a feature branch | `PolicyGit` |
| **IA-2** | Identification and authentication | **N/A** — OS-level |
| **RA-3** | Risk assessment | `RiskScorer.score()` evaluates each tool call against 7 weighted factors | `src/risk.ts` |
| **SC-7** | Boundary protection | Sandbox container, policy network allow-list | `src/sandbox.ts`, `PolicyExecution` |
| **SI-4** | System monitoring | Risk scoring + audit log | `src/risk.ts` + `src/audit.ts` |
| **SI-7** | Software, firmware, and information integrity | Hash chain on audit; SARIF export feeds into upstream code-scanning systems | `src/sarif.ts` |

## ISO/IEC 42001 (AI management system) — partial mapping

ISO 42001 was published 2023 and is becoming the AI-specific compliance reference. CodeBot's relevant controls:

| Annex A control | What it asks | CodeBot provides |
|---|---|---|
| **A.6.2** AI policy | Documented policy for AI use | Policy file format is documented; `--init-policy` generates a starting policy |
| **A.7.4** AI system impact assessment | Document risk of AI decisions | Risk scoring per tool call; SARIF + audit gives evidence trail |
| **A.8.2** Data quality and governance | Control inputs to AI systems | Filesystem scope, secret detection, MCP server allow-list |
| **A.9.2** AI system verification and validation | Test outputs before deployment | Solve pipeline runs project tests before opening PR; `policy.git.require_tests_before_commit` |

---

## How to use this document

**For internal audit / compliance team:**
- Each row's "Evidence" column points at a real source file. Read it, run it locally (`codebot --init-policy && codebot --verify-audit`), and form your own opinion.
- For controls marked "Partial" or "N/A," document the compensating control your org provides (e.g., FileVault for at-rest encryption, your IdP for user identity).

**For a CISO conversation:**
- Lead with the audit chain — that's the strongest single artifact. `--verify-audit` produces a deterministic boolean: chain intact or not.
- Bring up the gaps yourself before they do. Trust comes from being honest about what you don't have.
- If they need an org-level SOC 2 report, this isn't the right tool — they want a SaaS vendor with a Type II report. CodeBot is a self-hosted CLI; the audit they're doing is of THEIR deployment of it.

**For framework crosswalk to other standards** (PCI-DSS, FedRAMP, CMMC, etc.):
- Most of those frameworks reference NIST 800-53 directly or via mapping. Start with the NIST table above and use your existing framework-to-NIST crosswalk.
- If you need a specific control mapped that isn't here, open an issue with the control text and we'll add it (or tell you honestly it's not provided).

---

## Verification commands

```bash
# Generate a starting policy file you can show your auditor
codebot --init-policy

# Inspect the policy schema in code
cat src/policy.ts | grep -A 5 "interface Policy"

# After a session, verify the audit log hash chain is intact
codebot --verify-audit

# Export the audit log as SARIF for GitHub Code Scanning / Defender for DevOps
codebot --export-audit sarif > codebot-audit.sarif

# Check what risk factors are evaluated (verifies our 7-dimension claim)
grep "name: '" src/risk.ts | sort -u
```

If any of those commands produce output that contradicts what's documented above, this file is wrong — open an issue.
