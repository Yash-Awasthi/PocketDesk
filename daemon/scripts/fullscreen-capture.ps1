<#
.SYNOPSIS
  Diagnose a black fullscreen game in PocketDesk, and make that game capturable.

.DESCRIPTION
  A true exclusive-fullscreen app takes the display away from the desktop compositor. While it holds
  it, Desktop Duplication answers DXGI_ERROR_ACCESS_LOST and GDI / Windows Graphics Capture read
  black: that is the OS design, not a permission, so running as administrator or SYSTEM changes
  nothing. A game that goes through Windows' fullscreen optimizations (emulated fullscreen exclusive)
  is still composited and PocketDesk captures it normally.

  Windows stores "Disable fullscreen optimizations" per executable in
  HKCU\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers. Clearing that flag for a
  title makes it present through the compositor again, which is what this script does when asked.

.PARAMETER Exe
  The game's executable: a full path (preferred) or its file name.

.PARAMETER EnableOptimizations
  Remove the disable-fullscreen-optimizations flag for that executable (the game must be restarted).

.PARAMETER DisableOptimizations
  Put the flag back.

.PARAMETER ToWindowed
  Send Alt+Enter to the exclusive app in front, the standard fullscreen toggle most games honour.
  When it works the title drops to a windowed/borderless mode that PocketDesk captures at once;
  when it does not, the app stays exclusive and nothing else changes.

.EXAMPLE
  powershell -ExecutionPolicy Bypass -File fullscreen-capture.ps1
  powershell -ExecutionPolicy Bypass -File fullscreen-capture.ps1 -Exe "C:\Games\Riddle\game.exe" -EnableOptimizations
#>
param(
  [string]$Exe,
  [switch]$EnableOptimizations,
  [switch]$DisableOptimizations,
  [switch]$ToWindowed
)

$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PdFullscreen {
  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int L, T, R, B; }
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] public static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr h, out RECT r);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("shell32.dll")] public static extern int SHQueryUserNotificationState(out int state);
  [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
  /** Alt+Enter: the fullscreen toggle most games listen for. */
  public static void ToggleFullscreen() {
    keybd_event(0x12, 0, 0, UIntPtr.Zero);  // Alt down
    keybd_event(0x0D, 0, 0, UIntPtr.Zero);  // Enter down
    keybd_event(0x0D, 0, 2, UIntPtr.Zero);  // Enter up
    keybd_event(0x12, 0, 2, UIntPtr.Zero);  // Alt up
  }
}
'@

$state = -1
[void][PdFullscreen]::SHQueryUserNotificationState([ref]$state)
$meaning = switch ($state) {
  1 { 'not present (screen off or a secure prompt is up)' }
  2 { 'a fullscreen app is in front (composed, still capturable)' }
  3 { 'a D3D app has taken the display: true exclusive fullscreen, not capturable by any user-mode API' }
  4 { 'presentation mode (composed, capturable)' }
  5 { 'normal desktop (composed, capturable)' }
  6 { 'quiet time, e.g. a video player asked for no interruptions (composed)' }
  7 { 'a Windows Store app is in front (composed)' }
  default { 'unreported by the shell' }
}
$hwnd = [PdFullscreen]::GetForegroundWindow()
$sb = New-Object System.Text.StringBuilder 256
[void][PdFullscreen]::GetWindowText($hwnd, $sb, $sb.Capacity)
$rect = New-Object PdFullscreen+RECT
[void][PdFullscreen]::GetWindowRect($hwnd, [ref]$rect)
$pid_ = 0
[void][PdFullscreen]::GetWindowThreadProcessId($hwnd, [ref]$pid_)
$proc = try { (Get-Process -Id $pid_ -ErrorAction Stop).ProcessName } catch { '?' }

Write-Host "PocketDesk capture state"
Write-Host "  SHQueryUserNotificationState : $state ($meaning)"
Write-Host "  foreground window            : '$($sb.ToString())'"
Write-Host "  process                      : $proc (pid $pid_)"
Write-Host "  window size                  : $($rect.R - $rect.L) x $($rect.B - $rect.T)"
Write-Host ''

