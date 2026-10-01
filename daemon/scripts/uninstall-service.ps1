# Stops and unregisters the hidden PocketDesk daemon autostart.
# -Purge also deletes the console endpoint's paired token (kept by default, so
# the phone stays paired across a reinstall).

param([switch]$Purge)
$ErrorActionPreference = "Stop"
$port = 8765
try {
    $cfg = Get-Content (Join-Path $env:USERPROFILE ".pocketdesk\config.json") -Raw | ConvertFrom-Json
    if ($cfg.port) { $port = [int]$cfg.port }
} catch {}
Get-Process PocketDeskTray -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
Get-NetTCPConnection -State Listen -LocalPort $port -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }
Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "PocketDesk" -ErrorAction SilentlyContinue
# Older installs registered a scheduled task instead.
try { schtasks /Delete /F /TN "PocketDesk" 2>$null | Out-Null } catch {}

# Console endpoint: stop the SYSTEM launcher + its daemon, then unregister the task.
try { Stop-ScheduledTask -TaskName "PocketDeskConsole" -ErrorAction SilentlyContinue } catch {}
try { Unregister-ScheduledTask -TaskName "PocketDeskConsole" -Confirm:$false -ErrorAction SilentlyContinue } catch {}
Get-Process PocketDeskConsole -ErrorAction SilentlyContinue | Stop-Process -Force -ErrorAction SilentlyContinue
# The listener on 8766 is the console daemon, whichever session it runs in.
Get-NetTCPConnection -State Listen -LocalPort 8766 -ErrorAction SilentlyContinue |
    ForEach-Object { Stop-Process -Id $_.OwningProcess -Force -ErrorAction SilentlyContinue }

# The protected bin (launcher + node + daemon copy) holds no secrets — always remove it.
$consoleBin = Join-Path $env:ProgramData "PocketDesk\bin"
if (Test-Path $consoleBin) { Remove-Item -Recurse -Force $consoleBin -ErrorAction SilentlyContinue }

$consoleHome = Join-Path $env:ProgramData "PocketDesk\console"
if ($Purge -and (Test-Path $consoleHome)) {
    Remove-Item -Recurse -Force $consoleHome -ErrorAction SilentlyContinue
    Write-Host "removed. tray autostart and console endpoint gone, including the paired token (-Purge)."
} else {
    Write-Host "removed. tray autostart and console endpoint gone. Console token kept in $consoleHome (use -Purge to delete)."
}
