# Installs the PocketDesk tray app and registers it to start at logon.
# The tray owns the daemon lifecycle: green icon = daemon running.

$ErrorActionPreference = "Stop"

$repoDaemon = Split-Path -Parent $PSScriptRoot
$installDir = Join-Path $env:USERPROFILE ".pocketdesk"
$exe = Join-Path $installDir "PocketDeskTray.exe"
$src = Join-Path $PSScriptRoot "tray\PocketDeskTray.cs"
$csc = "C:\Windows\Microsoft.NET\Framework64\v4.0.30319\csc.exe"

if (-not (Test-Path $csc)) { throw "csc.exe not found at $csc" }
if (-not (Get-Command node -ErrorAction SilentlyContinue)) { throw "node.exe not found on PATH" }

New-Item -ItemType Directory -Force -Path $installDir | Out-Null

$needBuild = -not (Test-Path $exe) -or (Get-Item $src).LastWriteTime -gt (Get-Item $exe).LastWriteTime
if ($needBuild) {
    & $csc /nologo /target:winexe /out:$exe /r:System.dll /r:System.Drawing.dll /r:System.Windows.Forms.dll $src
    if ($LASTEXITCODE -ne 0) { throw "compile failed" }
}

# The tray spawns the daemon from the checkout it was installed from.
Set-Content -Path (Join-Path $installDir "PocketDeskTray.ini") -Value $repoDaemon

schtasks /Create /F /TN "PocketDesk" /SC LOGON /RL LIMITED /TR "`"$exe`"" | Out-Null
if ($LASTEXITCODE -ne 0) { throw "task registration failed (try an elevated PowerShell)" }

Start-Process $exe
Write-Host ""
Write-Host "  installed. tray icon is running; it will also start at logon."
Write-Host "  config: $installDir\config.json"
Write-Host ""
