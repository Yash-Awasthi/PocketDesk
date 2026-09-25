# Installs the PocketDesk tray app and registers it to start at logon.
# The tray owns the daemon lifecycle: green icon = daemon running.
#
# From a checkout (development): powershell -File daemon\scripts\install-service.ps1
# install.ps1 at the repo root calls this with -DaemonDir/-InstallDir for a normal install.

param(
    [string]$DaemonDir = (Split-Path -Parent $PSScriptRoot),
    [string]$InstallDir = (Join-Path $env:USERPROFILE ".pocketdesk"),
    [switch]$NoStart
)
$ErrorActionPreference = "Stop"

$exe = Join-Path $InstallDir "PocketDeskTray.exe"
$src = Join-Path $PSScriptRoot "tray\PocketDeskTray.cs"
$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"

if (-not (Test-Path $csc)) { throw "csc.exe not found at $csc" }
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