if ($ToWindowed) {
  if ($state -ne 3) {
    Write-Host "No D3D exclusive-fullscreen app in front (state $state), nothing to knock out of it." -ForegroundColor Yellow
    exit 1
  }
  Write-Host 'Sending Alt+Enter to the exclusive app, the standard fullscreen toggle...'
  [PdFullscreen]::ToggleFullscreen()
  Start-Sleep -Milliseconds 1800
  $after = -1
  [void][PdFullscreen]::SHQueryUserNotificationState([ref]$after)
  if ($after -eq 3) {
    Write-Host 'Still exclusive: this title ignores Alt+Enter. Restart it with -EnableOptimizations set, or pick borderless in its own settings.' -ForegroundColor Yellow
    exit 1
  }
  Write-Host 'Left exclusive fullscreen: PocketDesk captures it now (the mirror resumes within a second).' -ForegroundColor Green
  exit 0
}

$layers = 'HKCU:\Software\Microsoft\Windows NT\CurrentVersion\AppCompatFlags\Layers'
$all = @{}
if (Test-Path $layers) {
  (Get-ItemProperty $layers).PSObject.Properties |
    Where-Object { $_.Name -notmatch '^PS(Path|ParentPath|ChildName|Drive|Provider)$' } |
    ForEach-Object { $all[$_.Name] = [string]$_.Value }
}

if (-not $Exe) {
  $flagged = $all.GetEnumerator() | Where-Object { $_.Value -match 'DISABLEDXMAXIMIZEDWINDOWEDMODE' }
  if ($flagged) {
    Write-Host 'Titles that asked Windows to disable fullscreen optimizations (these can go true-exclusive):'
    foreach ($e in $flagged) { Write-Host "  $($e.Key)" }
    Write-Host ''
    Write-Host 'Make one capturable (game must be closed first):'
    Write-Host '  fullscreen-capture.ps1 -Exe "<that path>" -EnableOptimizations'
  } else {
    Write-Host 'No title on this PC disables fullscreen optimizations.'
  }
  Write-Host ''
  Write-Host 'If a game is still black, it asks for exclusive fullscreen in code (D3D9/OpenGL/Vulkan or'
  Write-Host 'SetFullscreenState with mode switch): run it borderless in the game, or set its display mode'
  Write-Host 'to "borderless fullscreen"/"windowed fullscreen". See docs/EXCLUSIVE-FULLSCREEN.md.'
  exit 0
}

# Match either the full path or the bare file name Windows stores.
$key = $all.Keys | Where-Object { $_ -ieq $Exe -or (Split-Path $_ -Leaf) -ieq (Split-Path $Exe -Leaf) } | Select-Object -First 1
$current = if ($key) { $all[$key] } else { '' }
Write-Host "compat layers for '$Exe': $(if ($current) { $current } else { '(none)' })"

if ($EnableOptimizations -and $DisableOptimizations) { throw 'Pick one of -EnableOptimizations or -DisableOptimizations.' }

if ($EnableOptimizations) {
  if (-not $current) { Write-Host 'Already optimizations-on; nothing to change.'; exit 0 }
  $tokens = ($current -split '\s+') | Where-Object { $_ -and $_ -ne '~' -and $_ -ne 'DISABLEDXMAXIMIZEDWINDOWEDMODE' }
  if ($tokens.Count) { Set-ItemProperty $layers -Name $key -Value ('~ ' + ($tokens -join ' ')) }
  else { Remove-ItemProperty $layers -Name $key }
  Write-Host 'Fullscreen optimizations are on for it again. Restart the game, then mirror it.' -ForegroundColor Green
  exit 0
}

if ($DisableOptimizations) {
  $tokens = @(($current -split '\s+') | Where-Object { $_ -and $_ -ne '~' })
  if ($tokens -notcontains 'DISABLEDXMAXIMIZEDWINDOWEDMODE') { $tokens += 'DISABLEDXMAXIMIZEDWINDOWEDMODE' }
  if (-not (Test-Path $layers)) { New-Item -Path $layers -Force | Out-Null }
  if (-not $key) { $key = $Exe }
  Set-ItemProperty $layers -Name $key -Value ('~ ' + ($tokens -join ' '))
  Write-Host 'Flag restored. Restart the game for it to take effect.' -ForegroundColor Green
  exit 0
}

Write-Host ''
Write-Host 'Add -EnableOptimizations to make it capturable, or -DisableOptimizations to undo that.'
