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
foreach ($dir in @([Environment]::GetFolderPath("Programs"), [Environment]::GetFolderPath("Desktop"))) {
    Remove-Item (Join-Path $dir "PocketDesk.lnk") -ErrorAction SilentlyContinue
}
Remove-Item "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\PocketDesk" -Recurse -ErrorAction SilentlyContinue

# Console endpoint (only present if it was ever installed with -Console). Unregistering a
# SYSTEM task needs elevation; run this uninstall as administrator to remove it fully.
try { Stop-ScheduledTask -TaskName "PocketDeskConsole" -ErrorAction SilentlyContinue } catch {}
try { Unregister-ScheduledTask -TaskName "PocketDeskConsole" -Confirm:$false -ErrorAction SilentlyContinue } catch {}
Get-Process PocketDeskConsole -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-NetTCPConnection -State Listen -LocalPort 8766 -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
# The protected bin holds no secrets; the console token dir is kept unless -RemoveData (below).
$consoleBin = Join-Path $env:ProgramData "PocketDesk\bin"
if (Test-Path $consoleBin) { Remove-Item -Recurse -Force $consoleBin -ErrorAction SilentlyContinue }

if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
if ($RemoveData) {
    $data = Join-Path $env:USERPROFILE ".pocketdesk"
    if (Test-Path $data) { Remove-Item -Recurse -Force $data }
    $consoleData = Join-Path $env:ProgramData "PocketDesk"
    if (Test-Path $consoleData) { Remove-Item -Recurse -Force $consoleData -ErrorAction SilentlyContinue }
    Write-Host "PocketDesk and its settings are removed."
} else {
    Write-Host "PocketDesk is removed. Settings and paired phones are kept in $env:USERPROFILE\.pocketdesk."
}
