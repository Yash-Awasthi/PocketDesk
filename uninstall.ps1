# Removes PocketDesk installed by install.ps1: the tray, its autostart and the program files.
# Settings, keys and paired phones in %USERPROFILE%\.pocketdesk stay unless -RemoveData is given.
#
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1 [-RemoveData]

param(
    [string]$InstallDir = "$env:LOCALAPPDATA\PocketDesk",
    [switch]$RemoveData
)
$ErrorActionPreference = "Stop"

# The tray owns the daemon; stop the daemon first so its port and files are released.
foreach ($t in @(Get-CimInstance Win32_Process -Filter "Name='PocketDeskTray.exe'")) {
    Get-CimInstance Win32_Process -Filter "ParentProcessId=$($t.ProcessId)" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }
    Stop-Process -Id $t.ProcessId -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Milliseconds 500
Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "PocketDesk" -ErrorAction SilentlyContinue
if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
if ($RemoveData) {
    $data = Join-Path $env:USERPROFILE ".pocketdesk"
    if (Test-Path $data) { Remove-Item -Recurse -Force $data }
    Write-Host "PocketDesk and its settings are removed."
} else {
    Write-Host "PocketDesk is removed. Settings and paired phones are kept in $env:USERPROFILE\.pocketdesk."
}
