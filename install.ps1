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
    # A running daemon holds files open in the install folder; stop it by its listening port.
    $uport = 8765
    try { $uc = Get-Content (Join-Path $env:USERPROFILE ".pocketdesk\config.json") -Raw | ConvertFrom-Json; if ($uc.port) { $uport = [int]$uc.port } } catch {}
    Get-Process PocketDeskTray -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
    Get-NetTCPConnection -State Listen -LocalPort $uport -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 300
    $daemon = Join-Path $InstallDir "app\daemon"
    if (Test-Path $daemon) { Remove-Item -Recurse -Force $daemon }
    robocopy $srcDaemon $daemon /E /XD node_modules /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "copying the daemon failed (robocopy $LASTEXITCODE)" }
    Copy-Item (Join-Path $srcRoot "uninstall.ps1") $InstallDir -Force

    # 2. Node.js: a Node 20+ already on PATH is reused, otherwise a private copy. node-pty uses
    # Node-API, so upgrading that Node later does not break it. Console access needs the private copy.
    $nodeDir = Join-Path $InstallDir "node"
    $npm = "$nodeDir\npm.cmd"
    $systemNode = Get-Command node.exe -ErrorAction SilentlyContinue
    $systemMajor = if ($systemNode) { [int]((& $systemNode.Source --version) -replace '^v(\d+).*', '$1') } else { 0 }
    if (-not $Console -and -not (Test-Path "$nodeDir\node.exe") -and $systemMajor -ge 20) {
        Step "Using Node.js $(& $systemNode.Source --version) from $($systemNode.Source)"
        $npm = Join-Path (Split-Path $systemNode.Source) "npm.cmd"
        $want = $null
    } else {
        # The parentheses matter: PowerShell 5 passes an unenumerated JSON array down the pipe as one object.
        $want = ((Invoke-RestMethod "https://nodejs.org/dist/index.json") | Where-Object { $_.lts } | Select-Object -First 1).version
        $env:PATH = "$nodeDir;$env:PATH"
    }
    $have = if (Test-Path "$nodeDir\node.exe") { & "$nodeDir\node.exe" --version } else { "" }
    if ($want -and $have -ne $want) {
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
    # One already on PATH is used as is; the daemon looks there when no private copy exists.
    $ffDir = Join-Path $InstallDir "ffmpeg"
    $systemFfmpeg = Get-Command ffmpeg.exe -ErrorAction SilentlyContinue
    if (-not (Test-Path "$ffDir\ffmpeg.exe") -and $systemFfmpeg) {
        Step "Using ffmpeg from $($systemFfmpeg.Source)"
    } elseif (-not (Test-Path "$ffDir\ffmpeg.exe")) {
        Step "Downloading ffmpeg (about 110 MB, once)"
        Download "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip" "$tmp\ffmpeg.zip"
        Download "https://www.gyan.dev/ffmpeg/builds/ffmpeg-release-essentials.zip.sha256" "$tmp\ffmpeg.sha256"
        Verify "$tmp\ffmpeg.zip" ((Get-Content -Raw "$tmp\ffmpeg.sha256") -split '\s+')[0]
        Expand-Archive "$tmp\ffmpeg.zip" "$tmp\ffmpeg"
        New-Item -ItemType Directory -Force $ffDir | Out-Null
        Copy-Item (Get-ChildItem "$tmp\ffmpeg" -Recurse -Filter ffmpeg.exe | Select-Object -First 1).FullName $ffDir
    }

    # 4. Dependencies.
    Step "Installing dependencies"
    Push-Location $daemon
    try {
        & $npm ci --omit=dev --no-audit --no-fund --loglevel=error
        if ($LASTEXITCODE -ne 0) { throw "npm ci failed" }
    } finally { Pop-Location }

    # 5. The hidden daemon: starts at logon in the background.
    Step "Installing the hidden daemon"
    & "$daemon\scripts\install-service.ps1" -DaemonDir $daemon -InstallDir $InstallDir -NoStart:$NoStart

    # Listed under Settings > Apps > Installed apps, whose Uninstall button runs uninstall.ps1.
    $key = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\PocketDesk"
    New-Item -Path $key -Force | Out-Null
    $size = [int]((Get-ChildItem $InstallDir -Recurse -File -ErrorAction SilentlyContinue | Measure-Object Length -Sum).Sum / 1KB)
    $entry = @{
        DisplayName     = "PocketDesk"
        DisplayVersion  = if ($Ref) { $Ref.TrimStart("v") } else { "dev" }
        Publisher       = "PocketDesk"
        InstallLocation = $InstallDir
        DisplayIcon     = Join-Path $InstallDir "PocketDeskLauncher.exe"
        UninstallString = "powershell.exe -NoProfile -ExecutionPolicy Bypass -File `"$InstallDir\uninstall.ps1`""
        URLInfoAbout    = "https://github.com/$repo"
    }
    foreach ($name in $entry.Keys) { Set-ItemProperty -Path $key -Name $name -Value $entry[$name] }
    foreach ($name in "NoModify", "NoRepair", "EstimatedSize") {
        New-ItemProperty -Path $key -Name $name -PropertyType DWord -Value $(if ($name -eq "EstimatedSize") { $size } else { 1 }) -Force | Out-Null
    }

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
                    Start-Process "${scheme}://localhost:$($cfg.port)/pair?k=$([uri]::EscapeDataString($cfg.token))"
                    break
                }
            }
            Start-Sleep -Seconds 1
        }
    }
    Write-Host ""
    Write-Host "PocketDesk is installed in $InstallDir" -ForegroundColor Green
    Write-Host "Scan the QR code with the PocketDesk app. Later: open the Start-menu PocketDesk to pair."
    if (-not $Console) { Write-Host "Lock screen / UAC / before-login from the phone? Re-run with -Console (one UAC prompt)." }
} finally {
    Remove-Item -Recurse -Force $tmp -ErrorAction SilentlyContinue
}
