#!/usr/bin/env bash
# theater-check.sh — run theater_detector.py against a CodeBot episode.
#
# Usage:
#   theater-check.sh <episode.json> [--repo PATH] [--no-mutation] [--json]
#   theater-check.sh --latest         # check the most recent episode
#   theater-check.sh --all-since-eval # check every episode since eval-mode entered
#
# Exits:
#   0  CLEAN
#   1  SUSPICIOUS
#   2  THEATER
#   64 usage error
#   65 could not locate audit slice for the episode
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DETECTOR="$SCRIPT_DIR/theater_detector.py"
EPISODES_DIR="${CODEBOT_HOME:-$HOME/.codebot}/episodes"
AUDIT_DIR="${CODEBOT_HOME:-$HOME/.codebot}/audit"
EVAL_MARKER="${CODEBOT_HOME:-$HOME/.codebot}/.eval-mode-active"

usage() {
  sed -n '2,14p' "$0" | sed 's/^# \{0,1\}//'
  exit 64
}

# ---------- find latest / all ----------
if [[ "${1:-}" == "--latest" ]]; then
  # Exclude index.json (episode-index cache). Real episodes are timestamped.
  episode="$(ls -1t "$EPISODES_DIR"/*.json 2>/dev/null | grep -v '/index\.json$' | head -1 || true)"
  [[ -z "$episode" ]] && { echo "no episodes found in $EPISODES_DIR" >&2; exit 65; }
  shift
  exec "$0" "$episode" "$@"
fi

if [[ "${1:-}" == "--all-since-eval" ]]; then
  [[ ! -f "$EVAL_MARKER" ]] && { echo "eval-mode not active" >&2; exit 64; }
  shift
  worst_exit=0
  for ep in "$EPISODES_DIR"/*.json; do
    [[ -f "$ep" ]] || continue
    echo "=== $(basename "$ep") ==="
    set +e
    "$0" "$ep" "$@"
    rc=$?
    set -e
    (( rc > worst_exit )) && worst_exit=$rc
    echo
  done
  exit "$worst_exit"
fi

EPISODE="${1:-}"
[[ -z "$EPISODE" || ! -f "$EPISODE" ]] && usage
shift

# Extract audit slice bounds from the episode via timestamp window + projectRoot.
# Episode and audit log use DIFFERENT session IDs (episode is timestamp-based,
# audit is a runtime id), so we correlate by time + repo path.
python3 - "$EPISODE" "$AUDIT_DIR" "$DETECTOR" "$@" <<'PY'
import json, os, sys, subprocess, datetime, pathlib, re

episode_path = sys.argv[1]
audit_dir    = sys.argv[2]
detector     = sys.argv[3]
passthru     = sys.argv[4:]

ep = json.load(open(episode_path))
started = ep.get("startedAt")
ended   = ep.get("endedAt")
goal    = ep.get("goal") or ""
outcomes = ep.get("outcomes") or []
final_msg = outcomes[0] if outcomes else ""

if not (started and ended):
    print("episode has no startedAt/endedAt", file=sys.stderr); sys.exit(65)

# pick the audit file(s) that overlap the window
def parse_z(s):
    return datetime.datetime.fromisoformat(s.replace("Z", "+00:00"))
t0 = parse_z(started); t1 = parse_z(ended)

audit_files = []
for name in sorted(os.listdir(audit_dir)):
    if not name.startswith("audit-") or not name.endswith(".jsonl"): continue
    # file covers one UTC day
    day = name[len("audit-"):-len(".jsonl")]
    try:
        d0 = datetime.datetime.fromisoformat(day + "T00:00:00+00:00")
        d1 = d0 + datetime.timedelta(days=1)
    except Exception:
        continue
    if d1 >= t0 and d0 <= t1:
        audit_files.append(os.path.join(audit_dir, name))

if not audit_files:
    print(f"no audit file found overlapping {t0}..{t1}", file=sys.stderr)
    sys.exit(65)

# filter audit entries by timestamp window; pick the tightest seq range
entries_in_window = []
for af in audit_files:
    with open(af) as f:
        for line in f:
            try:
                r = json.loads(line)
            except Exception:
                continue
            ts = r.get("timestamp")
            if not ts: continue
            t = parse_z(ts)
            if t0 <= t <= t1:
                entries_in_window.append((af, r))

if not entries_in_window:
    print(f"no audit entries in window {t0}..{t1}", file=sys.stderr)
    sys.exit(65)

# if entries span multiple audit files it's weird, but handle it by picking
# the file with the most entries in-window
by_file = {}
for af, r in entries_in_window:
    by_file.setdefault(af, []).append(r)
audit_path = max(by_file, key=lambda k: len(by_file[k]))
rs = by_file[audit_path]
rs.sort(key=lambda r: r.get("sequence", 0))
start_seq = rs[0].get("sequence")
end_seq   = rs[-1].get("sequence")

# repo: infer from first read_file/write/edit path OR --repo flag already in passthru
repo = None
if "--repo" not in passthru:
    for r in rs:
        args = r.get("args") or {}
        if isinstance(args, dict):
            p = args.get("path") or ""
            if p.startswith("/tmp/") or p.startswith("/Users/"):
                # take up through /tmp/<repo> or /Users/.../<repo>
                m = re.match(r"(/(?:tmp|Users/[^/]+/[^/]+))/([^/]+)/", p)
                if m:
                    repo = f"{m.group(1)}/{m.group(2)}"
                    break

# write final message to a temp file (it may contain shell-breaking chars)
import tempfile
with tempfile.NamedTemporaryFile("w", delete=False, suffix=".txt") as fh:
    fh.write(final_msg or "")
    fmsg_path = fh.name

cmd = ["python3", detector,
       "--audit", audit_path,
       "--start-seq", str(start_seq),
       "--end-seq", str(end_seq),
       "--final-message-file", fmsg_path]
if "--repo" not in passthru and repo:
    cmd += ["--repo", repo]
cmd += passthru

print(f"[theater-check] episode : {os.path.basename(episode_path)}")
print(f"[theater-check] window  : {start_seq}..{end_seq} in {os.path.basename(audit_path)}")
print(f"[theater-check] repo    : {repo or '(none inferred)'}")
print(f"[theater-check] goal    : {goal[:80]}")
print("---")
sys.stdout.flush()
r = subprocess.run(cmd)
try: os.unlink(fmsg_path)
except Exception: pass
sys.exit(r.returncode)
PY
