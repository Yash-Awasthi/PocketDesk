# Removes PocketDesk installed by install.ps1: every running PocketDesk process, its autostart and the program files.
# Settings, keys and paired phones in %USERPROFILE%\.pocketdesk stay unless -RemoveData is given.
#
#   powershell -ExecutionPolicy Bypass -File uninstall.ps1 [-RemoveData]

param(
    [string]$InstallDir = "$env:LOCALAPPDATA\PocketDesk",
    [switch]$RemoveData
)
$ErrorActionPreference = "Stop"

# The console endpoint runs as SYSTEM, so only an elevated uninstall can stop and remove it.
$consoleRoot = Join-Path $env:ProgramData "PocketDesk"
$isAdmin = ([Security.Principal.WindowsPrincipal][Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltinRole]::Administrator)
if (-not $isAdmin -and (Test-Path (Join-Path $consoleRoot "bin"))) {
    $elevated = @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', "`"$PSCommandPath`"", '-InstallDir', "`"$InstallDir`"")
    if ($RemoveData) { $elevated += '-RemoveData' }
    try { Start-Process powershell -Verb RunAs -Wait -ArgumentList $elevated; exit } catch {
        Write-Warning "Not elevated: the console endpoint (SYSTEM) stays installed."
    }
}

# Every PocketDesk process, killed as a whole tree so its PowerShell helpers, ffmpeg and terminals go too.
# Matched by name, by the daemon ports, by binaries under the install folders, and by orphaned helpers.
function Stop-PocketDesk {
    $port = 8765
    try {
        $cfg = Get-Content (Join-Path $env:USERPROFILE ".pocketdesk\config.json") -Raw | ConvertFrom-Json
        if ($cfg.port) { $port = [int]$cfg.port }
    } catch {}
    $roots = @($InstallDir, (Join-Path $consoleRoot "bin")) | ForEach-Object { $_.TrimEnd('\') + '\' }
    $helpers = Join-Path $env:USERPROFILE ".pocketdesk\helpers\"
    $ids = @(Get-Process PocketDesk, PocketDeskTray, PocketDeskLauncher, PocketDeskConsole -ErrorAction SilentlyContinue | ForEach-Object { $_.Id })
    $ids += @(Get-NetTCPConnection -State Listen -ErrorAction SilentlyContinue | Where-Object { $_.LocalPort -in $port, 8766 } | ForEach-Object { $_.OwningProcess })
    $ids += @(Get-CimInstance Win32_Process | Where-Object {
        $exe = "$($_.ExecutablePath)"; $cmd = "$($_.CommandLine)"
        ($roots | Where-Object { $exe.StartsWith($_, [StringComparison]::OrdinalIgnoreCase) }) -or
            $cmd.IndexOf($helpers, [StringComparison]::OrdinalIgnoreCase) -ge 0
    } | ForEach-Object { $_.ProcessId })
    $self = @($PID, (Get-CimInstance Win32_Process -Filter "ProcessId=$PID").ParentProcessId)
    foreach ($id in $ids | Sort-Object -Unique | Where-Object { $_ -and $self -notcontains $_ }) {
        taskkill /T /F /PID $id 2>$null | Out-Null
    }
}

try { schtasks /End /TN "PocketDeskConsole" 2>$null | Out-Null } catch {}
Stop-PocketDesk
Start-Sleep -Milliseconds 500
Stop-PocketDesk

Remove-ItemProperty -Path "HKCU:\Software\Microsoft\Windows\CurrentVersion\Run" -Name "PocketDesk" -ErrorAction SilentlyContinue
foreach ($dir in @([Environment]::GetFolderPath("Programs"), [Environment]::GetFolderPath("Desktop"))) {
    Remove-Item (Join-Path $dir "PocketDesk.lnk") -ErrorAction SilentlyContinue
}
Remove-Item "HKCU:\Software\Microsoft\Windows\CurrentVersion\Uninstall\PocketDesk" -Recurse -ErrorAction SilentlyContinue

try { Unregister-ScheduledTask -TaskName "PocketDeskConsole" -Confirm:$false -ErrorAction SilentlyContinue } catch {}
# The protected bin holds no secrets; the console token dir is kept unless -RemoveData (below).
$consoleBin = Join-Path $consoleRoot "bin"
if (Test-Path $consoleBin) { Remove-Item -Recurse -Force $consoleBin -ErrorAction SilentlyContinue }

if (Test-Path $InstallDir) { Remove-Item -Recurse -Force $InstallDir }
if ($RemoveData) {
    $data = Join-Path $env:USERPROFILE ".pocketdesk"
    if (Test-Path $data) { Remove-Item -Recurse -Force $data }
    if (Test-Path $consoleRoot) { Remove-Item -Recurse -Force $consoleRoot -ErrorAction SilentlyContinue }
    Write-Host "PocketDesk and its settings are removed."
} else {
    Write-Host "PocketDesk is removed. Settings and paired phones are kept in $env:USERPROFILE\.pocketdesk."
}
