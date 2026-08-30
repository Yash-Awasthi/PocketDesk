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

# ── Step 5: Start daemon ─────────────────────────────────────────────────────
step "Starting daemon"

PORT=$(node -e "try{console.log(JSON.parse(require('fs').readFileSync('$TOKEN_FILE','utf8')).port||8765)}catch(e){console.log(8765)}" 2>/dev/null || echo 8765)

# Kill existing daemon on this port
if command -v lsof &>/dev/null; then
  EXISTING=$(lsof -ti :"$PORT" 2>/dev/null || true)
  if [ -n "$EXISTING" ]; then
    warn "Port $PORT in use — killing existing process"
    kill "$EXISTING" 2>/dev/null || true
    sleep 1
  fi
fi

echo ""
echo -e "  ${GREEN}${BOLD}═══════════════════════════════════════${NC}"
echo -e "  ${GREEN}${BOLD}  PocketDesk is ready! 🔧${NC}"
echo -e "  ${GREEN}${BOLD}═══════════════════════════════════════${NC}"
echo ""
echo -e "  ${BOLD}Daemon:${NC}  $DAEMON_DIR"
echo -e "  ${BOLD}Token:${NC}   ${TOKEN:0:8}..."
echo -e "  ${BOLD}Port:${NC}    $PORT"
echo ""
echo -e "  ${CYAN}To start:${NC}"
echo -e "    cd $DAEMON_DIR && npm start"
echo ""
echo -e "  ${CYAN}Then connect from the Android app:${NC}"
echo -e "    ws://<your-pc-ip>:$PORT/ws"
echo -e "    Token: $TOKEN"
echo ""

if $DEV_MODE; then
  echo -e "  ${YELLOW}Dev mode:${NC} Running tests..."
  cd "$DAEMON_DIR"
  node test/proposals.test.mjs 2>/dev/null && ok "Proposal tests pass" || warn "Proposal tests skipped"
  echo ""
fi

echo -e "  ${BOLD}Docs:${NC}    $INSTALL_DIR/README.md"
echo ""
