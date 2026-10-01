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
  fail "Node.js not found. Install from https://nodejs.org (≥18 required)"
fi
NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
  fail "Node.js ≥18 required (found v$(node -v))"
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

# ── Step 2: Clone or update repo ─────────────────────────────────────────────
step "Setting up PocketDesk"

if [ -d "$INSTALL_DIR/.git" ]; then
  info "Repository already exists at $INSTALL_DIR"
  if [ -d "$DAEMON_DIR" ]; then
    ok "Daemon directory found — skipping clone"
  else
    warn "Daemon directory missing — pulling latest"
    git -C "$INSTALL_DIR" pull --quiet 2>/dev/null || true
  fi
else
  info "Cloning to $INSTALL_DIR..."
  if command -v git &>/dev/null; then
    git clone --depth 1 "$REPO_URL" "$INSTALL_DIR" 2>/dev/null
  else
    # Fallback: download archive
    ARCHIVE_URL="https://github.com/Yash-Awasthi/PocketDesk/archive/refs/heads/main.tar.gz"
    mkdir -p "$INSTALL_DIR"
    curl -fsSL "$ARCHIVE_URL" | tar xz --strip-components=1 -C "$INSTALL_DIR"
  fi
  ok "Repository cloned"
fi

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

# ── Step 4: Generate token if needed ─────────────────────────────────────────
step "Generating auth token"

TOKEN_FILE="$HOME/.pocketdesk/config.json"
if [ -f "$TOKEN_FILE" ] && grep -q '"token"' "$TOKEN_FILE" 2>/dev/null; then
  TOKEN=$(grep '"token"' "$TOKEN_FILE" | sed 's/.*"token": *"//' | sed 's/".*//')
  ok "Using existing token"
else
  TOKEN=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))" 2>/dev/null || openssl rand -hex 32 2>/dev/null || head -c 64 /dev/urandom | od -An -tx1 | tr -d ' \n' | head -c 64)
  mkdir -p "$HOME/.pocketdesk"
  cat > "$TOKEN_FILE" <<EOCONF
{
  "token": "$TOKEN",
  "port": 8765
}
EOCONF
  ok "Token generated and saved"
fi

# ── Step 5: Autostart + control CLI (hidden daemon, like the Windows build) ───
step "Setting up background start and controls"

PORT=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$TOKEN_FILE','utf8')).port||8765)}catch(e){console.log(8765)}" 2>/dev/null || echo 8765)
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
    # A menu-bar tray (no Task Manager on macOS): start/stop/pair from the status bar.
    if command -v swiftc &>/dev/null; then
      swiftc -O "$DAEMON_DIR/scripts/mac/PocketDeskTray.swift" -o "$BIN_DIR/PocketDeskTray" 2>/dev/null \
        && ok "Menu-bar tray built" || warn "Tray build failed — use the 'pocketdesk' command to start/stop"
    else
      warn "swiftc not found (install Xcode command-line tools) — tray skipped; use 'pocketdesk' to start/stop"
    fi
    AGENTS="$HOME/Library/LaunchAgents"; mkdir -p "$AGENTS"
    if [ -x "$BIN_DIR/PocketDeskTray" ]; then
      sed "s#__TRAY__#$BIN_DIR/PocketDeskTray#" "$DAEMON_DIR/scripts/mac/com.pocketdesk.tray.plist" > "$AGENTS/com.pocketdesk.tray.plist"
      launchctl unload "$AGENTS/com.pocketdesk.tray.plist" 2>/dev/null || true
      launchctl load "$AGENTS/com.pocketdesk.tray.plist" 2>/dev/null || true
      ok "Tray starts at login; it runs the hidden daemon"
    else
      "$BIN_DIR/pocketdesk" start || true
    fi
    ;;
  Linux)
    UNIT_DIR="$HOME/.config/systemd/user"; mkdir -p "$UNIT_DIR"
    sed -e "s#__NODE__#$(command -v node)#" -e "s#__DAEMON__#$DAEMON_DIR#" \
      "$DAEMON_DIR/scripts/linux/pocketdesk.service" > "$UNIT_DIR/pocketdesk.service"
    if command -v systemctl &>/dev/null; then
      systemctl --user daemon-reload 2>/dev/null || true
      systemctl --user enable --now pocketdesk 2>/dev/null && ok "Daemon runs now and at login (systemd user service)" \
        || { warn "systemd --user unavailable — starting directly"; "$BIN_DIR/pocketdesk" start || true; }
    else
      "$BIN_DIR/pocketdesk" start || true
    fi
    ;;
  *) "$BIN_DIR/pocketdesk" start || true ;;
esac

echo ""
echo -e "  ${GREEN}${BOLD}  PocketDesk is ready.${NC}"
echo -e "  ${BOLD}Pair a phone:${NC}  pocketdesk pair     ${BOLD}Stop:${NC}  pocketdesk stop   (macOS: menu-bar ◆ → Stop)"
echo -e "  ${BOLD}Status:${NC}        pocketdesk status   ${BOLD}Port:${NC}  $PORT   ${BOLD}Token:${NC} ${TOKEN:0:8}…"
[ -d "$USER_BIN" ] && case ":$PATH:" in *":$USER_BIN:"*) ;; *) echo -e "  ${YELLOW}Add to PATH:${NC}  export PATH=\"\$HOME/.local/bin:\$PATH\"";; esac
echo ""

if $DEV_MODE; then
  cd "$DAEMON_DIR"
  node test/proposals.test.mjs 2>/dev/null && ok "Proposal tests pass" || warn "Proposal tests skipped"
fi
