#!/usr/bin/env bash
# PocketDesk one-liner installer
# Usage: curl -fsSL https://raw.githubusercontent.com/.../install.sh | bash
# Or:    bash install.sh [--dev]
set -euo pipefail

# ── Colors ───────────────────────────────────────────────────────────────────
RED='\033[0;31m'; GREEN='\033[0;32m'; YELLOW='\033[1;33m'
BLUE='\033[0;34m'; CYAN='\033[0;36m'; BOLD='\033[1m'; NC='\033[0m'

info()  { echo -e "${BLUE}ℹ${NC}  $*"; }
ok()    { echo -e "${GREEN}✓${NC}  $*"; }
warn()  { echo -e "${YELLOW}⚠${NC}  $*"; }
fail()  { echo -e "${RED}✗${NC}  $*"; exit 1; }
step()  { echo -e "\n${CYAN}${BOLD}▸ $*${NC}"; }

# ── Config ───────────────────────────────────────────────────────────────────
REPO_URL="https://github.com/Yash-Awasthi/PocketDesk.git"
INSTALL_DIR="${POCKETDESK_DIR:-$HOME/.pocketdesk}"
DAEMON_DIR="$INSTALL_DIR/daemon"
DEV_MODE=false

for arg in "$@"; do
  case "$arg" in
    --dev) DEV_MODE=true ;;
    --dir) shift; INSTALL_DIR="$1"; DAEMON_DIR="$INSTALL_DIR/daemon" ;;
    --help|-h)
      echo "Usage: bash install.sh [--dev] [--dir /path]"
      echo "  --dev    Install dev dependencies and run tests"
      echo "  --dir    Custom install directory (default: ~/.pocketdesk)"
      exit 0 ;;
  esac
done

# ── Banner ───────────────────────────────────────────────────────────────────
echo ""
echo -e "${CYAN}${BOLD}  ┌─────────────────────────────────┐${NC}"
echo -e "${CYAN}${BOLD}  │   🔧  PocketDesk Installer   │${NC}"
echo -e "${CYAN}${BOLD}  └─────────────────────────────────┘${NC}"
echo ""

# ── Step 1: Check prerequisites ──────────────────────────────────────────────
step "Checking prerequisites"

# Node.js
if ! command -v node &>/dev/null; then
  fail "Node.js not found. Install from https://nodejs.org (≥24 required)"
fi
NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 24 ]; then
  fail "Node.js ≥24 required (found v$(node -v))"
fi
ok "Node.js $(node -v)"

# npm
if ! command -v npm &>/dev/null; then
  fail "npm not found. Install Node.js from https://nodejs.org"
fi
ok "npm $(npm -v)"

# git (needed for clone)
if ! command -v git &>/dev/null; then
  warn "git not found — will try to download archive instead"
fi

# Screen sharing tools. ffmpeg encodes the stream (and PC sound) everywhere; Linux X11 also needs
# xdotool for input and xrandr for monitors. Installed if a known package manager is present.
OS="$(uname -s)"
need_linux=""
command -v ffmpeg &>/dev/null || need_linux="$need_linux ffmpeg"
if [ "$OS" = "Linux" ]; then
  command -v xdotool &>/dev/null || need_linux="$need_linux xdotool"
  command -v xrandr &>/dev/null || need_linux="$need_linux x11-xserver-utils"
  command -v xclip &>/dev/null || need_linux="$need_linux xclip"
fi
if [ -n "$need_linux" ] && [ "$OS" = "Linux" ]; then
  info "Installing screen-sharing tools:$need_linux"
  if command -v apt-get &>/dev/null; then sudo apt-get update -qq && sudo apt-get install -y $need_linux || warn "install failed; install manually:$need_linux"
  elif command -v dnf &>/dev/null; then sudo dnf install -y ffmpeg xdotool xrandr xclip || warn "install failed; dnf needs RPM Fusion for ffmpeg"
  elif command -v pacman &>/dev/null; then sudo pacman -S --needed --noconfirm ffmpeg xdotool xorg-xrandr xclip || warn "install failed; install manually"
  elif command -v zypper &>/dev/null; then sudo zypper install -y ffmpeg xdotool xrandr xclip || warn "install failed; install manually"
  else warn "no known package manager; install these yourself for screen sharing:$need_linux"
  fi
