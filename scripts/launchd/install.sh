#!/usr/bin/env bash
# ═══════════════════════════════════════════════════════════════════════
# FODZE launchd install — macOS daily/weekly cron
# ═══════════════════════════════════════════════════════════════════════
# Substitutes the __REPO_PATH__ + __HOME__ placeholders in the .plist
# files and installs them to ~/Library/LaunchAgents.
#
# Usage:
#   bash scripts/launchd/install.sh          # install both agents
#   bash scripts/launchd/install.sh --daily  # just the daily (no injuries)
#   bash scripts/launchd/install.sh --full   # just the full weekly
#   bash scripts/launchd/install.sh --uninstall
# ═══════════════════════════════════════════════════════════════════════

set -euo pipefail

REPO_PATH="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
PLIST_DIR="$REPO_PATH/scripts/launchd"
AGENTS_DIR="$HOME/Library/LaunchAgents"
mkdir -p "$AGENTS_DIR"

DAILY_LABEL="com.fodze.refresh"
FULL_LABEL="com.fodze.refresh.full"

MODE="${1:-both}"

uninstall_agent() {
  local label="$1"
  local dest="$AGENTS_DIR/$label.plist"
  if [[ -f "$dest" ]]; then
    launchctl unload "$dest" 2>/dev/null || true
    rm "$dest"
    echo "✓ Removed $label"
  fi
}

install_agent() {
  local label="$1"
  local src="$PLIST_DIR/$label.plist"
  local dest="$AGENTS_DIR/$label.plist"
  if [[ ! -f "$src" ]]; then
    echo "✗ Source plist not found: $src"
    return 1
  fi
  # Substitute placeholders inline to the target path
  sed \
    -e "s|__REPO_PATH__|$REPO_PATH|g" \
    -e "s|__HOME__|$HOME|g" \
    "$src" > "$dest"
  # Unload if already loaded, then load fresh
  launchctl unload "$dest" 2>/dev/null || true
  launchctl load "$dest"
  echo "✓ Installed $label"
}

case "$MODE" in
  --uninstall)
    uninstall_agent "$DAILY_LABEL"
    uninstall_agent "$FULL_LABEL"
    echo ""
    echo "Done. Verify:  launchctl list | grep com.fodze"
    ;;
  --daily)
    install_agent "$DAILY_LABEL"
    ;;
  --full)
    install_agent "$FULL_LABEL"
    ;;
  both|--both|"")
    install_agent "$DAILY_LABEL"
    install_agent "$FULL_LABEL"
    ;;
  *)
    echo "Unknown mode: $MODE"
    echo "Usage: $0 [--daily|--full|--both|--uninstall]"
    exit 1
    ;;
esac

echo ""
echo "Schedule summary:"
echo "  • $DAILY_LABEL       daily 07:30      (npm run refresh, ~3 min)"
echo "  • $FULL_LABEL  Tue+Fri 19:00    (npm run refresh:full, ~25 min)"
echo ""
echo "Logs go to:"
echo "  ~/Library/Logs/fodze-refresh.log"
echo "  ~/Library/Logs/fodze-refresh-full.log"
echo ""
echo "Check they're registered:"
echo "  launchctl list | grep com.fodze"
echo ""
echo "Trigger one manually to test:"
echo "  launchctl start $DAILY_LABEL"
