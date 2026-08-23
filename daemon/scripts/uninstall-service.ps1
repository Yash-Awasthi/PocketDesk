# Stops and unregisters the PocketDesk tray/daemon autostart.

$ErrorActionPreference = "Stop"
schtasks /End /TN "PocketDesk" 2>$null
Get-Process PocketDeskTray -ErrorAction SilentlyContinue | Stop-Process -Force
schtasks /Delete /F /TN "PocketDesk"
Write-Host "removed. the daemon is no longer registered to start at logon."
