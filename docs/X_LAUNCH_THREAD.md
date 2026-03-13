# X Launch Thread — @alexpinkone

Copy each numbered post below. Post #1 first, then reply to it with #2, etc.

---

## POST 1 (Pin this)

I built an open-source safety runtime for AI agents.

Most agents run tools with zero enforcement. No policy checks. No audit trail. No secret blocking.

CORD fixes that. 3 lines of code. Zero dependencies.

npm install cord-engine

github.com/Ascendral/artificial-persistent-intelligence

🧵

---

## POST 2

The problem: every AI coding agent can run shell commands, write files, make HTTP requests.

None of them check what they're about to do.

Your agent could rm -rf /, exfiltrate .env files, or curl your SSH keys to an external server.

CORD evaluates every action BEFORE it executes.

---

## POST 3

How it works:

```js
const cord = require('cord-engine');
const result = cord.evaluate({ text: "rm -rf /" });
// result.decision = "BLOCK"
// result.score = 95
// result.hardBlock = true
```

14 safety dimensions. Prompt injection detection. Secret blocking. Scope enforcement. Tamper-evident audit logs.

---

## POST 4

It blocks real attacks:

- Direct jailbreaks ("ignore all instructions")
- Base64 encoded payloads
- Zero-width character injection
- DAN mode attempts
- Privilege escalation (sudo chmod 777)
- Data exfiltration (curl secrets to external servers)
- Moral violations (extortion, impersonation)

Try it: npx cord-engine demo

---

## POST 5

It's not just a filter. It's a full enforcement pipeline:

INPUT → VIGIL PRE-SCAN → HARD-BLOCK → SCORED RISKS → SCOPE CHECK → AUDIT LOG → VERDICT

4 decision levels: ALLOW, CONTAIN, CHALLENGE, BLOCK

Every decision is hash-chained in an audit trail.

---

## POST 6

Drop-in adapters for the frameworks you're already using:

- cord.wrapOpenAI(client)
- cord.wrapAnthropic(client)
- cord.frameworks.wrapLangChain(model)
- cord.frameworks.wrapCrewAgent(agent)
- cord.frameworks.wrapAutoGenAgent(agent)

Python equivalents included.

---

## POST 7

I also built CodeBot AI — a full autonomous coding agent powered by CORD.

32 tools. Swarm mode (multiple LLMs collaborating). Web dashboard. Works with any provider — Ollama, GPT, Claude, Gemini.

npm install -g codebot-ai

github.com/Ascendral/codebot-ai

---

## POST 8

Who this is for:

- Teams building AI agents that touch real systems
- Platform engineers adding controls to agent workflows
- Anyone who needs an audit trail for AI actions
- Devs who want local-first AI coding with actual safety

---

## POST 9

Both packages are MIT licensed. Zero dependencies. npm install and go.

cord-engine — the safety runtime (SDK)
codebot-ai — the agent that uses it (CLI)

If you're building agents without enforcement, you're shipping a liability.

Star the repo. Try the demo. Ship with confidence.

---

## FOLLOW-UP POSTS (use throughout the week)

### Day 2
Fun fact: CORD catches base64-encoded payloads nested TWO levels deep.

Most "safety" layers check the raw text. CORD normalizes through 7 deobfuscation layers before scoring.

npx cord-engine demo

### Day 3
"But I trust my LLM not to do bad things"

Your LLM is one prompt injection away from running whatever an attacker wants. CORD doesn't trust the model. It validates the ACTION.

### Day 4
Every CORD decision gets a SHA-256 hash-chained audit entry. PII is auto-redacted. Logs can be AES-256 encrypted.

Built for teams that need compliance, not just vibes.

### Day 5
Zero dependencies means zero supply chain risk.

cord-engine has no transitive deps. No node_modules black hole. Just evaluated, audited policy enforcement.

### Day 6
You can tune everything. Weights, thresholds, regex patterns, high-impact verbs, tool risk tiers.

Edit policies.js. That's it. No YAML. No config services. One file.

### Day 7
Shipped CodeBot AI v2.7.7 this week:
- API key validation during setup
- Config persistence across updates
- Dashboard error display fixes

Building in public. Every commit on GitHub.
