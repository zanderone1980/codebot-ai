#!/usr/bin/env bash
#
# install-git-hook.sh — Wire post-commit auto-sync into .git/hooks/.
#
# Idempotent: safe to run multiple times. After every git commit that
# touches src/ or electron/, sync-local-app.sh runs in the background to
# rebuild the .app and replace ~/Applications/CodeBot AI.app.
#
# Run once after cloning the repo:
#   bash electron/scripts/install-git-hook.sh

set -euo pipefail

PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "")"
if [ -z "$PROJECT_ROOT" ]; then
  echo "[install-git-hook] not inside a git repo — aborting" >&2
  exit 1
fi

HOOK_PATH="$PROJECT_ROOT/.git/hooks/post-commit"
SYNC_SCRIPT_REL="electron/scripts/sync-local-app.sh"

# If a post-commit hook already exists and isn't ours, back it up.
if [ -e "$HOOK_PATH" ] && ! grep -q "codebot-sync-marker" "$HOOK_PATH" 2>/dev/null; then
  BACKUP="$HOOK_PATH.backup.$(date +%s)"
  echo "[install-git-hook] backing up existing hook to $BACKUP"
  mv "$HOOK_PATH" "$BACKUP"
fi

cat > "$HOOK_PATH" <<'EOF'
#!/usr/bin/env bash
# codebot-sync-marker — auto-installed by electron/scripts/install-git-hook.sh
#
# After every commit, if the commit touched src/ or electron/, kick off a
# background rebuild + reinstall so ~/Applications/CodeBot AI.app stays
# current. Output goes to /tmp/codebot-sync.log.

set -e

PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "")"
[ -z "$PROJECT_ROOT" ] && exit 0

CHANGED=$(git log -1 --name-only --pretty=format:)
if echo "$CHANGED" | grep -qE '^(src/|electron/)'; then
  echo "[post-commit] code changed in src/ or electron/ — syncing local app in background"
  nohup bash "$PROJECT_ROOT/electron/scripts/sync-local-app.sh" \
    > /tmp/codebot-sync.log 2>&1 &
  echo "[post-commit] sync PID $! — tail /tmp/codebot-sync.log to watch"
else
  echo "[post-commit] no src/ or electron/ changes in this commit, skipping app sync"
fi

exit 0
EOF

chmod +x "$HOOK_PATH"

echo "[install-git-hook] installed: $HOOK_PATH"
echo "[install-git-hook] sync script: $PROJECT_ROOT/$SYNC_SCRIPT_REL"
echo "[install-git-hook] log file:    /tmp/codebot-sync.log"
echo ""
echo "Test it: make a trivial change in src/, commit, then check the log:"
echo "  tail -f /tmp/codebot-sync.log"
