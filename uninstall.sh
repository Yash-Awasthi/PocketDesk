#!/usr/bin/env bash
# Removes the PocketDesk daemon, its autostart, and the control CLI on macOS/Linux.
#   bash uninstall.sh [--purge]   (--purge also deletes the paired token and config)
set -euo pipefail
INSTALL_DIR="${POCKETDESK_DIR:-$HOME/.pocketdesk}"
PURGE=false
for a in "$@"; do [ "$a" = "--purge" ] && PURGE=true; done

# Stop the running daemon first so its port and files are released.
"$INSTALL_DIR/bin/pocketdesk" stop 2>/dev/null || true

case "$(uname -s)" in
  Darwin)
    AGENT="$HOME/Library/LaunchAgents/com.pocketdesk.tray.plist"
    launchctl unload "$AGENT" 2>/dev/null || true
    rm -f "$AGENT"
    pkill -f PocketDeskTray 2>/dev/null || true
    ;;
  Linux)
    systemctl --user disable --now pocketdesk 2>/dev/null || true
    rm -f "$HOME/.config/systemd/user/pocketdesk.service"
    systemctl --user daemon-reload 2>/dev/null || true
    ;;
esac

rm -f "$HOME/.local/bin/pocketdesk"
rm -rf "$INSTALL_DIR/daemon" "$INSTALL_DIR/bin"

if $PURGE; then
  rm -rf "$INSTALL_DIR"
  echo "PocketDesk removed, including the paired token."
else
  echo "PocketDesk removed. The token/config stays in $INSTALL_DIR (use --purge to delete)."
fi
