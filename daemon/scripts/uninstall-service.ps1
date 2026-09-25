# Stops and unregisters the PocketDesk tray/daemon autostart.

$ErrorActionPreference = "Stop"
Get-Process PocketDeskTray -ErrorAction SilentlyContinue | Stop-Process -Force
Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "PocketDesk" -ErrorAction SilentlyContinue
# Older installs registered a scheduled task instead.
try { schtasks /Delete /F /TN "PocketDesk" 2>$null | Out-Null } catch {}
Write-Host "removed. the daemon is no longer registered to start at logon."
