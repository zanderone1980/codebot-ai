#!/usr/bin/env bash
# eval-mode.sh — isolate CodeBot's cross-session memory during adversarial evals.
#
# CodeBot's cross-session.ts injects the 3 most-recent episode outcomes into every
# new chat's system prompt (see getRecentEpisodes / buildPromptBlock). That means
# a "fresh chat" is NOT a cold start — it sees recent successes/failures as context.
# During adversarial evaluation we need true cold starts to measure the model's
# actual judgment rather than cached outcomes.
#
# This script swaps ~/.codebot/episodes out for an empty dir (and quarantines
# lessons.db) for the duration of an eval, then restores on exit.
#
# Usage:
#   ./eval-mode.sh enter   # backup + empty episodes/lessons; ready for eval
#   ./eval-mode.sh exit    # restore previous state
#   ./eval-mode.sh status  # show current mode
#   ./eval-mode.sh audit   # run theater-check.sh on every episode recorded
#                          #   during the current eval (or last eval if inactive)
#
# Safety: this does NOT touch anything else under ~/.codebot. Config, audit logs,
# sessions, and workspace are untouched. Refuses to enter twice or exit when not
# entered.

set -euo pipefail

CODEBOT_DIR="${HOME}/.codebot"
EPISODES_DIR="${CODEBOT_DIR}/episodes"
LESSONS_DB="${CODEBOT_DIR}/lessons.db"
MARKER="${CODEBOT_DIR}/.eval-mode-active"

cmd="${1:-status}"

case "$cmd" in
  enter)
    if [ -f "$MARKER" ]; then
      echo "eval-mode: ALREADY ACTIVE (marker at $MARKER)"
      cat "$MARKER"
      exit 1
    fi
    ts="$(date +%Y%m%d-%H%M%S)"
    backup_dir="${CODEBOT_DIR}/eval-backup-${ts}"
    mkdir -p "$backup_dir"

    if [ -d "$EPISODES_DIR" ]; then
      mv "$EPISODES_DIR" "${backup_dir}/episodes"
      mkdir -p "$EPISODES_DIR"
      echo "  episodes → ${backup_dir}/episodes  (new empty episodes/)"
    fi

    if [ -f "$LESSONS_DB" ]; then
      cp "$LESSONS_DB" "${backup_dir}/lessons.db"
      for sidecar in "${LESSONS_DB}-shm" "${LESSONS_DB}-wal"; do
        [ -f "$sidecar" ] && cp "$sidecar" "${backup_dir}/$(basename "$sidecar")"
      done
      # Leave lessons.db in place but clear rows — easier than swapping sqlite sidecars.
      sqlite3 "$LESSONS_DB" "DELETE FROM lessons;"
      echo "  lessons.db → backed up to ${backup_dir}/lessons.db, table cleared"
    fi

    cat > "$MARKER" <<MARKEREOF
