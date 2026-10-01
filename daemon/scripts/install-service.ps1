# Installs the hidden PocketDesk daemon and registers it to start at logon.
# There is no tray or window: the daemon runs in the background and is stopped from Task Manager.
# A Start-menu/desktop launcher starts it if needed and opens the pairing page.
#
# From a checkout (development): powershell -File daemon\scripts\install-service.ps1
# install.ps1 at the repo root calls this with -DaemonDir/-InstallDir for a normal install.

param(
    [string]$DaemonDir = (Split-Path -Parent $PSScriptRoot),
    [string]$InstallDir = (Join-Path $env:USERPROFILE ".pocketdesk"),
    [switch]$NoStart,
    # Registers the SYSTEM console endpoint (secure desktop: lock screen, UAC, before login)
    # instead of the tray. Must run elevated. See docs/console-endpoint-plan.md.
    [switch]$Console
)
$ErrorActionPreference = "Stop"

$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { throw "csc.exe not found at $csc" }

if ($Console) {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) {
        throw "install-service.ps1 -Console must run elevated (it registers a SYSTEM scheduled task)."
    }

    $consoleSrc = Join-Path $PSScriptRoot "console\PocketDeskConsole.cs"
    # Everything the SYSTEM task executes lives here, where only Administrators + SYSTEM may write.
    # The per-user install dir is writable by the user, so running SYSTEM code from it would be a
    # local privilege-escalation path, hence a separate, locked copy under ProgramData.
    $root        = Join-Path $env:ProgramData "PocketDesk\bin"
    $consoleHome = Join-Path $env:ProgramData "PocketDesk\console"
    $consoleExe  = Join-Path $root "PocketDeskConsole.exe"

    $srcNode = Join-Path $InstallDir "node"
    if (-not (Test-Path (Join-Path $srcNode "node.exe"))) { throw "bundled node not found at $srcNode - run the normal install first, then -Console." }

    # Stop a running launcher + its console daemon before replacing the protected copy.
    schtasks /End /TN "PocketDeskConsole" 2>$null | Out-Null
    Get-Process PocketDeskConsole -ErrorAction SilentlyContinue | Stop-Process -Force
    Get-NetTCPConnection -State Listen -LocalPort 8766 -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 500

    # Create + lock the protected root BEFORE copying, so all contents inherit the locked ACL.
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    icacls $root /inheritance:r /grant "*S-1-5-32-544:(OI)(CI)F" /grant "*S-1-5-18:(OI)(CI)F" | Out-Null

    # The executed chain: node, the daemon tree (incl node_modules), and ffmpeg, all copied in.
    robocopy $srcNode (Join-Path $root "node") /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    robocopy $DaemonDir (Join-Path $root "daemon") /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "copying the daemon into the protected root failed (robocopy $LASTEXITCODE)" }
    $srcFfmpeg = Join-Path $InstallDir "ffmpeg"
    if (Test-Path (Join-Path $srcFfmpeg "ffmpeg.exe")) { robocopy $srcFfmpeg (Join-Path $root "ffmpeg") /MIR /NFL /NDL /NJH /NJS /NP | Out-Null }

    # Compile the launcher directly into the protected root.
    & $csc /nologo /target:exe /out:$consoleExe /r:System.dll $consoleSrc
    if ($LASTEXITCODE -ne 0) { throw "console launcher compile failed" }

    # The launcher reads its daemon dir from this ini; point it at the protected copy.
    Set-Content -Path (Join-Path $root "PocketDeskConsole.ini") -Value (Join-Path $root "daemon")

    # SYSTEM-only config dir: the token that lands here opens a SYSTEM daemon.
    New-Item -ItemType Directory -Force -Path $consoleHome | Out-Null
    icacls $consoleHome /inheritance:r /grant "*S-1-5-32-544:(OI)(CI)F" /grant "*S-1-5-18:(OI)(CI)F" | Out-Null

    # SYSTEM, highest, at boot (runs before login); auto-restart on failure.
    $action   = New-ScheduledTaskAction -Execute $consoleExe
    $trigger  = New-ScheduledTaskTrigger -AtStartup
    $prin     = New-ScheduledTaskPrincipal -UserId "SYSTEM" -LogonType ServiceAccount -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName "PocketDeskConsole" -Action $action -Trigger $trigger `
        -Principal $prin -Settings $settings -Force | Out-Null

    if (-not $NoStart) {
        Start-ScheduledTask -TaskName "PocketDeskConsole"
        $cfgFile = Join-Path $consoleHome "config.json"
        for ($i = 0; $i -lt 60; $i++) {
            if ((Test-Path $cfgFile) -and (Get-NetTCPConnection -State Listen -LocalPort 8766 -ErrorAction SilentlyContinue)) {
                $consoleToken = (Get-Content $cfgFile -Raw | ConvertFrom-Json).token
                Start-Process "https://localhost:8766/pair?k=$([uri]::EscapeDataString($consoleToken))"
                break
            }
            Start-Sleep -Seconds 1
        }
    }
    Write-Host "  console endpoint installed (SYSTEM task 'PocketDeskConsole', port 8766)."
    Write-Host "  pair it from the QR at https://localhost:8766/pair?k=<token in $consoleHome\config.json>  (entry: PC (console))."
    return
}

$exe = Join-Path $InstallDir "PocketDeskLauncher.exe"
$src = Join-Path $PSScriptRoot "PocketDeskLauncher.cs"

# The launcher prefers a node.exe next to it (install.ps1 puts one there), then PATH.
$bundledNode = Join-Path $InstallDir "node\node.exe"
if (-not (Test-Path $bundledNode) -and -not (Get-Command node -ErrorAction SilentlyContinue)) { throw "node.exe not found on PATH" }

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# Stop a previous install's running daemon (the detached node on the user port) and any old tray,
# so its port and the launcher exe are free to replace.
$port = 8765
try {
    $cfg = Get-Content (Join-Path $env:USERPROFILE ".pocketdesk\config.json") -Raw | ConvertFrom-Json
    if ($cfg.port) { $port = [int]$cfg.port }
} catch {}
Get-Process PocketDeskTray -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Start-Sleep -Milliseconds 300

# Always rebuilt: a release zip gives the source its commit time, often older than the previous exe.
& $csc /nologo /target:winexe /out:$exe /r:System.dll $src
if ($LASTEXITCODE -ne 0) { throw "compile failed" }

# The launcher spawns the daemon from this folder.
Set-Content -Path (Join-Path $InstallDir "PocketDesk.ini") -Value $DaemonDir

# Start Menu and desktop launcher: a click starts the daemon if needed and opens the pairing page.
$shell = New-Object -ComObject WScript.Shell
foreach ($dir in @([Environment]::GetFolderPath("Programs"), [Environment]::GetFolderPath("Desktop"))) {
    $lnk = $shell.CreateShortcut((Join-Path $dir "PocketDesk.lnk"))
    $lnk.TargetPath = $exe
    $lnk.WorkingDirectory = $InstallDir
    $lnk.Description = "Open PocketDesk pairing"
    $lnk.Save()
}

# The per-user Run key starts the hidden daemon at logon without admin rights; --daemon opens no page.
Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "PocketDesk" -Value "`"$exe`" --daemon"

if (-not $NoStart) { Start-Process $exe "--daemon" }
Write-Host "  hidden daemon installed; it starts at logon. Open the Start-menu 'PocketDesk' to pair."
Write-Host "  stop it from Task Manager (end node.exe). settings: $env:USERPROFILE\.pocketdesk\config.json"
