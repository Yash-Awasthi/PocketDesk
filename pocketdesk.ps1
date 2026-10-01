# Single entry point: installs PocketDesk if it isn't present, or offers to update/uninstall if it is.
#
#   irm https://raw.githubusercontent.com/Yash-Awasthi/PocketDesk/master/pocketdesk.ps1 | iex
#
# Just dispatches to install.ps1 / uninstall.ps1 — see those for what each does.
param(
    [string]$InstallDir = "$env:LOCALAPPDATA\PocketDesk",
    [switch]$Uninstall,
    [switch]$RemoveData
)
$ErrorActionPreference = "Stop"
$here = $PSScriptRoot
$uninstallKey = "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\PocketDesk"
$installed = (Test-Path $uninstallKey) -or (Test-Path (Join-Path $InstallDir "app\daemon"))

function Get-Script($name) {
    # Local checkout has it next to this file; piped from curl/irm, fetch it alongside.
    $local = Join-Path $here $name
    if ($here -and (Test-Path $local)) { return $local }
    $tmp = Join-Path $env:TEMP $name
    Invoke-WebRequest -UseBasicParsing -Uri "https://raw.githubusercontent.com/Yash-Awasthi/PocketDesk/master/$name" -OutFile $tmp
    return $tmp
}

if ($Uninstall) {
    if (-not $installed) { Write-Host "PocketDesk is not installed." -ForegroundColor Yellow; exit }
    & (Get-Script "uninstall.ps1") -InstallDir $InstallDir -RemoveData:$RemoveData
    exit
}

if (-not $installed) {
    & (Get-Script "install.ps1") -InstallDir $InstallDir
    exit
}

Write-Host "PocketDesk is already installed in $InstallDir." -ForegroundColor Cyan
$choice = Read-Host "[U]pdate, [R]emove, or [C]ancel?"
switch ($choice.ToUpper()) {
    "U" { & (Get-Script "install.ps1") -InstallDir $InstallDir }
    "R" { & (Get-Script "uninstall.ps1") -InstallDir $InstallDir }
    default { Write-Host "Cancelled." }
}