eval-mode active since $(date -u +%Y-%m-%dT%H:%M:%SZ)
backup_dir=${backup_dir}
MARKEREOF
    echo ""
    echo "EVAL MODE ACTIVE. Cold starts only. Run ./eval-mode.sh exit when done."
    ;;

  exit)
    if [ ! -f "$MARKER" ]; then
      echo "eval-mode: NOT ACTIVE (no marker)"
      exit 1
    fi
    backup_dir="$(grep '^backup_dir=' "$MARKER" | cut -d= -f2)"
    if [ ! -d "$backup_dir" ]; then
      echo "eval-mode: backup dir missing ($backup_dir). Refusing to destroy eval state."
      echo "Resolve manually."
      exit 2
    fi

    # Save the eval-era episodes for inspection, then restore
    eval_episodes="${backup_dir}/eval-era-episodes"
    if [ -d "$EPISODES_DIR" ]; then
      mv "$EPISODES_DIR" "$eval_episodes"
      echo "  eval-era episodes archived at $eval_episodes"
    fi
    mv "${backup_dir}/episodes" "$EPISODES_DIR"
    echo "  episodes restored from $backup_dir"

    if [ -f "${backup_dir}/lessons.db" ]; then
      cp "${backup_dir}/lessons.db" "$LESSONS_DB"
      for sidecar in lessons.db-shm lessons.db-wal; do
        [ -f "${backup_dir}/${sidecar}" ] && cp "${backup_dir}/${sidecar}" "${CODEBOT_DIR}/${sidecar}"
      done
      echo "  lessons.db restored from $backup_dir"
    fi

    rm "$MARKER"
    echo ""
    echo "EVAL MODE EXITED. Backup preserved at $backup_dir (delete manually when sure)."
    ;;

  status)
    if [ -f "$MARKER" ]; then
      echo "eval-mode: ACTIVE"
      cat "$MARKER"
      echo ""
      echo "episodes in play:"
      ls "$EPISODES_DIR" | wc -l | xargs echo "  count:"
      echo "lessons rows:"
      sqlite3 "$LESSONS_DB" "SELECT COUNT(*) FROM lessons;" | xargs echo "  "
    else
      echo "eval-mode: inactive"
      echo "episodes: $(ls "$EPISODES_DIR" 2>/dev/null | wc -l | xargs)"
      echo "lessons:  $(sqlite3 "$LESSONS_DB" "SELECT COUNT(*) FROM lessons;" 2>/dev/null)"
    fi
    ;;

  audit)
    # Run theater-check.sh on every episode recorded during the current (or most
    # recent) eval session. Aggregates exit codes: 2 (theater) beats 1
    # (suspicious) beats 0 (clean). Per CLAUDE.md anti-theater protocol: no
    # claim of eval success without this pass being clean or reviewed.
    THEATER_CHECK="$(dirname "$0")/theater-check.sh"
    if [ ! -x "$THEATER_CHECK" ]; then
      echo "theater-check.sh not found next to eval-mode.sh: $THEATER_CHECK" >&2
      exit 2
    fi

    # Resolve which episodes dir to audit.
    target_dir=""
    if [ -f "$MARKER" ]; then
      # eval currently active — audit the live episodes directory
      target_dir="$EPISODES_DIR"
      echo "eval-mode: ACTIVE — auditing live episodes at $target_dir"
    else
      # find the newest eval-backup-*/eval-era-episodes
      latest_backup="$(ls -1dt "${CODEBOT_DIR}"/eval-backup-*/eval-era-episodes 2>/dev/null | head -1 || true)"
      if [ -z "$latest_backup" ]; then
        echo "no eval sessions found (no active marker, no eval-era-episodes)" >&2
        exit 2
      fi
      target_dir="$latest_backup"
      echo "eval-mode: inactive — auditing previous eval at $target_dir"
    fi

    count=0; worst_exit=0
    for ep in "$target_dir"/*.json; do
      [ -f "$ep" ] || continue
      count=$((count + 1))
      echo ""
      echo "=== $(basename "$ep") ==="
      set +e
      "$THEATER_CHECK" "$ep" --no-mutation
      rc=$?
      set -e
      [ "$rc" -gt "$worst_exit" ] && worst_exit=$rc
    done

    echo ""
    if [ "$count" -eq 0 ]; then
      echo "no episodes to audit in $target_dir"
      exit 0
    fi
    echo "audited $count episode(s); worst verdict exit=$worst_exit"
    case "$worst_exit" in
      0) echo "  OVERALL: CLEAN" ;;
      1) echo "  OVERALL: SUSPICIOUS" ;;
      2) echo "  OVERALL: THEATER DETECTED" ;;
      *) echo "  OVERALL: unexpected ($worst_exit)" ;;
    esac
    exit "$worst_exit"
    ;;

  *)
    echo "usage: $0 {enter|exit|status|audit}"
    exit 1
    ;;
esac
