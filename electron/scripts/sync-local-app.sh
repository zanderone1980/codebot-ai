#!/usr/bin/env bash
#
# sync-local-app.sh — Rebuild CodeBot AI and swap the local install.
#
# Fast path: no notarization, no DMG, no Apple notary queue. Just rebuilds
# the .app from current source and replaces ~/Applications/CodeBot AI.app
# so the app on the user's dock always reflects the latest code.
#
# Total time: ~30-90 seconds (TS build + electron-builder dir + cp).
#
# For a release-quality notarized DMG, use a separate command:
#   CODEBOT_FORCE_NOTARIZE=1 npm run build:dmg   (in electron/)
#
# Usage:
#   bash electron/scripts/sync-local-app.sh
#   # or wired through post-commit git hook (auto)

set -euo pipefail

PROJECT_ROOT="$(git rev-parse --show-toplevel 2>/dev/null || echo "")"
if [ -z "$PROJECT_ROOT" ]; then
  echo "[sync-local-app] not inside a git repo — aborting" >&2
  exit 1
fi

APP_NAME="CodeBot AI"
INSTALL_PATH="$HOME/Applications/$APP_NAME.app"
BUILD_OUTPUT="$PROJECT_ROOT/electron/dist/mac-arm64/$APP_NAME.app"
LOG_TS_BUILD="/tmp/codebot-sync-ts.log"
LOG_EL_BUILD="/tmp/codebot-sync-electron.log"

echo "[sync-local-app] $(date '+%Y-%m-%d %H:%M:%S') start"

# 1. Quit running app (if any) so we can replace its bundle.
WAS_RUNNING=0
if pgrep -f "Applications/$APP_NAME.app/Contents/MacOS" > /dev/null 2>&1; then
  echo "[sync-local-app] quitting running app..."
  osascript -e "tell application \"$APP_NAME\" to quit" > /dev/null 2>&1 || true
  WAS_RUNNING=1
  # Wait up to 10s for clean exit, then force.
  for i in 1 2 3 4 5 6 7 8 9 10; do
    pgrep -f "Applications/$APP_NAME.app/Contents/MacOS" > /dev/null 2>&1 || break
    sleep 1
  done
  if pgrep -f "Applications/$APP_NAME.app/Contents/MacOS" > /dev/null 2>&1; then
    echo "[sync-local-app] forcing kill..."
    pkill -9 -f "Applications/$APP_NAME.app/Contents/MacOS" || true
    sleep 1
  fi
fi

# 2. Build TypeScript (root project).
echo "[sync-local-app] building TS (root)..."
cd "$PROJECT_ROOT"
if ! npm run build > "$LOG_TS_BUILD" 2>&1; then
  echo "[sync-local-app] TS build FAILED — see $LOG_TS_BUILD" >&2
  tail -20 "$LOG_TS_BUILD" >&2
  exit 1
fi

# 3. Build Electron .app (no DMG, no notarize — fast).
echo "[sync-local-app] building Electron .app (dir target)..."
cd "$PROJECT_ROOT/electron"
if ! npm run build:dir > "$LOG_EL_BUILD" 2>&1; then
  echo "[sync-local-app] Electron build FAILED — see $LOG_EL_BUILD" >&2
  tail -20 "$LOG_EL_BUILD" >&2
  exit 1
fi

# 4. Verify build output exists.
if [ ! -d "$BUILD_OUTPUT" ]; then
  echo "[sync-local-app] expected build output not found: $BUILD_OUTPUT" >&2
  exit 1
fi

# 5. Swap the install in place. Make sure ~/Applications exists.
mkdir -p "$HOME/Applications"
echo "[sync-local-app] replacing $INSTALL_PATH"
rm -rf "$INSTALL_PATH"
cp -R "$BUILD_OUTPUT" "$HOME/Applications/"

# 6. Relaunch only if it had been running before (don't surprise-launch
#    if user had it closed on purpose).
if [ "$WAS_RUNNING" = "1" ]; then
  echo "[sync-local-app] relaunching..."
  open "$INSTALL_PATH"
fi

# 7. Print verification line so the user can grep the log later.
INSTALLED_TS=$(stat -f '%Sm' "$INSTALL_PATH" 2>/dev/null || echo unknown)
ELECTRON_VER=$(defaults read "$INSTALL_PATH/Contents/Frameworks/Electron Framework.framework/Resources/Info.plist" CFBundleVersion 2>/dev/null || echo unknown)
APP_VER=$(defaults read "$INSTALL_PATH/Contents/Info.plist" CFBundleShortVersionString 2>/dev/null || echo unknown)
echo "[sync-local-app] DONE — installed at $INSTALLED_TS, app=$APP_VER, electron=$ELECTRON_VER"