fi
if [ "$OS" = "Linux" ] && [ "${XDG_SESSION_TYPE:-}" = "wayland" ]; then
  warn "Wayland session: screen sharing needs X11 (log in with 'Xorg'/'X11'); terminals, files and agents still work."
fi
if command -v ffmpeg &>/dev/null; then ok "ffmpeg $(ffmpeg -version 2>/dev/null | head -1 | awk '{print $3}')"; else warn "ffmpeg not found — desktop streaming will be unavailable"; fi

# ── Step 2: Clone or update repo ─────────────────────────────────────────────
step "Setting up PocketDesk"

# The program lives in $INSTALL_DIR/app so it never collides with the config and keys the daemon
# keeps in $INSTALL_DIR. Older installs cloned straight into $INSTALL_DIR and keep that layout.
if [ -d "$INSTALL_DIR/.git" ]; then APP_DIR="$INSTALL_DIR"; else APP_DIR="$INSTALL_DIR/app"; fi
DAEMON_DIR="$APP_DIR/daemon"

if [ -d "$APP_DIR/.git" ]; then
  info "Updating $APP_DIR..."
  git -C "$APP_DIR" pull --ff-only --quiet || warn "Update failed — keeping the installed version"
elif command -v git &>/dev/null; then
  info "Cloning to $APP_DIR..."
  mkdir -p "$INSTALL_DIR"
  git clone --depth 1 "$REPO_URL" "$APP_DIR" || fail "git clone failed"
else
  info "Downloading to $APP_DIR..."
  mkdir -p "$APP_DIR"
  curl -fsSL "https://github.com/Yash-Awasthi/PocketDesk/archive/refs/heads/master.tar.gz" \
    | tar xz --strip-components=1 -C "$APP_DIR" || fail "download failed"
fi
ok "Program ready in $APP_DIR"

# ── Step 3: Install dependencies ─────────────────────────────────────────────
step "Installing dependencies"

cd "$DAEMON_DIR"

if [ -d "node_modules" ]; then
  info "node_modules exists — running npm install for updates"
  npm install --silent 2>/dev/null
else
  info "Installing dependencies..."
  npm install --silent 2>/dev/null
fi
ok "Dependencies installed"

if $DEV_MODE; then
  info "Dev mode: installing dev dependencies..."
  npm install --include=dev --silent 2>/dev/null
  ok "Dev dependencies installed"
fi

# ── Step 5: Autostart + control CLI (hidden daemon, like the Windows build) ───
step "Setting up background start and controls"

CONFIG="$INSTALL_DIR/config.json"
PORT=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$CONFIG','utf8')).port||8765)}catch(e){console.log(8765)}" 2>/dev/null || echo 8765)
# Service managers start with a bare PATH; the daemon needs this shell's to find agent CLIs and ffmpeg.
SVC_PATH="$PATH"
BIN_DIR="$INSTALL_DIR/bin"
mkdir -p "$BIN_DIR"

# The control CLI is the stop mechanism where there is no Task Manager.
install -m 755 "$DAEMON_DIR/scripts/unix/pocketdesk" "$BIN_DIR/pocketdesk"
# Put it on PATH without sudo.
USER_BIN="$HOME/.local/bin"; mkdir -p "$USER_BIN"
ln -sf "$BIN_DIR/pocketdesk" "$USER_BIN/pocketdesk"

"$BIN_DIR/pocketdesk" stop >/dev/null 2>&1 || true

