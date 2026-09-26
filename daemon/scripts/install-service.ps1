# Installs the PocketDesk tray app and registers it to start at logon.
# The tray owns the daemon lifecycle: green icon = daemon running.
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
    $consoleExe = Join-Path $InstallDir "PocketDeskConsole.exe"
    New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

    # Stop a running launcher + its console daemon before replacing the exe.
    schtasks /End /TN "PocketDeskConsole" 2>$null | Out-Null
    Get-Process PocketDeskConsole -ErrorAction SilentlyContinue | Stop-Process -Force
    Get-NetTCPConnection -State Listen -LocalPort 8766 -ErrorAction SilentlyContinue |
        ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
    Start-Sleep -Milliseconds 500

    $needBuild = -not (Test-Path $consoleExe) -or (Get-Item $consoleSrc).LastWriteTime -gt (Get-Item $consoleExe).LastWriteTime
    if ($needBuild) {
        & $csc /nologo /target:exe /out:$consoleExe /r:System.dll $consoleSrc
        if ($LASTEXITCODE -ne 0) { throw "console launcher compile failed" }
    }

    # The launcher reads its daemon dir from this ini, exactly like the tray.
    Set-Content -Path (Join-Path $InstallDir "PocketDeskConsole.ini") -Value $DaemonDir

    # SYSTEM-only config dir: the token that lands here opens a SYSTEM daemon.
    $consoleHome = Join-Path $env:ProgramData "PocketDesk\console"
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
                Start-Process "https://localhost:8766/pair"
                break
            }
            Start-Sleep -Seconds 1
        }
    }
    Write-Host "  console endpoint installed (SYSTEM task 'PocketDeskConsole', port 8766)."
    Write-Host "  pair it from the QR at https://localhost:8766/pair  (entry: PC (console))."
    return
}

$exe = Join-Path $InstallDir "PocketDeskTray.exe"
$src = Join-Path $PSScriptRoot "tray\PocketDeskTray.cs"

# The tray prefers a node.exe next to it (install.ps1 puts one there), then PATH.
$bundledNode = Join-Path $InstallDir "node\node.exe"
if (-not (Test-Path $bundledNode) -and -not (Get-Command node -ErrorAction SilentlyContinue)) { throw "node.exe not found on PATH" }

New-Item -ItemType Directory -Force -Path $InstallDir | Out-Null

# A running tray locks its exe and owns a daemon on the port; stop both before replacing it.
foreach ($t in @(Get-CimInstance Win32_Process -Filter "Name='PocketDeskTray.exe'")) {
    Get-CimInstance Win32_Process -Filter "ParentProcessId=$($t.ProcessId)" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Stop-Process -Id $t.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Milliseconds 500

$needBuild = -not (Test-Path $exe) -or (Get-Item $src).LastWriteTime -gt (Get-Item $exe).LastWriteTime
if ($needBuild) {
    & $csc /nologo /target:winexe /out:$exe /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll $src
    if ($LASTEXITCODE -ne 0) { throw "compile failed" }
}

# The tray spawns the daemon from this folder.
Set-Content -Path (Join-Path $InstallDir "PocketDeskTray.ini") -Value $DaemonDir

# The per-user Run key starts the tray at logon without admin rights.
Set-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "PocketDesk" -Value "`"$exe`""

if (-not $NoStart) { Start-Process $exe }
Write-Host "  tray installed; it starts at logon. settings: $env:USERPROFILE\.pocketdesk\config.json"
