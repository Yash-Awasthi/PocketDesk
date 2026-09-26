# PocketDesk installer for Windows. No admin rights, nothing to install first.
#
#   irm https://raw.githubusercontent.com/Yash-Awasthi/PocketDesk/master/install.ps1 | iex
#
# Run it again to update. Settings, keys and paired phones in %USERPROFILE%\.pocketdesk are kept.
# From a checkout: powershell -ExecutionPolicy Bypass -File install.ps1 -Source .

param(
    [string]$Ref = "",                                   # release tag; the latest release when empty
    [string]$Source = "",                                # install from a local checkout instead of downloading
    [string]$InstallDir = "$env:LOCALAPPDATA\PocketDesk",
    [switch]$NoStart,
    [switch]$Console                                     # also install the SYSTEM console endpoint (one UAC prompt)
)
$ErrorActionPreference = "Stop"
# The progress bar makes Invoke-WebRequest many times slower on Windows PowerShell 5.
$ProgressPreference = "SilentlyContinue"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
$repo = "Yash-Awasthi/PocketDesk"

function Step($message) { Write-Host "==> $message" -ForegroundColor Cyan }
function Download($url, $file) { Invoke-WebRequest -UseBasicParsing -Uri $url -OutFile $file }
# These binaries run with the user's rights (and SYSTEM's with -Console): refuse any that fail the publisher's checksum.
function Verify($file, $expected) {
    $actual = (Get-FileHash -Algorithm SHA256 $file).Hash
    if (-not $expected -or $actual -ne $expected.Trim()) { throw "checksum mismatch for $(Split-Path -Leaf $file): got $actual, expected $expected" }
}

