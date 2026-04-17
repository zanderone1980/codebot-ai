#!/usr/bin/env bash
# Full 50-task SWE-bench Verified run.
# Generates predictions with gpt-5.4, then Docker-evaluates them.
# Logs to /tmp/swe50-{gen,eval,final}.log so progress is tailable from anywhere.
# Touches /tmp/swe50-DONE on success, /tmp/swe50-FAIL on error.
set -euo pipefail

cd "$(dirname "$0")"
source .venv/bin/activate
export DOCKER_HOST="unix://$HOME/.colima/default/docker.sock"

TS=$(date +%Y%m%d-%H%M%S)
RUN_ID="verified-50-$TS"
PRED="predictions-$RUN_ID.json"
GEN_LOG="/tmp/swe50-gen.log"
EVAL_LOG="/tmp/swe50-eval.log"
FINAL_LOG="/tmp/swe50-final.log"

rm -f /tmp/swe50-DONE /tmp/swe50-FAIL

{
  echo "=== PHASE 1: generate predictions (50 tasks, gpt-5.4) ==="
  date
  time python3 gen_predictions.py \
    --dataset princeton-nlp/SWE-bench_Verified \
    --max-instances 50 \
    --model gpt-5.4 \
    --output "$PRED" \
    --timeout-sec 300 2>&1
  echo ""
  echo "=== gen complete ==="
  date
} > "$GEN_LOG" 2>&1 || { touch /tmp/swe50-FAIL; echo "gen phase failed" > "$FINAL_LOG"; exit 1; }

{
  echo "=== PHASE 2: Docker evaluation ==="
  date
  time bash eval.sh "$PRED" "$RUN_ID" 2>&1
  echo ""
  echo "=== eval complete ==="
  date
} > "$EVAL_LOG" 2>&1 || { touch /tmp/swe50-FAIL; echo "eval phase failed" > "$FINAL_LOG"; exit 1; }

# Summarize the result from the harness report
REPORT="codebot-ai-2.10.0.$RUN_ID.json"
if [ -f "$REPORT" ]; then
  python3 -c "
import json, sys
d = json.load(open('$REPORT'))
with open('$FINAL_LOG','w') as f:
  f.write(f'run_id: {d.get(\"run_id\",\"?\")}\n')
  f.write(f'total_instances: {d.get(\"total_instances\",0)}\n')
  f.write(f'submitted_instances: {d.get(\"submitted_instances\",0)}\n')
  f.write(f'completed_instances: {d.get(\"completed_instances\",0)}\n')
  f.write(f'resolved_instances: {d.get(\"resolved_instances\",0)}\n')
  f.write(f'unresolved_instances: {d.get(\"unresolved_instances\",0)}\n')
  f.write(f'empty_patch_instances: {d.get(\"empty_patch_instances\",0)}\n')
  f.write(f'error_instances: {d.get(\"error_instances\",0)}\n')
  sub = d.get('submitted_instances',0) or 1
  pct = 100.0 * d.get('resolved_instances',0) / sub
  f.write(f'pass_rate_of_submitted: {pct:.1f}%\n')
"
else
  echo "no report file at $REPORT" > "$FINAL_LOG"
fi

touch /tmp/swe50-DONE
echo "done"
