#Requires -Version 5.1
<#
.SYNOPSIS
    PocketDesk one-liner installer for Windows.
.DESCRIPTION
    Installs PocketDesk daemon, generates auth token, and prints connection info.
.PARAMETER Dev
    Install dev dependencies and run tests.
.PARAMETER Dir
    Custom install directory (default: %USERPROFILE%\.pocketdesk).
.EXAMPLE
    irm https://raw.githubusercontent.com/.../install.ps1 | iex
    .\install.ps1 -Dev
#>
param(
    [switch]$Dev,
    [string]$Dir = "$env:USERPROFILE\.pocketdesk"
)

$ErrorActionPreference = "Stop"

# ── Colors ───────────────────────────────────────────────────────────────────
function Write-Info  { Write-Host "ℹ  $args" -ForegroundColor Cyan }
function Write-Ok    { Write-Host "✓  $args" -ForegroundColor Green }
function Write-Warn  { Write-Host "⚠  $args" -ForegroundColor Yellow }
function Write-Fail  { Write-Host "✗  $args" -ForegroundColor Red; exit 1 }
function Write-Step  { Write-Host "`n▸ $args" -ForegroundColor White }

# ── Banner ───────────────────────────────────────────────────────────────────
Write-Host ""
Write-Host "  ┌─────────────────────────────────┐" -ForegroundColor Cyan
Write-Host "  │   🔧  PocketDesk Installer   │" -ForegroundColor Cyan
Write-Host "  └─────────────────────────────────┘" -ForegroundColor Cyan
Write-Host ""

# ── Step 1: Check prerequisites ──────────────────────────────────────────────
Write-Step "Checking prerequisites"

# Node.js
try {
    $nodeVersion = & node -v 2>$null
    if (-not $nodeVersion) { throw "not found" }
    $major = [int]($nodeVersion -replace 'v','' -split '\.' | Select-Object -First 1)
    if ($major -lt 18) { Write-Fail "Node.js ≥18 required (found $nodeVersion)" }
    Write-Ok "Node.js $nodeVersion"
} catch {
    Write-Fail "Node.js not found. Install from https://nodejs.org (≥18 required)"
}

# npm
try {
    $npmVersion = & npm -v 2>$null
    Write-Ok "npm $npmVersion"
} catch {
    Write-Fail "npm not found. Install Node.js from https://nodejs.org"
}

# ── Step 2: Clone or update ──────────────────────────────────────────────────
Write-Step "Setting up PocketDesk"

$RepoUrl = "https://github.com/Yash-Awasthi/PocketDesk.git"
$DaemonDir = Join-Path $Dir "daemon"

if (Test-Path (Join-Path $Dir ".git")) {
    Write-Info "Repository already exists at $Dir"
    if (Test-Path $DaemonDir) {
        Write-Ok "Daemon directory found — skipping clone"
    } else {
        Write-Warn "Daemon directory missing — pulling latest"
        git -C $Dir pull --quiet 2>$null
    }
} else {
    Write-Info "Cloning to $Dir..."
    git clone --depth 1 $RepoUrl $Dir 2>$null
    Write-Ok "Repository cloned"
}

# ── Step 3: Install dependencies ─────────────────────────────────────────────
Write-Step "Installing dependencies"

Push-Location $DaemonDir
if (Test-Path "node_modules") {
    Write-Info "node_modules exists — running npm install for updates"
    npm install --silent 2>$null
} else {
    Write-Info "Installing dependencies..."
    npm install --silent 2>$null
}
Write-Ok "Dependencies installed"

if ($Dev) {
    Write-Info "Dev mode: installing dev dependencies..."
    npm install --include=dev --silent 2>$null
    Write-Ok "Dev dependencies installed"
}
Pop-Location

# ── Step 4: Generate token ───────────────────────────────────────────────────
Write-Step "Generating auth token"

$ConfigDir = "$env:USERPROFILE\.pocketdesk"
$TokenFile = Join-Path $ConfigDir "config.json"

if (Test-Path $TokenFile) {
    try {
        $config = Get-Content $TokenFile -Raw | ConvertFrom-Json
        $Token = $config.token
        Write-Ok "Using existing token"
    } catch {
        $Token = -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
        $config = @{ token = $Token; port = 8765 }
        $config | ConvertTo-Json | Set-Content $TokenFile
        Write-Ok "Token generated and saved"
    }
} else {
    New-Item -ItemType Directory -Path $ConfigDir -Force | Out-Null
    $Token = -join ((1..32) | ForEach-Object { '{0:x2}' -f (Get-Random -Max 256) })
    $config = @{ token = $Token; port = 8765 }
    $config | ConvertTo-Json | Set-Content $TokenFile
    Write-Ok "Token generated and saved"
}

$Port = 8765
try {
    $cfg = Get-Content $TokenFile -Raw | ConvertFrom-Json
    if ($cfg.port) { $Port = $cfg.port }
} catch {}

# ── Step 5: Print success ───────────────────────────────────────────────────
Write-Host ""
Write-Host "  ═══════════════════════════════════════" -ForegroundColor Green
Write-Host "    PocketDesk is ready! 🔧" -ForegroundColor Green
Write-Host "  ═══════════════════════════════════════" -ForegroundColor Green
Write-Host ""
Write-Host "  Daemon:  $DaemonDir" -ForegroundColor White
Write-Host "  Token:   $($Token.Substring(0,8))..." -ForegroundColor White
Write-Host "  Port:    $Port" -ForegroundColor White
Write-Host ""
Write-Host "  To start:" -ForegroundColor Cyan
Write-Host "    cd $DaemonDir; npm start"
Write-Host ""
Write-Host "  Then connect from the Android app:" -ForegroundColor Cyan
Write-Host "    ws://<your-pc-ip>:$Port/ws"
Write-Host "    Token: $Token"
Write-Host ""

if ($Dev) {
    Write-Host "  Dev mode: Running tests..." -ForegroundColor Yellow
    Push-Location $DaemonDir
    try {
        & node test/proposals.test.mjs 2>$null
        Write-Ok "Proposal tests pass"
    } catch {
        Write-Warn "Proposal tests skipped"
    }
    Pop-Location
    Write-Host ""
}

Write-Host "  Docs:    $Dir\README.md" -ForegroundColor White
Write-Host ""
