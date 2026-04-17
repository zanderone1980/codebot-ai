# CodeBot AI on SWE-bench Verified — 1-task resolved, Docker-scored, 2026-04-16

> **Status**: smoke, not benchmark. N=1. Published as proof that the full pipeline — gen_predictions + Docker evaluation — runs end-to-end with a *real pass*. A 50-task run using this same pipeline kicked off at 20:28:34 on the same day; its result will supersede this document.

## Result

| Metric | Value |
|---|---|
| Dataset | `princeton-nlp/SWE-bench_Verified`, split `test` |
| Instances submitted | **1** |
| Instances completed | **1** |
| **Instances resolved (test suite passed)** | **1** ✓ |
| Instances unresolved | 0 |
| Instances with errors | 0 |
| Empty patches | 0 |
| Wall time — generation | 44.2 s |
| Wall time — Docker evaluation | 2:46 |
| Patch size | 1,653 bytes |
| API tokens | ~130,000 |
| API cost | ~$0.27 (gpt-5.4 via Responses API) |
| Model | `gpt-5.4` (resolved to `gpt-5.4-2026-03-05`) |
| CodeBot version | 2.10.0 |
| Run ID | `smoke-docker` |
| Docker runtime | Colima 0.10.1 / Docker 29.4.0 / vz + Rosetta 2 (Apple Silicon) |

## What CodeBot did (task `astropy__astropy-12907`)

Problem statement: *"`separability_matrix` does not compute separability correctly for nested CompoundModels."*

CodeBot ran its autonomous agent loop with gpt-5.4 via the Responses API. Twelve iterations, fourteen tool calls, 1,653-byte patch including a new regression test. The harness then cloned astropy at the base commit (`d16bfe05`), pulled the pre-built `sweb.eval.x86_64.astropy__astropy-12907` Docker image, applied CodeBot's patch, and executed the repo's test suite inside the container.

Result: **all designated FAIL_TO_PASS tests now pass, all PASS_TO_PASS tests still pass.**

## Why this matters

Earlier the same task with `gpt-4o-mini` produced an empty diff (the default harness model). With `gpt-5.4` via the new Responses API provider, CodeBot engaged end-to-end and produced a fix that survives the real test suite.

This also confirms the full stack:
- Provider: `OpenAIResponsesProvider` → `/v1/responses` endpoint
- Harness: `gen_predictions.py` → git-clone + `codebot --auto --model gpt-5.4` + `git diff`
- Scoring: `eval.sh` → official `swebench.harness.run_evaluation` with Colima Docker

## Reproducing

```bash
cd bench/swe
source .venv/bin/activate
export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"

python3 gen_predictions.py \
  --dataset princeton-nlp/SWE-bench_Verified \
  --instance-ids astropy__astropy-12907 \
  --model gpt-5.4 \
  --output predictions-smoke.json \
  --timeout-sec 300

bash eval.sh predictions-smoke.json smoke-docker
```

Full report JSON: `codebot-ai-2.10.0.smoke-docker.json` in the repo root after running.
