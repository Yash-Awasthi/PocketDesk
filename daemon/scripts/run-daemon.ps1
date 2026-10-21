# Runs the daemon in the foreground for the PocketDesk scheduled task using signed binaries only
# (conhost, powershell, node): Smart App Control refuses the locally compiled launcher.
# Mirrors PocketDeskLauncher --supervise; lives in the admin-only install folder like the launcher.

# NODE_* come from the user's environment and would load code into the elevated node.
Get-ChildItem Env: | Where-Object Name -like "NODE_*" | ForEach-Object { Remove-Item "Env:$($_.Name)" }
$root = Split-Path (Split-Path $PSScriptRoot)
# Set even when missing, so the daemon falls back to JPEG instead of an ffmpeg found on PATH.
$env:FFMPEG_PATH = Join-Path $root "ffmpeg\ffmpeg.exe"
Set-Location (Join-Path $root "daemon")
& (Join-Path $root "PocketDesk.exe") src\index.js
exit $LASTEXITCODE
