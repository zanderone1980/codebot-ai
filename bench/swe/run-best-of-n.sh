#!/usr/bin/env bash
# Tier 3.1 — best-of-N (pass@K) sampling for SWE-bench Verified.
#
# Runs gen_predictions K times on the same task slice, evaluates each run
# independently, then computes pass@K (a task counts as resolved if it
# resolves in ANY of the K runs).
#
# This is honest: it doesn't fake a "best patch picker" — without working
# test signal in the harness venv (Tier 2.1 v1 limitation) we can't score
# patches before submission. Pass@K just lets us see how much variance
# there is and what the model could plausibly hit if we had perfect
# patch-selection.
#
# Cost: K x baseline. For K=3 on 50 tasks that's ~3x ($30-45) and ~3x wall
# time (~4 hrs gen + ~1 hr eval). Don't run this casually.
#
# Usage:
#   bash run-best-of-n.sh <K> <max_instances> [model]
# Example:
#   bash run-best-of-n.sh 3 50 gpt-5.4
set -euo pipefail

cd "$(dirname "$0")"
source .venv/bin/activate
export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"

K="${1:-3}"
N="${2:-10}"
MODEL="${3:-gpt-5.4}"

if [ "$K" -lt 1 ] || [ "$K" -gt 10 ]; then
  echo "ERROR: K must be 1..10 (got $K)" >&2
  exit 2
fi

TS=$(date +%Y%m%d-%H%M%S)
SUITE="bestofn-K${K}-N${N}-$TS"
LOG_DIR="/tmp/$SUITE"
mkdir -p "$LOG_DIR"

echo "# best-of-N: K=$K samples × N=$N tasks = $((K*N)) gen invocations"
echo "# model:  $MODEL"
echo "# logs:   $LOG_DIR/"
echo "# start:  $(date)"
echo ""

# Phase 1: K independent gen runs
for k in $(seq 1 "$K"); do
  PRED="predictions-$SUITE-sample$k.json"
  echo "## sample $k/$K — generating predictions ($PRED)"
  python3 gen_predictions.py \
    --dataset princeton-nlp/SWE-bench_Verified \
    --max-instances "$N" \
    --model "$MODEL" \
    --output "$PRED" \
    --timeout-sec 300 \
    > "$LOG_DIR/sample$k-gen.log" 2>&1
  echo "   gen done — $(grep -c "^OK" "$LOG_DIR/sample$k-gen.log" || echo 0) succeeded"
done

# Phase 2: K independent evals
for k in $(seq 1 "$K"); do
  PRED="predictions-$SUITE-sample$k.json"
  RUN_ID="$SUITE-sample$k"
  echo "## sample $k/$K — evaluating ($RUN_ID)"
  bash eval.sh "$PRED" "$RUN_ID" > "$LOG_DIR/sample$k-eval.log" 2>&1 || true
done

# Phase 3: pass@K analysis
echo ""
echo "=== pass@K analysis ==="
python3 - <<PYEOF
import json, glob, sys
from collections import defaultdict

K = $K
suite = "$SUITE"

per_task_resolved = defaultdict(set)  # instance_id -> set of sample_ids that resolved it
all_tasks = set()

for k in range(1, K+1):
    pattern = f"codebot-ai-2.10.0.{suite}-sample{k}.json"
    files = glob.glob(pattern)
    if not files:
        print(f"  sample {k}: no report file", file=sys.stderr)
        continue
    r = json.load(open(files[0]))
    all_tasks.update(r.get("completed_ids", []))
    # Walk per-task reports for resolved bit
    import os
    for path in glob.glob(f"logs/run_evaluation/{suite}-sample{k}/codebot-ai-2.10.0/*/report.json"):
        tid = path.split("/")[-2]
        all_tasks.add(tid)
        try:
            inner = json.load(open(path)).get(tid, {})
            if inner.get("resolved"):
                per_task_resolved[tid].add(k)
        except Exception:
            pass

# Compute resolved counts per K threshold
print(f"  total tasks (any sample completed): {len(all_tasks)}")
for k_threshold in range(1, K+1):
    resolved_at_k = sum(1 for t in all_tasks if len(per_task_resolved[t]) >= k_threshold)
    print(f"  pass@>={k_threshold}: {resolved_at_k}/{len(all_tasks)} = {100*resolved_at_k/max(len(all_tasks),1):.1f}%")

# pass@K (any sample resolved it)
resolved_any = sum(1 for t in all_tasks if per_task_resolved[t])
print(f"  pass@K (any of {K}): {resolved_any}/{len(all_tasks)} = {100*resolved_any/max(len(all_tasks),1):.1f}%")

# Variance: how many tasks were SOMETIMES solved (1 <= k < K)?
sometimes = sum(1 for t in all_tasks if 0 < len(per_task_resolved[t]) < K)
always = sum(1 for t in all_tasks if len(per_task_resolved[t]) == K)
never = sum(1 for t in all_tasks if not per_task_resolved[t])
print(f"  always resolved (consistent): {always}")
print(f"  sometimes resolved (variance): {sometimes}")
print(f"  never resolved (hard fails):   {never}")
PYEOF

echo ""
echo "# done: $(date)"
echo "# logs: $LOG_DIR/"
