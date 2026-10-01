#!/usr/bin/env bash
# Single entry point: installs PocketDesk if it isn't present, or offers to update/remove it if it is.
#   curl -fsSL https://raw.githubusercontent.com/Yash-Awasthi/PocketDesk/master/pocketdesk.sh | bash
#   bash pocketdesk.sh [--uninstall] [--purge]
# Just dispatches to install.sh / uninstall.sh — see those for what each does.
set -euo pipefail
INSTALL_DIR="${POCKETDESK_DIR:-$HOME/.pocketdesk}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
RAW="https://raw.githubusercontent.com/Yash-Awasthi/PocketDesk/master"
UNINSTALL=false
PASSTHROUGH=()
for arg in "$@"; do
  case "$arg" in
    --uninstall) UNINSTALL=true ;;
    *) PASSTHROUGH+=("$arg") ;;
  esac
done

fetch_script() {
  # Local checkout has it next to this file; piped from curl, fetch it alongside.
  local name="$1" local_path="$HERE/$1"
  if [ -f "$local_path" ]; then echo "$local_path"; return; fi
  local tmp="$(mktemp -t "$1.XXXXXX")"
  curl -fsSL "$RAW/$name" -o "$tmp"
  echo "$tmp"
}

installed=false
[ -d "$INSTALL_DIR/daemon" ] && installed=true

if $UNINSTALL; then
  if ! $installed; then echo "PocketDesk is not installed."; exit 0; fi
  bash "$(fetch_script uninstall.sh)" "${PASSTHROUGH[@]}"
  exit 0
fi

if ! $installed; then
  bash "$(fetch_script install.sh)" "${PASSTHROUGH[@]}"
  exit 0
fi

echo "PocketDesk is already installed in $INSTALL_DIR."
read -r -p "[U]pdate, [R]emove, or [C]ancel? " choice
case "$choice" in
  [Uu]*) bash "$(fetch_script install.sh)" "${PASSTHROUGH[@]}" ;;
  [Rr]*) bash "$(fetch_script uninstall.sh)" "${PASSTHROUGH[@]}" ;;
  *) echo "Cancelled." ;;
esac