$tmp = Join-Path $env:TEMP ("rh-install-" + [guid]::NewGuid().ToString("N"))
New-Item -ItemType Directory -Force -Path $InstallDir, $tmp | Out-Null
try {
    # 1. The daemon.
    if ($Source) {
        $srcRoot = (Resolve-Path $Source).Path
        Step "Using the daemon from $srcRoot\daemon"
    } else {
        if (-not $Ref) { $Ref = (Invoke-RestMethod "https://api.github.com/repos/$repo/releases/latest").tag_name }
        Step "Downloading PocketDesk $Ref"
        Download "https://github.com/$repo/archive/refs/tags/$Ref.zip" "$tmp\src.zip"
        Expand-Archive "$tmp\src.zip" "$tmp\src"
        $srcRoot = (Get-ChildItem "$tmp\src" -Directory | Select-Object -First 1).FullName
    }
    $srcDaemon = Join-Path $srcRoot "daemon"
    # A running tray and daemon hold files open in the install folder.
    foreach ($t in @(Get-CimInstance Win32_Process -Filter "Name='PocketDeskTray.exe'")) {
        Get-CimInstance Win32_Process -Filter "ParentProcessId=$($t.ProcessId)" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
        Stop-Process -Id $t.ProcessId -Force -ErrorAction SilentlyContinue
    }
    Start-Sleep -Milliseconds 500
    $daemon = Join-Path $InstallDir "app\daemon"
    if (Test-Path $daemon) { Remove-Item -Recurse -Force $daemon }
    robocopy $srcDaemon $daemon /E /XD node_modules /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "copying the daemon failed (robocopy $LASTEXITCODE)" }
    Copy-Item (Join-Path $srcRoot "uninstall.ps1") $InstallDir -Force

    # 2. Node.js, private to PocketDesk.
    $nodeDir = Join-Path $InstallDir "node"
    # The parentheses matter: PowerShell 5 passes an unenumerated JSON array down the pipe as one object.
    $want = ((Invoke-RestMethod "https://nodejs.org/dist/index.json") | Where-Object { $_.lts } | Select-Object -First 1).version
    $have = if (Test-Path "$nodeDir\node.exe") { & "$nodeDir\node.exe" --version } else { "" }
    if ($have -ne $want) {
        Step "Downloading Node.js $want"
        Download "https://nodejs.org/dist/$want/node-$want-win-x64.zip" "$tmp\node.zip"
        Download "https://nodejs.org/dist/$want/SHASUMS256.txt" "$tmp\node.sha256"
        $sums = Get-Content -Raw "$tmp\node.sha256"
        Verify "$tmp\node.zip" ([regex]::Match($sums, "(?m)^([0-9a-f]{64})\s+node-$([regex]::Escape($want))-win-x64\.zip$").Groups[1].Value)
        Expand-Archive "$tmp\node.zip" "$tmp\node"
        if (Test-Path $nodeDir) { Remove-Item -Recurse -Force $nodeDir }
        Move-Item (Get-ChildItem "$tmp\node" -Directory | Select-Object -First 1).FullName $nodeDir
    }

    # 3. ffmpeg for the H.264 desktop stream (without it the desktop falls back to slow JPEG frames).
    $ffDir = Join-Path $InstallDir "ffmpeg"
    if (-not (Test-Path "$ffDir\ffmpeg.exe")) {
        Step "Downloading ffmpeg (about 110 MB, once)"
        Download "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" "$tmp\ffmpeg.zip"
        Download "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip.sha256" "$tmp\ffmpeg.sha256"
        Verify "$tmp\ffmpeg.zip" ((Get-Content -Raw "$tmp\ffmpeg.sha256") -split '\s+')[0]
        Expand-Archive "$tmp\ffmpeg.zip" "$tmp\ffmpeg"
        New-Item -ItemType Directory -Force $ffDir | Out-Null
        Copy-Item (Get-ChildItem "$tmp\ffmpeg" -Recurse -Filter ffmpeg.exe | Select-Object -First 1).FullName $ffDir
    }

    # 4. Dependencies, with the private Node.
    Step "Installing dependencies"
    $env:PATH = "$nodeDir;$env:PATH"
    Push-Location $daemon
    try {
        & "$nodeDir\npm.cmd" ci --omit=dev --no-audit --no-fund --loglevel=error
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
    } finally { Pop-Location }

    # 5. The tray: starts at logon and runs the daemon.
    Step "Installing the tray"
    & "$daemon\scripts\install-service.ps1" -DaemonDir $daemon -InstallDir $InstallDir -NoStart:$NoStart

    # 5b. Console endpoint (opt-in): the SYSTEM secure-desktop entry. Needs one elevation.
    if ($Console) {
        Step "Installing the console endpoint (elevation required)"
        $consoleArgs = @('-ExecutionPolicy','Bypass','-File',"$daemon\scripts\install-service.ps1",
                         '-Console','-DaemonDir',$daemon,'-InstallDir',$InstallDir)
        if ($NoStart) { $consoleArgs += '-NoStart' }
        Start-Process powershell -Verb RunAs -Wait -ArgumentList $consoleArgs
    }

    # 6. Pairing: the daemon writes its settings on first start; then the QR page opens.
    if (-not $NoStart) {
        Step "Starting; the pairing page opens in your browser"
        $cfgFile = Join-Path $env:USERPROFILE ".pocketdesk\config.json"
        for ($i = 0; $i -lt 60; $i++) {
            if (Test-Path $cfgFile) {
                $cfg = Get-Content $cfgFile -Raw | ConvertFrom-Json
                if (Get-NetTCPConnection -State Listen -LocalPort $cfg.port -ErrorAction SilentlyContinue) {
                    $scheme = if ($cfg.tls.enabled) { "https" } else { "http" }
                    Start-Process "${scheme}://localhost:$($cfg.port)/pair"
                    break
                }
            }
            Start-Sleep -Seconds 1
        }
    }
    Write-Host ""
    Write-Host "PocketDesk is installed in $InstallDir" -ForegroundColor Green
    Write-Host "Scan the QR code with the PocketDesk app. Later: tray icon > Pair a phone."
    if (-not $Console) { Write-Host "Lock screen / UAC / before-login from the phone? Re-run with -Console (one UAC prompt)." }
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
