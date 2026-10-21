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
    [switch]$Console,
    # Internal, elevated: copies the staged install into this admin-only folder, which the elevated daemon runs from.
    [string]$Protect = ""
)
$ErrorActionPreference = "Stop"

$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"
if (-not (Test-Path $csc)) { throw "csc.exe not found at $csc" }

function Assert-Elevated($what) {
    $principal = New-Object Security.Principal.WindowsPrincipal([Security.Principal.WindowsIdentity]::GetCurrent())
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)) { throw "$what must run elevated." }
}

if ($Protect) {
    Assert-Elevated "install-service.ps1 -Protect"
    # Program Files: users cannot create or own anything here, so nothing can be planted before this copy.
    if (-not $Protect.StartsWith($env:ProgramFiles + "\", [StringComparison]::OrdinalIgnoreCase)) { throw "refusing to protect $Protect" }
    New-Item -ItemType Directory -Force -Path $Protect | Out-Null
    foreach ($f in "PocketDeskLauncher.exe", "PocketDesk.exe") { Copy-Item (Join-Path $InstallDir $f) $Protect -Force }
    robocopy $DaemonDir (Join-Path $Protect "daemon") /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    if ($LASTEXITCODE -ge 8) { throw "copying the daemon into $Protect failed (robocopy $LASTEXITCODE)" }
    # A reused system ffmpeg is snapshotted too: the elevated daemon never looks on PATH.
    $ff = Join-Path $InstallDir "ffmpeg\ffmpeg.exe"
    if (-not (Test-Path $ff)) { $ff = (Get-Command ffmpeg.exe -ErrorAction SilentlyContinue).Source }
    if ($ff) { New-Item -ItemType Directory -Force (Join-Path $Protect "ffmpeg") | Out-Null; Copy-Item $ff (Join-Path $Protect "ffmpeg\ffmpeg.exe") -Force }
    Set-Content -Path (Join-Path $Protect "PocketDesk.ini") -Value (Join-Path $Protect "daemon")

    # Autostart at logon, registered here where we are already elevated. RunLevel Highest starts the
    # elevated daemon with no per-logon UAC prompt; RestartCount brings it back if it crashes.
    $exe      = Join-Path $Protect "PocketDeskLauncher.exe"
    $me       = [Security.Principal.WindowsIdentity]::GetCurrent().Name
    $action   = New-ScheduledTaskAction -Execute $exe -Argument "--supervise"
    $trigger  = New-ScheduledTaskTrigger -AtLogOn -User $me
    $prin     = New-ScheduledTaskPrincipal -UserId $me -LogonType Interactive -RunLevel Highest
    $settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries `
                    -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1) -ExecutionTimeLimit ([TimeSpan]::Zero)
    Register-ScheduledTask -TaskName "PocketDesk" -Action $action -Trigger $trigger -Principal $prin -Settings $settings -Force | Out-Null
    return
}

if ($Console) {
    Assert-Elevated "install-service.ps1 -Console (it registers a SYSTEM scheduled task)"

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
    # try/catch: with ErrorActionPreference Stop, schtasks' stderr on a first install (no task yet)
    # is a terminating NativeCommandError that would abort the whole console install.
    try { schtasks /End /TN "PocketDeskConsole" 2>$null | Out-Null } catch {}
    Get-Process PocketDeskConsole -ErrorAction SilentlyContinue | Stop-Process -Force
    Get-NetTCPConnection -State Listen -LocalPort 8766 -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 500

    # Any user may create ProgramData\PocketDesk first; as its owner they could swap the folders below.
    # So: drop a planted link, take ownership, keep users to listing it, and reset everything inside.
    $pdRoot = Split-Path $root
    $planted = Get-Item -LiteralPath $pdRoot -Force -ErrorAction SilentlyContinue
    if ($planted -and ($planted.Attributes -band [IO.FileAttributes]::ReparsePoint)) { $planted.Delete() }
    New-Item -ItemType Directory -Force -Path $pdRoot | Out-Null
    icacls $pdRoot /setowner "*S-1-5-32-544" /T /C /Q | Out-Null
    icacls $pdRoot /inheritance:r /grant:r "*S-1-5-32-544:(OI)(CI)F" /grant:r "*S-1-5-18:(OI)(CI)F" /grant:r "*S-1-5-32-545:(RX)" /Q | Out-Null
    if (Get-ChildItem -LiteralPath $pdRoot -Force) { icacls "$pdRoot\*" /reset /T /C /Q | Out-Null }

    # Create + lock the protected root BEFORE copying, so all contents inherit the locked ACL.
    New-Item -ItemType Directory -Force -Path $root | Out-Null
    icacls $root /inheritance:r /grant "*S-1-5-32-544:(OI)(CI)F" /grant "*S-1-5-18:(OI)(CI)F" | Out-Null

    # The executed chain: node, the daemon tree (incl node_modules), and ffmpeg, all copied in.
    robocopy $srcNode (Join-Path $root "node") /MIR /NFL /NDL /NJH /NJS /NP | Out-Null
    # Task Manager lists the SYSTEM daemon by this name instead of node.exe.
    Copy-Item (Join-Path $root "node\node.exe") (Join-Path $root "node\PocketDeskConsoleDaemon.exe") -Force
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
            $listener = Get-NetTCPConnection -State Listen -LocalPort 8766 -ErrorAction SilentlyContinue | Select-Object -First 1
            if ((Test-Path $cfgFile) -and $listener) {
                # The URL carries the SYSTEM token: open it only when our daemon, not a squatter, holds the port.
                if ((Get-Process -Id $listener.OwningProcess).Path -ne (Join-Path $root "node\PocketDeskConsoleDaemon.exe")) { throw "port 8766 is held by another program; not opening the pairing page" }
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

$staged = Join-Path $InstallDir "PocketDeskLauncher.exe"
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
# An elevated daemon ignores an unelevated taskkill, so it is asked to stop over its loopback CLI port first.
try {
    $tok = (Get-Content (Join-Path $env:USERPROFILE ".pocketdesk\config.json") -Raw | ConvertFrom-Json).token
    Invoke-RestMethod -Method Post -Uri "http://127.0.0.1:4679/shutdown" -Headers @{ Authorization = "Bearer $tok" } -TimeoutSec 3 | Out-Null
    Start-Sleep -Seconds 2
} catch {}
# Whole trees, so the daemon's PowerShell and ffmpeg helpers go with it.
$running = @(Get-Process PocketDesk, PocketDeskTray -ErrorAction SilentlyContinue | ForEach-Object { $_.Id }) +
           @(Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue | ForEach-Object { $_.OwningProcess })
foreach ($id in $running | Sort-Object -Unique) { taskkill /T /F /PID $id 2>$null | Out-Null }
Start-Sleep -Milliseconds 300

# The daemon runs as PocketDesk.exe, a copy of node.exe, so Task Manager shows it by name.
$nodeExe = if (Test-Path $bundledNode) { $bundledNode } else { (Get-Command node).Source }
Copy-Item $nodeExe (Join-Path $InstallDir "PocketDesk.exe") -Force

# Always rebuilt: a release zip gives the source its commit time, often older than the previous exe.
& $csc /nologo /target:winexe /out:$staged /r:System.dll $src
if ($LASTEXITCODE -ne 0) { throw "compile failed" }

# The daemon runs as administrator, and this folder is writable by every program the user runs,
# so the launcher, node, daemon and ffmpeg are copied (one UAC prompt) to a per-user admin-only folder.
$protected = Join-Path $env:ProgramFiles ("PocketDesk\" + [Security.Principal.WindowsIdentity]::GetCurrent().User.Value)
$protectArgs = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-Protect', "`"$protected`"",
                 '-InstallDir', "`"$InstallDir`"", '-DaemonDir', "`"$DaemonDir`"")
Write-Host "  copying PocketDesk to $protected (elevation required)"
try { $p = Start-Process powershell -Verb RunAs -Wait -PassThru -WindowStyle Hidden -ArgumentList $protectArgs } catch { throw "elevation declined: PocketDesk needs it to install" }
if ($p.ExitCode -ne 0 -or -not (Test-Path (Join-Path $protected "PocketDesk.ini"))) { throw "copying PocketDesk to $protected failed" }
$exe = Join-Path $protected "PocketDeskLauncher.exe"
# Staged copies are not run; left here they would only invite elevating something any program can replace.
foreach ($f in "PocketDeskLauncher.exe", "PocketDesk.exe", "PocketDesk.ini") { Remove-Item (Join-Path $InstallDir $f) -Force -ErrorAction SilentlyContinue }

# Start Menu only: a click starts the daemon if needed and opens the pairing and settings page.
# No desktop icon, so outside Task Manager the daemon leaves nothing on screen.
$shell = New-Object -ComObject WScript.Shell
$lnk = $shell.CreateShortcut((Join-Path ([Environment]::GetFolderPath("Programs")) "PocketDesk.lnk"))
$lnk.TargetPath = $exe
$lnk.WorkingDirectory = $InstallDir
$lnk.Description = "Open PocketDesk pairing and settings"
$lnk.Save()
# Earlier installs also put one on the desktop.
Remove-Item (Join-Path ([Environment]::GetFolderPath("Desktop")) "PocketDesk.lnk") -ErrorAction SilentlyContinue

# Autostart is the Scheduled Task registered during the elevated copy above; clear the old Run-key
# autostart so the daemon never starts twice.
Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "PocketDesk" -ErrorAction SilentlyContinue

if (-not $NoStart) { Start-ScheduledTask -TaskName "PocketDesk" }
Write-Host "  hidden daemon installed; it starts at logon (Scheduled Task 'PocketDesk', auto-restarts on crash)."
Write-Host "  stop it: schtasks /End /TN PocketDesk (End alone; the task restarts it otherwise). settings: $env:USERPROFILE\.pocketdesk\config.json"