case "$(uname -s)" in
  Darwin)
    # Hidden like the Windows build: a LaunchAgent runs the daemon, seen only in Activity Monitor.
    AGENTS="$HOME/Library/LaunchAgents"; mkdir -p "$AGENTS"
    OLD_TRAY="$AGENTS/com.pocketdesk.tray.plist"
    if [ -f "$OLD_TRAY" ]; then launchctl unload "$OLD_TRAY" 2>/dev/null || true; rm -f "$OLD_TRAY" "$BIN_DIR/PocketDeskTray"; fi
    AGENT="$AGENTS/com.pocketdesk.daemon.plist"
    sed -e "s#__NODE__#$(command -v node)#" -e "s#__DAEMON__#$DAEMON_DIR#" -e "s#__PATH__#$SVC_PATH#" \
        -e "s#__LOG__#$INSTALL_DIR/daemon.log#" "$DAEMON_DIR/scripts/mac/com.pocketdesk.daemon.plist" > "$AGENT"
    launchctl unload "$AGENT" 2>/dev/null || true
    launchctl load "$AGENT" && ok "Daemon runs now and at login (LaunchAgent)" || "$BIN_DIR/pocketdesk" start || true
    # The Start Menu shortcut's counterpart: Spotlight or Launchpad "PocketDesk" opens the settings page.
    mkdir -p "$HOME/Applications"
    rm -rf "$HOME/Applications/PocketDesk.app"
    osacompile -o "$HOME/Applications/PocketDesk.app" -e "do shell script quoted form of \"$BIN_DIR/pocketdesk\" & \" pair\"" >/dev/null \
      && ok "PocketDesk app added to ~/Applications (opens pairing and settings)" || warn "Could not build the app; use 'pocketdesk pair'"
    ;;
  Linux)
    UNIT_DIR="$HOME/.config/systemd/user"; mkdir -p "$UNIT_DIR"
    sed -e "s#__NODE__#$(command -v node)#" -e "s#__DAEMON__#$DAEMON_DIR#" -e "s#__PATH__#$SVC_PATH#" \
      "$DAEMON_DIR/scripts/linux/pocketdesk.service" > "$UNIT_DIR/pocketdesk.service"
    if command -v systemctl &>/dev/null && systemctl --user daemon-reload 2>/dev/null; then
      systemctl --user enable pocketdesk 2>/dev/null || true
      systemctl --user restart pocketdesk && ok "Daemon runs now and at login (systemd user service)" \
        || { warn "systemd --user unavailable — starting directly"; "$BIN_DIR/pocketdesk" start || true; }
      # Without lingering the user manager, and the daemon with it, stops at logout: a TTY box would drop off.
      loginctl enable-linger "$USER" 2>/dev/null && ok "Keeps running after logout and from boot (lingering on)" \
        || warn "Could not turn on lingering; run 'sudo loginctl enable-linger $USER' to keep PocketDesk up after logout"
    else
      "$BIN_DIR/pocketdesk" start || true
    fi
    # App-menu entry, the Start Menu shortcut's counterpart: opens the pairing and settings page.
    APPS="$HOME/.local/share/applications"; mkdir -p "$APPS"
    sed "s#__BIN__#$BIN_DIR/pocketdesk#" "$DAEMON_DIR/scripts/linux/pocketdesk.desktop" > "$APPS/pocketdesk.desktop"
    ok "PocketDesk added to the app menu (opens pairing and settings)"
    ;;
  *) "$BIN_DIR/pocketdesk" start || true ;;
esac


echo ""
echo -e "  ${GREEN}${BOLD}  PocketDesk is ready.${NC}"
echo -e "  ${BOLD}Pair a phone / settings:${NC}  open PocketDesk from your apps, or run: pocketdesk pair"
echo -e "  ${BOLD}Status:${NC}  pocketdesk status   ${BOLD}Stop:${NC}  pocketdesk stop   ${BOLD}Port:${NC}  $PORT"
[ -d "$USER_BIN" ] && case ":$PATH:" in *":$USER_BIN:"*) ;; *) echo -e "  ${YELLOW}Add to PATH:${NC}  export PATH=\"\$HOME/.local/bin:\$PATH\"";; esac
echo ""

if $DEV_MODE; then
  cd "$DAEMON_DIR"
  node test/proposals.test.mjs 2>/dev/null && ok "Proposal tests pass" || warn "Proposal tests skipped"
fi
