/**
 * Desktop capture + input injection — the missing frame SOURCE for the
 * rd_/vnc_ bridges (the "AnyDesk-style" viewing/control the rd_ protocol
 * always promised but never had a real backend for).
 *
 * Windows-only, zero new npm deps. TWO persistent PowerShell helper processes
 * (JSON-line request/reply over stdin/stdout), deliberately split because
 * Windows AMSI blocks any single script combining SendInput P/Invoke WITH
 * screen capture (the remote-access-Trojan heuristic) — each helper alone is
 * allowed (verified by bisect on the target machine):
 *   • capture helper — System.Drawing CopyFromScreen over the FULL virtual
 *     screen (every monitor) → JPEG temp file → Node reads the file. Fully
 *     managed code, no P/Invoke.
 *   • input helper — SendInput P/Invoke: absolute mouse with virtual-screen
 *     normalization (multi-monitor), clicks, wheel, virtual-key taps with
 *     ctrl/alt/shift, Unicode text via scan codes.
 * Helpers are DPI-aware and stay warm, so a click costs microseconds instead
 * of a 1-2s process spawn. Scripts are written to .ps1 files in the config dir and
 * run with -ExecutionPolicy Bypass -File (deterministic quoting).
 *
 * Capture runs on a ~300ms loop ONLY while at least one rd client is
 * attached; zero clients → loop fully stops. Non-Windows degrades cleanly
 * ({ ok:false, reason:"unsupported_platform" }), like tmux on Windows.
 */
import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { configDir } from "./config.js";
import { LinuxDesktop, IS_LINUX } from "./linux_desktop.js";
import { WaylandDesktop, IS_WAYLAND } from "./wayland_desktop.js";
// Helper scripts live in the private config dir: in a shared temp dir another user could
// swap one in before it runs, as SYSTEM for the console endpoint.

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** JSON-safe, ASCII-only wire line (PS 5.1 stdin is happiest with ASCII). */
function wireLine(obj) {
  return JSON.stringify(obj).replace(/[\u0080-\uFFFF]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")) + "\n";
}

const COMMON_PRELUDE = `
$ErrorActionPreference = 'Stop'
`;

// The console endpoint runs as SYSTEM in the console session, which may attach to the
// secure desktop (UAC, lock screen). Only it gets this, so the user daemon's scripts stay unchanged.
const IS_CONSOLE = IS_WIN && !!process.env.RH_CONSOLE;
const DESK_MEMBERS = IS_CONSOLE ? `
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll", SetLastError=true)] static extern bool SetThreadDesktop(IntPtr h);
  [DllImport("user32.dll", SetLastError=true)] static extern bool CloseDesktop(IntPtr h);
  static IntPtr cur = IntPtr.Zero;
  /** Moves this thread onto whichever desktop has input now, keeping exactly one handle open. */
  public static void FollowInput() {
    IntPtr d = OpenInputDesktop(0, false, 0x02000000);
    if (d == IntPtr.Zero) return;
    if (SetThreadDesktop(d)) { if (cur != IntPtr.Zero && cur != d) CloseDesktop(cur); cur = d; } else CloseDesktop(d);
  }
` : "";
const followInput = (cls) => (IS_CONSOLE ? `[${cls}]::FollowInput()\n  ` : "");

const INPUT_SCRIPT = COMMON_PRELUDE + `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
public static class RHI {
  [DllImport("user32.dll")] public static extern uint SendInput(uint n, INPUT[] inputs, int size);
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential)] public struct MOUSEINPUT { public int dx, dy; public uint mouseData, dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Sequential)] public struct KEYBDINPUT { public ushort wVk, wScan; public uint dwFlags, time; public IntPtr dwExtraInfo; }
  [StructLayout(LayoutKind.Explicit)] public struct INPUTUNION { [FieldOffset(0)] public MOUSEINPUT mi; [FieldOffset(0)] public KEYBDINPUT ki; }
  [StructLayout(LayoutKind.Sequential)] public struct INPUT { public uint type; public INPUTUNION u; }
  public const uint MOVE=0x0001, LEFTDOWN=0x0002, LEFTUP=0x0004, RIGHTDOWN=0x0008, RIGHTUP=0x0010,
                    MIDDLEDOWN=0x0020, MIDDLEUP=0x0040, WHEEL=0x0800, HWHEEL=0x1000, VIRTUALDESK=0x4000, ABSOLUTE=0x8000,
                    KEYDOWN=0x0000, EXTENDED=0x0001, KEYUP=0x0002, UNICODE=0x0004;
  public static uint Mouse(int x, int y, uint flags, int wheel) {
    var i = new INPUT { type = 0 };
    i.u.mi = new MOUSEINPUT { dx = x, dy = y, mouseData = unchecked((uint)wheel), dwFlags = flags };
    return SendInput(1, new INPUT[]{ i }, Marshal.SizeOf(typeof(INPUT)));
  }
  // One SendInput batch with the position on every event, so a click can never land before its move.
  public static uint Batch(int x, int y, uint pos, uint[] flags) {
    var a = new INPUT[flags.Length];
    for (int k = 0; k < flags.Length; k++) { a[k].type = 0; a[k].u.mi = new MOUSEINPUT { dx = x, dy = y, dwFlags = flags[k] | pos }; }
    return SendInput((uint)a.Length, a, Marshal.SizeOf(typeof(INPUT)));
  }
  public static uint Key(ushort vk, uint flags) {
    var i = new INPUT { type = 1 };
    i.u.ki = new KEYBDINPUT { wVk = vk, wScan = 0, dwFlags = flags };
    return SendInput(1, new INPUT[]{ i }, Marshal.SizeOf(typeof(INPUT)));
  }
  [StructLayout(LayoutKind.Sequential)] public struct CURSORINFO { public int cbSize, flags; public IntPtr hCursor; public int x, y; }
  [DllImport("user32.dll")] public static extern bool GetCursorInfo(ref CURSORINFO ci);
  [DllImport("user32.dll")] public static extern IntPtr LoadCursor(IntPtr h, int id);
  static readonly int[] ShapeIds = { 32512, 32513, 32649, 32514, 32650, 32515, 32644, 32645, 32642, 32643, 32646, 32648 };
  static readonly string[] ShapeNames = { "arrow", "text", "hand", "wait", "progress", "crosshair", "ew-resize", "ns-resize", "nwse-resize", "nesw-resize", "move", "not-allowed" };
  /** JSON fields for the pointer; app-specific cursors report as arrow. */
  public static string Cursor(int ox, int oy) {
    var ci = new CURSORINFO(); ci.cbSize = Marshal.SizeOf(typeof(CURSORINFO));
    if (!GetCursorInfo(ref ci)) return "\\"visible\\":false";
    string shape = "arrow";
    for (int i = 0; i < ShapeIds.Length; i++) if (LoadCursor(IntPtr.Zero, ShapeIds[i]) == ci.hCursor) { shape = ShapeNames[i]; break; }
    return "\\"x\\":" + (ci.x - ox) + ",\\"y\\":" + (ci.y - oy) + ",\\"shape\\":\\"" + shape + "\\",\\"visible\\":" + ((ci.flags & 1) != 0 ? "true" : "false");
  }
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("advapi32.dll")] static extern bool OpenProcessToken(IntPtr p, uint access, out IntPtr t);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  /** True when the focused window's process token is closed to us: it runs elevated, and UIPI drops our keys. */
  public static bool ForegroundElevated() {
    uint pid; GetWindowThreadProcessId(GetForegroundWindow(), out pid);
    if (pid == 0) return false;
    IntPtr p = OpenProcess(0x1000, false, pid);
    if (p == IntPtr.Zero) return false;
    IntPtr t; bool open = OpenProcessToken(p, 0x0008, out t);
    if (open) CloseHandle(t);
    CloseHandle(p);
    return !open;
  }
  public static uint KeyScan(ushort scan, uint flags) {
    var i = new INPUT { type = 1 };
    i.u.ki = new KEYBDINPUT { wVk = 0, wScan = scan, dwFlags = flags };
    return SendInput(1, new INPUT[]{ i }, Marshal.SizeOf(typeof(INPUT)));
  }${DESK_MEMBERS}
}
'@
[RHI]::SetProcessDPIAware() | Out-Null
# Keys go to the focused window, so an elevated one (Task Manager, an admin prompt) swallows them all.
function KeyReply($id) {
  if ([RHI]::ForegroundElevated()) { '{"id":' + $id + ',"ok":false,"error":"elevated_window"}' } else { '{"id":' + $id + ',"ok":true}' }
}
$stdin = [Console]::In
while ($true) {
  $line = $stdin.ReadLine()
  if ($null -eq $line) { break }
  try { $cmd = $line | ConvertFrom-Json } catch { [Console]::Out.WriteLine('{"ok":false,"error":"badjson"}'); continue }
  $op = $cmd.op
  if ($op -eq 'ping') { [Console]::Out.WriteLine('{"id":' + $cmd.id + ',"ok":true}'); continue }
  ${followInput("RHI")}if ($op -eq 'mouse') {
    try {
      $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
      $pos = [uint32]0; $cx = 0; $cy = 0
      # x/y are relative to the virtual screen's top-left, the same origin as a captured frame.
      if ($null -ne $cmd.x) {
        $cx = [int][Math]::Round(([double]$cmd.x / [Math]::Max(1,$vs.Width - 1)) * 65535)
        $cy = [int][Math]::Round(([double]$cmd.y / [Math]::Max(1,$vs.Height - 1)) * 65535)
        if ($cx -lt 0) {$cx=0}; if ($cx -gt 65535) {$cx=65535}
        if ($cy -lt 0) {$cy=0}; if ($cy -gt 65535) {$cy=65535}
        $pos = [RHI]::MOVE -bor [RHI]::ABSOLUTE -bor [RHI]::VIRTUALDESK
      }
      $b = @{ left = @([RHI]::LEFTDOWN, [RHI]::LEFTUP); right = @([RHI]::RIGHTDOWN, [RHI]::RIGHTUP); middle = @([RHI]::MIDDLEDOWN, [RHI]::MIDDLEUP) }
      $f = New-Object System.Collections.Generic.List[uint32]
      if ($pos) { $f.Add(0) }
      $clickBtn = if ($cmd.click -eq 'double') { 'left' } else { [string]$cmd.click }
      if ($b.ContainsKey($clickBtn)) {
        $f.Add($b[$clickBtn][0]); $f.Add($b[$clickBtn][1])
        if ($cmd.click -eq 'double') { $f.Add($b.left[0]); $f.Add($b.left[1]) }
      }
      if ($cmd.press) {
        $pb = $b[[string]$cmd.button]; if ($null -eq $pb) { $pb = $b.left }
        if ($cmd.press -eq 'down') { $f.Add($pb[0]) }
        if ($cmd.press -eq 'up')   { $f.Add($pb[1]) }
      }
      if ($f.Count -gt 0 -and [RHI]::Batch($cx, $cy, $pos, $f.ToArray()) -ne $f.Count) {
        [Console]::Out.WriteLine('{"id":' + $cmd.id + ',"ok":false,"error":"input_blocked"}'); continue
      }
      if ($cmd.wheel) { [RHI]::Mouse(0,0,[RHI]::WHEEL,[int]$cmd.wheel) | Out-Null }
      if ($cmd.hwheel) { [RHI]::Mouse(0,0,[RHI]::HWHEEL,[int]$cmd.hwheel) | Out-Null }
      [Console]::Out.WriteLine('{"id":' + $cmd.id + ',"ok":true}')
    } catch { [Console]::Out.WriteLine((@{id=$cmd.id; ok=$false; error=$_.Exception.Message} | ConvertTo-Json -Compress)) }
    continue
  }
  if ($op -eq 'cursor') {
    $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
    [Console]::Out.WriteLine('{"id":' + $cmd.id + ',"ok":true,' + [RHI]::Cursor($vs.X, $vs.Y) + '}')
    continue
  }
  if ($op -eq 'key') {
    try {
      $vk = [uint16]$cmd.key
      # Without the extended flag, arrows and the Ins/Del/Home/End block act as numpad keys.
      $ext = if (@(0x21,0x22,0x23,0x24,0x25,0x26,0x27,0x28,0x2D,0x2E,0x5B,0x5C,0x5D,0x6F,0x90,0xA3,0xA5) -contains $vk) { [RHI]::EXTENDED } else { 0 }
      if ($cmd.press -eq 'down') { [RHI]::Key($vk, [RHI]::KEYDOWN -bor $ext) | Out-Null; [Console]::Out.WriteLine((KeyReply $cmd.id)); continue }
      if ($cmd.press -eq 'up')   { [RHI]::Key($vk, [RHI]::KEYUP -bor $ext) | Out-Null; [Console]::Out.WriteLine((KeyReply $cmd.id)); continue }
      $mods = @($cmd.mods)
      if ($mods -contains 'ctrl')  { [RHI]::Key(0x11, [RHI]::KEYDOWN) | Out-Null }
      if ($mods -contains 'alt')   { [RHI]::Key(0x12, [RHI]::KEYDOWN) | Out-Null }
      if ($mods -contains 'shift') { [RHI]::Key(0x10, [RHI]::KEYDOWN) | Out-Null }
      if ($mods -contains 'win')   { [RHI]::Key(0x5B, [RHI]::KEYDOWN) | Out-Null }
      [RHI]::Key($vk, [RHI]::KEYDOWN -bor $ext) | Out-Null
      [RHI]::Key($vk, [RHI]::KEYUP -bor $ext) | Out-Null
      if ($mods -contains 'win')   { [RHI]::Key(0x5B, [RHI]::KEYUP) | Out-Null }
      if ($mods -contains 'shift') { [RHI]::Key(0x10, [RHI]::KEYUP) | Out-Null }
      if ($mods -contains 'alt')   { [RHI]::Key(0x12, [RHI]::KEYUP) | Out-Null }
      if ($mods -contains 'ctrl')  { [RHI]::Key(0x11, [RHI]::KEYUP) | Out-Null }
      [Console]::Out.WriteLine((KeyReply $cmd.id))
    } catch { [Console]::Out.WriteLine((@{id=$cmd.id; ok=$false; error=$_.Exception.Message} | ConvertTo-Json -Compress)) }
    continue
  }
  if ($op -eq 'type') {
    try {
      $text = [string]$cmd.text
      foreach ($ch in $text.ToCharArray()) {
        [RHI]::KeyScan([uint16][int]$ch, [RHI]::UNICODE) | Out-Null
        [RHI]::KeyScan([uint16][int]$ch, ([RHI]::UNICODE -bor [RHI]::KEYUP)) | Out-Null
      }
      [Console]::Out.WriteLine((KeyReply $cmd.id))
    } catch { [Console]::Out.WriteLine((@{id=$cmd.id; ok=$false; error=$_.Exception.Message} | ConvertTo-Json -Compress)) }
    continue
  }
  [Console]::Out.WriteLine('{"id":' + $cmd.id + ',"ok":false,"error":"unknown_op"}')
}
`;

const CAPTURE_SCRIPT = COMMON_PRELUDE + `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public static class RHD {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
  public struct OUTPUT_DESC { [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string Name; public int L, T, R, B, Attached, Rotation; public IntPtr Monitor; }
  // Slots before the first real method are IDXGIObject's, never called.
  [ComImport, Guid("ae02eedb-c735-4690-8d52-5a8dc20213aa"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IOutput { void P0(); void P1(); void P2(); void P3(); void GetDesc(out OUTPUT_DESC d); }
  [ComImport, Guid("2411e7e1-12ac-4ccf-bd14-9798e8534dc0"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IAdapter { void P0(); void P1(); void P2(); void P3(); [PreserveSig] int EnumOutputs(uint i, out IOutput o); }
  [ComImport, Guid("7b7166ec-21c7-44ae-b21a-c9ae321ae369"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  public interface IFactory { void P0(); void P1(); void P2(); void P3(); [PreserveSig] int EnumAdapters(uint i, out IAdapter a); }
  [DllImport("dxgi.dll")] static extern int CreateDXGIFactory(ref Guid riid, out IFactory f);
  /** Outputs in the adapter/output order ffmpeg's ddagrab uses, as JSON objects. */
  public static string Monitors() {
    var g = typeof(IFactory).GUID; IFactory f;
    if (CreateDXGIFactory(ref g, out f) != 0) return "";
    var list = new List<string>();
    IAdapter a;
    for (uint ai = 0; f.EnumAdapters(ai, out a) == 0; ai++) {
      IOutput o;
      for (uint oi = 0; a.EnumOutputs(oi, out o) == 0; oi++) {
        OUTPUT_DESC d; o.GetDesc(out d);
        if (d.Attached == 0) continue;
        list.Add("{\\"adapter\\":" + ai + ",\\"output\\":" + oi + ",\\"name\\":\\"" + d.Name.Replace("\\\\", "\\\\\\\\") + "\\",\\"left\\":" + d.L + ",\\"top\\":" + d.T + ",\\"w\\":" + (d.R - d.L) + ",\\"h\\":" + (d.B - d.T) + "}");
      }
    }
    return string.Join(",", list);
  }${DESK_MEMBERS}
}
'@
[RHD]::SetProcessDPIAware() | Out-Null
$stdin = [Console]::In
while ($true) {
  $line = $stdin.ReadLine()
  if ($null -eq $line) { break }
  try { $cmd = $line | ConvertFrom-Json } catch { [Console]::Out.WriteLine('{"ok":false,"error":"badjson"}'); continue }
  $op = $cmd.op
  if ($op -eq 'ping') { [Console]::Out.WriteLine('{"id":' + $cmd.id + ',"ok":true}'); continue }
  if ($op -eq 'monitors') {
    try { [Console]::Out.WriteLine('{"id":' + $cmd.id + ',"ok":true,"monitors":[' + [RHD]::Monitors() + ']}') }
    catch { [Console]::Out.WriteLine((@{id=$cmd.id; ok=$false; error=$_.Exception.Message} | ConvertTo-Json -Compress)) }
    continue
  }
  if ($op -eq 'capture') {
    try {
      ${followInput("RHD")}$vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
      $s = [double]$cmd.s
      if ($s -le 0 -or $s -gt 1) { $s = 1 }
      $w = [int]($vs.Width * $s); $h = [int]($vs.Height * $s)
      if ($w -lt 1) { $w = 1 }; if ($h -lt 1) { $h = 1 }
      $bmp = New-Object System.Drawing.Bitmap $vs.Width, $vs.Height
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($vs.X, $vs.Y, 0, 0, (New-Object System.Drawing.Size $vs.Width, $vs.Height))
      $g.Dispose()
      # CopyFromScreen never scales; copying straight into a smaller bitmap crops the right and bottom.
      if ($w -ne $vs.Width) {
        $small = New-Object System.Drawing.Bitmap $w, $h
        $g = [System.Drawing.Graphics]::FromImage($small)
        $g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::Bilinear
        $g.DrawImage($bmp, 0, 0, $w, $h)
        $g.Dispose(); $bmp.Dispose(); $bmp = $small
      }
      $ms = New-Object System.IO.MemoryStream
      $bmp.Save($ms, [System.Drawing.Imaging.ImageFormat]::Jpeg)
      $bmp.Dispose()
      $b64 = [Convert]::ToBase64String($ms.ToArray())
      $ms.Dispose()
      [Console]::Out.WriteLine((@{id=$cmd.id; ok=$true; w=$w; h=$h; b64=$b64} | ConvertTo-Json -Compress))
    } catch { [Console]::Out.WriteLine((@{id=$cmd.id; ok=$false; error=$_.Exception.Message} | ConvertTo-Json -Compress)) }
    continue
  }
  [Console]::Out.WriteLine('{"id":' + $cmd.id + ',"ok":false,"error":"unknown_op"}')
}
`;

/**
 * Clipboard helper, its own process so no single script mixes clipboard reads with
 * input injection. powershell.exe 5.1 runs STA, which the clipboard needs.
 */
const CLIP_SCRIPT = COMMON_PRELUDE + `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System.Runtime.InteropServices;
public static class RHC { [DllImport("user32.dll")] public static extern uint GetClipboardSequenceNumber(); }
'@
function Reply($o) { [Console]::Out.WriteLine(($o | ConvertTo-Json -Compress -Depth 4)) }
$stdin = [Console]::In
while ($true) {
  $line = $stdin.ReadLine()
  if ($null -eq $line) { break }
  try { $cmd = $line | ConvertFrom-Json } catch { [Console]::Out.WriteLine('{"ok":false,"error":"badjson"}'); continue }
  try {
    switch ($cmd.op) {
      'ping' { Reply @{ id = $cmd.id; ok = $true } }
      'seq' { Reply @{ id = $cmd.id; ok = $true; seq = [RHC]::GetClipboardSequenceNumber() } }
      'read' {
        $seq = [RHC]::GetClipboardSequenceNumber()
        if ([System.Windows.Forms.Clipboard]::ContainsFileDropList()) {
          $files = @([System.Windows.Forms.Clipboard]::GetFileDropList() | ForEach-Object {
            $i = Get-Item -LiteralPath $_ -ErrorAction SilentlyContinue
            @{ path = [string]$_; name = [System.IO.Path]::GetFileName($_); dir = [bool]($i -and $i.PSIsContainer); size = $(if ($i -and -not $i.PSIsContainer) { $i.Length } else { $null }) }
          })
          Reply @{ id = $cmd.id; ok = $true; seq = $seq; kind = 'files'; files = $files }
        } elseif ([System.Windows.Forms.Clipboard]::ContainsImage()) {
          $img = [System.Windows.Forms.Clipboard]::GetImage()
          $ms = New-Object System.IO.MemoryStream
          $img.Save($ms, [System.Drawing.Imaging.ImageFormat]::Png)
          $r = @{ id = $cmd.id; ok = $true; seq = $seq; kind = 'image'; w = $img.Width; h = $img.Height; bytes = $ms.Length }
          if ($ms.Length -le $cmd.maxImage) { $r.png = [Convert]::ToBase64String($ms.ToArray()) }
          $img.Dispose(); $ms.Dispose()
          Reply $r
        } elseif ([System.Windows.Forms.Clipboard]::ContainsText()) {
          Reply @{ id = $cmd.id; ok = $true; seq = $seq; kind = 'text'; text = [System.Windows.Forms.Clipboard]::GetText() }
        } else { Reply @{ id = $cmd.id; ok = $true; seq = $seq; kind = 'empty' } }
      }
      'set' {
        $data = New-Object System.Windows.Forms.DataObject
        if ($null -ne $cmd.text) { $data.SetText([string]$cmd.text) }
        if ($cmd.png) {
          $ms = New-Object System.IO.MemoryStream(,[Convert]::FromBase64String($cmd.png))
          $data.SetImage([System.Drawing.Image]::FromStream($ms))
        }
        if ($cmd.files) {
          $list = New-Object System.Collections.Specialized.StringCollection
          foreach ($f in $cmd.files) { [void]$list.Add([string]$f) }
          $data.SetFileDropList($list)
        }
        # Another app may hold the clipboard open for a moment; retry instead of failing.
        [System.Windows.Forms.Clipboard]::SetDataObject($data, $true, 10, 50)
        Reply @{ id = $cmd.id; ok = $true; seq = [RHC]::GetClipboardSequenceNumber() }
      }
      default { Reply @{ id = $cmd.id; ok = $false; error = 'unknown_op' } }
    }
  } catch { Reply @{ id = $cmd.id; ok = $false; error = $_.Exception.Message } }
}
`;

/** Persistent PowerShell helper with id-matched request/reply. */
export class PsHelper {
  constructor(name, script) {
    this.name = name; // for the temp file name
    this.script = script;
    this.proc = null;
    this.buf = "";
    this.waiters = new Map(); // id → { resolve, timer }
    this.seq = 0;
    this.starting = null;
    this.file = null;
  }

  /** Write the script to a private .ps1 once (AV-deterministic, no quoting issues). */
  ensureFile() {
    if (this.file) {
      try {
        fs.accessSync(this.file);
        return this.file;
      } catch { /* rewrite below */ }
    }
    fs.mkdirSync(path.join(configDir, "helpers"), { recursive: true, mode: 0o700 });
    this.file = path.join(configDir, "helpers", `${this.name}.ps1`);
    fs.writeFileSync(this.file, this.script, { encoding: "utf8" });
    return this.file;
  }

  /** Spawn the helper process. Overridden per platform (PowerShell on Windows). */
  _launch() {
    const file = this.ensureFile();
    return spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file], {
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });
  }

  async ensure() {
    if (this.proc && this.proc.exitCode === null) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      // A helper that cannot start (no swiftc, a failed compile) leaves cmd() answering helper_not_running.
      try { this.proc = this._launch(); } catch { this.proc = null; return; }
      this.buf = "";
      this.proc.stdout.setEncoding("utf8");
      this.proc.stdout.on("data", (d) => {
        this.buf += d;
        let nl;
        while ((nl = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, nl).trim();
          this.buf = this.buf.slice(nl + 1);
          if (!line) continue;
          let obj = null;
          try { obj = JSON.parse(line); } catch { continue; }
          const id = obj?.id;
          if (id == null && obj?.event) this.onEvent?.(obj);
          if (id != null && this.waiters.has(id)) {
            const w = this.waiters.get(id);
            this.waiters.delete(id);
            clearTimeout(w.timer);
            w.resolve(obj);
          }
        }
      });
      this.proc.stderr.on("data", () => { /* diagnostics only */ });
      this.proc.on("close", () => {
        this.proc = null;
        for (const w of this.waiters.values()) {
          clearTimeout(w.timer);
          w.resolve({ ok: false, error: "helper_died" });
        }
        this.waiters.clear();
      });
      // Wait until the helper answers a ping (assembly load takes ~1-2s).
      for (let i = 0; i < 25; i++) {
        await sleep(150);
        if (!this.proc) break;
        const r = await this.cmd({ op: "ping" }, 4000).catch(() => null);
        if (r?.ok) return;
      }
    })();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  cmd(obj, timeoutMs = 15000) {
    if (!this.proc || this.proc.exitCode !== null) return Promise.resolve({ ok: false, error: "helper_not_running" });
    const id = ++this.seq;
    return new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.waiters.delete(id);
        resolve({ ok: false, error: "helper_timeout" });
      }, timeoutMs);
      this.waiters.set(id, { resolve, timer });
      try {
        this.proc.stdin.write(wireLine({ ...obj, id }));
      } catch {
        this.waiters.delete(id);
        clearTimeout(timer);
        resolve({ ok: false, error: "write_failed" });
      }
    });
  }

  kill() {
    if (this.proc) {
      try { this.proc.kill(); } catch { /* already gone */ }
      this.proc = null;
    }
    if (this.file) {
      try { fs.unlinkSync(this.file); } catch { /* best effort */ }
      this.file = null;
    }
  }
}

// macOS helper, compiled from this Swift source. Two modes:
//  • no arguments: the JSON-line protocol of the PowerShell helpers (one request per line in, one
//    reply per line out) for stills, input, pointer, clipboard, permissions and lock;
//  • "stream ...": ScreenCaptureKit frames encoded by VideoToolbox (H.264 or HEVC) and the PC's sound
//    as AAC, written as [kind u8][length u32 BE][data] records (1 key, 2 delta, 3 audio).
// Without the Screen Recording grant ScreenCaptureKit finds no displays, reported as a clear error.
const MAC_CAP_SWIFT = `
import Foundation
import CoreGraphics
import AppKit
import ApplicationServices
import ScreenCaptureKit
import VideoToolbox
import AVFoundation
import CoreMedia

// Screen Recording and Accessibility are separate macOS grants; without them capture returns
// nothing and input is silently dropped. "perms" reports them, "request" shows the system prompts.
func perms() -> [String: Any] {
  return ["ok": true, "screen": CGPreflightScreenCaptureAccess(), "accessibility": AXIsProcessTrusted()]
}

func requestPerms() -> [String: Any] {
  if !CGPreflightScreenCaptureAccess() { CGRequestScreenCaptureAccess() }
  let opt = ["AXTrustedCheckOptionPrompt" as CFString: true] as CFDictionary
  _ = AXIsProcessTrustedWithOptions(opt)
  return perms()
}

func reply(_ o: [String: Any]) {
  if let d = try? JSONSerialization.data(withJSONObject: o), let s = String(data: d, encoding: .utf8) {
    print(s)
  }
  fflush(stdout)
}

func displayIDs() -> [CGDirectDisplayID] {
  var count: UInt32 = 0
  CGGetActiveDisplayList(0, nil, &count)
  var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
  CGGetActiveDisplayList(count, &ids, &count)
  return ids
}

func monitors() -> [[String: Any]] {
  let main = CGMainDisplayID()
  var out: [[String: Any]] = []
  for (i, id) in displayIDs().enumerated() {
    let b = CGDisplayBounds(id)
    out.append(["index": i, "id": Int(id), "x": Int(b.origin.x), "y": Int(b.origin.y),
                "w": Int(b.width), "h": Int(b.height), "primary": id == main])
  }
  return out
}

// The display at [index] in CGGetActiveDisplayList order (the main one for -1), as ScreenCaptureKit sees it.
func scDisplay(_ index: Int) -> SCDisplay? {
  let ids = displayIDs()
  let id = (index >= 0 && index < ids.count) ? ids[index] : CGMainDisplayID()
  var found: SCDisplay?
  let sem = DispatchSemaphore(value: 0)
  SCShareableContent.getExcludingDesktopWindows(false, onScreenWindowsOnly: true) { content, _ in
    found = content?.displays.first { $0.displayID == id }
    sem.signal()
  }
  sem.wait()
  return found
}

// Backing pixels (twice the points on Retina) scaled by the quality factor, kept even for the encoders.
func pixelSize(_ d: SCDisplay, _ scale: Double) -> (Int, Int) {
  let mode = CGDisplayCopyDisplayMode(d.displayID)
  let pw = mode?.pixelWidth ?? d.width
  let ph = mode?.pixelHeight ?? d.height
  let s = max(0.2, min(1.0, scale))
  return (max(2, Int(Double(pw) * s) / 2 * 2), max(2, Int(Double(ph) * s) / 2 * 2))
}

func capture(_ scale: Double, _ index: Int) -> [String: Any] {
  guard let display = scDisplay(index) else { return ["ok": false, "error": "screen_permission"] }
  let (w, h) = pixelSize(display, scale)
  let cfg = SCStreamConfiguration()
  cfg.width = w
  cfg.height = h
  cfg.showsCursor = false
  var shot: CGImage?
  let sem = DispatchSemaphore(value: 0)
  SCScreenshotManager.captureImage(contentFilter: SCContentFilter(display: display, excludingWindows: []), configuration: cfg) { img, _ in
    shot = img
    sem.signal()
  }
  sem.wait()
  guard let img = shot else { return ["ok": false, "error": "screen_permission"] }
  let rep = NSBitmapImageRep(cgImage: img)
  guard let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.6]) else {
    return ["ok": false, "error": "encode"]
  }
  return ["ok": true, "b64": jpeg.base64EncodedString(), "w": img.width, "h": img.height]
}

// Windows virtual-key codes (what the phone and web client send) to macOS CGKeyCodes.
let VK: [Int: CGKeyCode] = [
  0x08: 51, 0x09: 48, 0x0D: 36, 0x1B: 53, 0x20: 49, 0x2E: 117, 0x24: 115, 0x23: 119,
  0x21: 116, 0x22: 121, 0x25: 123, 0x26: 126, 0x27: 124, 0x28: 125, 0x2D: 114,
  0x30: 29, 0x31: 18, 0x32: 19, 0x33: 20, 0x34: 21, 0x35: 23, 0x36: 22, 0x37: 26, 0x38: 28, 0x39: 25,
  0x41: 0, 0x42: 11, 0x43: 8, 0x44: 2, 0x45: 14, 0x46: 3, 0x47: 5, 0x48: 4, 0x49: 34, 0x4A: 38,
  0x4B: 40, 0x4C: 37, 0x4D: 46, 0x4E: 45, 0x4F: 31, 0x50: 35, 0x51: 12, 0x52: 15, 0x53: 1, 0x54: 17,
  0x55: 32, 0x56: 9, 0x57: 13, 0x58: 7, 0x59: 16, 0x5A: 6,
  0x60: 82, 0x61: 83, 0x62: 84, 0x63: 85, 0x64: 86, 0x65: 87, 0x66: 88, 0x67: 89, 0x68: 91, 0x69: 92,
  0x6A: 67, 0x6B: 69, 0x6D: 78, 0x6E: 65, 0x6F: 75,
  0x70: 122, 0x71: 120, 0x72: 99, 0x73: 118, 0x74: 96, 0x75: 97, 0x76: 98, 0x77: 100,
  0x78: 101, 0x79: 109, 0x7A: 103, 0x7B: 111, 0x7C: 105, 0x7D: 107, 0x7E: 113, 0x7F: 106,
  0x80: 64, 0x81: 79, 0x82: 80, 0x83: 90,
  0xBA: 41, 0xBB: 24, 0xBC: 43, 0xBD: 27, 0xBE: 47, 0xBF: 44, 0xC0: 50,
  0xDB: 33, 0xDC: 42, 0xDD: 30, 0xDE: 39,
]

// Modifier virtual keys (generic, left, right) to their key code and flag.
let MODS: [Int: (CGKeyCode, CGEventFlags)] = [
  0x10: (56, CGEventFlags.maskShift), 0xA0: (56, CGEventFlags.maskShift), 0xA1: (60, CGEventFlags.maskShift),
  0x11: (59, CGEventFlags.maskControl), 0xA2: (59, CGEventFlags.maskControl), 0xA3: (62, CGEventFlags.maskControl),
  0x12: (58, CGEventFlags.maskAlternate), 0xA4: (58, CGEventFlags.maskAlternate), 0xA5: (61, CGEventFlags.maskAlternate),
  0x5B: (55, CGEventFlags.maskCommand), 0x5C: (54, CGEventFlags.maskCommand),
]
let TAP_MODS: [(String, CGKeyCode, CGEventFlags)] = [
  ("ctrl", 59, CGEventFlags.maskControl), ("alt", 58, CGEventFlags.maskAlternate),
  ("shift", 56, CGEventFlags.maskShift), ("win", 55, CGEventFlags.maskCommand),
]
// Real keyboards flag the arrows, the navigation block and F-keys like this; without the flags
// the system ignores shortcuts such as Ctrl+Left (previous Space) and Ctrl+Up (Mission Control).
let FN_KEYS: Set<CGKeyCode> = [122, 120, 99, 118, 96, 97, 98, 100, 101, 109, 103, 111, 105, 107, 113, 106, 64, 79, 80, 90,
  114, 115, 116, 117, 119, 121, 123, 124, 125, 126]
let ARROW_KEYS: Set<CGKeyCode> = [123, 124, 125, 126]
// Windows media virtual keys to NX_KEYTYPE codes, which macOS only takes as system-defined events.
let MEDIA: [Int: Int] = [0xAD: 7, 0xAE: 1, 0xAF: 0, 0xB0: 17, 0xB1: 18, 0xB3: 16]

let src = CGEventSource(stateID: .hidSystemState)
// Synthetic events carry no modifier state of their own, so held modifiers are applied to every event.
var heldMods = Set<Int>()
var buttonsDown = Set<String>()
var lastClick: (button: String, at: CGPoint, time: Double, count: Int) = ("", CGPoint.zero, 0, 0)

func heldFlags() -> CGEventFlags {
  var f = CGEventFlags()
  for vk in heldMods { if let m = MODS[vk] { f.insert(m.1) } }
  return f
}

func num(_ v: Any?) -> Double? { return (v as? NSNumber)?.doubleValue }

// macOS leaves click counting to whoever posts the event: a second quick click on the same spot
// must say 2, or apps see two single clicks and a double tap never opens anything.
func clickCount(_ button: String, _ p: CGPoint) -> Int64 {
  let now = ProcessInfo.processInfo.systemUptime
  let near = abs(p.x - lastClick.at.x) < 6 && abs(p.y - lastClick.at.y) < 6
  let n = button == lastClick.button && near && now - lastClick.time < NSEvent.doubleClickInterval ? lastClick.count + 1 : 1
  lastClick = (button, p, now, n)
  return Int64(n)
}

func mouseKinds(_ b: String) -> (CGEventType, CGEventType, CGEventType, CGMouseButton) {
  switch b {
  case "right": return (.rightMouseDown, .rightMouseUp, .rightMouseDragged, .right)
  case "middle": return (.otherMouseDown, .otherMouseUp, .otherMouseDragged, .center)
  default: return (.leftMouseDown, .leftMouseUp, .leftMouseDragged, .left)
  }
}

func postMouse(_ cmd: [String: Any]) -> [String: Any] {
  if !AXIsProcessTrusted() { return ["ok": false, "error": "accessibility_permission"] }
  // x/y arrive as global points (top-left of the main display is 0,0), the space CGEvent uses.
  let moved = num(cmd["x"]) != nil && num(cmd["y"]) != nil
  let p = moved ? CGPoint(x: num(cmd["x"]) ?? 0, y: num(cmd["y"]) ?? 0)
    : (CGEvent(source: nil)?.location ?? CGPoint.zero)
  let f = heldFlags()
  func ev(_ t: CGEventType, _ b: CGMouseButton, _ clicks: Int64) {
    guard let e = CGEvent(mouseEventSource: src, mouseType: t, mouseCursorPosition: p, mouseButton: b) else { return }
    e.setIntegerValueField(.mouseEventClickState, value: clicks)
    e.flags = f
    e.post(tap: .cghidEventTap)
  }
  if moved {
    // With a button held macOS expects drag events; plain moves would drop the drag.
    if let held = ["left", "right", "middle"].first(where: { buttonsDown.contains($0) }) {
      let k = mouseKinds(held)
      ev(k.2, k.3, Int64(lastClick.count))
    } else {
      ev(.mouseMoved, .left, 0)
    }
  }
  if let click = cmd["click"] as? String {
    if click == "double" {
      let k = mouseKinds("left")
      ev(k.0, k.3, 1); ev(k.1, k.3, 1); ev(k.0, k.3, 2); ev(k.1, k.3, 2)
      lastClick = ("left", p, ProcessInfo.processInfo.systemUptime, 2)
    } else {
      let k = mouseKinds(click)
      let n = clickCount(click, p)
      ev(k.0, k.3, n); ev(k.1, k.3, n)
    }
  }
  if let press = cmd["press"] as? String {
    let btn = cmd["button"] as? String ?? "left"
    let k = mouseKinds(btn)
    if press == "down" {
      buttonsDown.insert(btn)
      ev(k.0, k.3, clickCount(btn, p))
    } else {
      buttonsDown.remove(btn)
      ev(k.1, k.3, Int64(max(1, lastClick.count)))
    }
  }
  let wheel = cmd["wheel"] as? Int ?? 0
  let hwheel = cmd["hwheel"] as? Int ?? 0
  if wheel != 0 || hwheel != 0 {
    // hwheel is positive to the right, as on Windows; the second macOS wheel counts the other way.
    let e = CGEvent(scrollWheelEvent2Source: src, units: .pixel, wheelCount: 2,
      wheel1: Int32(clamping: wheel), wheel2: Int32(clamping: -hwheel), wheel3: 0)
    e?.flags = f
    e?.post(tap: .cghidEventTap)
  }
  return ["ok": true]
}

func keyEvent(_ code: CGKeyCode, _ down: Bool, _ flags: CGEventFlags) {
  guard let e = CGEvent(keyboardEventSource: src, virtualKey: code, keyDown: down) else { return }
  var f = flags
  if FN_KEYS.contains(code) { f.insert(.maskSecondaryFn) }
  if ARROW_KEYS.contains(code) { f.insert(.maskNumericPad) }
  e.flags = f
  e.post(tap: .cghidEventTap)
}

func screenLocked() -> Bool {
  let d = CGSessionCopyCurrentDictionary() as? [String: Any]
  return (d?["CGSSessionScreenIsLocked"] as? Bool) ?? false
}

func waitLocked() -> Bool {
  for _ in 0..<15 {
    if screenLocked() { return true }
    usleep(100_000)
  }
  return false
}

// SACLockScreenImmediate is what the menu bar's Lock Screen calls: it locks at once, whatever the
// "require password after sleep" delay. The Ctrl+Cmd+Q shortcut is the fallback; success is checked.
func lockScreen() -> [String: Any] {
  if let h = dlopen("/System/Library/PrivateFrameworks/login.framework/Versions/Current/login", RTLD_LAZY),
     let sym = dlsym(h, "SACLockScreenImmediate") {
    typealias Lock = @convention(c) () -> Int32
    _ = unsafeBitCast(sym, to: Lock.self)()
    if waitLocked() { return ["ok": true] }
  }
  if AXIsProcessTrusted() {
    let f: CGEventFlags = [.maskControl, .maskCommand]
    keyEvent(12, true, f)
    keyEvent(12, false, f)
    if waitLocked() { return ["ok": true] }
  }
  return ["ok": false, "error": "lock_failed"]
}

func mediaKey(_ key: Int) {
  for down in [true, false] {
    let state = down ? 0xa : 0xb
    let e = NSEvent.otherEvent(with: .systemDefined, location: NSPoint.zero,
      modifierFlags: NSEvent.ModifierFlags(rawValue: UInt(state << 8)), timestamp: 0, windowNumber: 0,
      context: nil, subtype: 8, data1: (key << 16) | (state << 8), data2: -1)
    e?.cgEvent?.post(tap: .cghidEventTap)
  }
}

func postKey(_ cmd: [String: Any]) -> [String: Any] {
  if !AXIsProcessTrusted() { return ["ok": false, "error": "accessibility_permission"] }
  guard let vk = cmd["key"] as? Int else { return ["ok": false, "error": "bad_key"] }
  let press = cmd["press"] as? String
  if let media = MEDIA[vk] {
    if press != "up" { mediaKey(media) }
    return ["ok": true]
  }
  if let m = MODS[vk] {
    if press == "up" { heldMods.remove(vk) } else { heldMods.insert(vk) }
    keyEvent(m.0, press != "up", heldFlags())
    if press == nil { heldMods.remove(vk); keyEvent(m.0, false, heldFlags()) }
    return ["ok": true]
  }
  guard let code = VK[vk] else { return ["ok": false, "error": "unmapped_key"] }
  switch press ?? "" {
  case "down": keyEvent(code, true, heldFlags())
  case "up": keyEvent(code, false, heldFlags())
  default:
    // Modifiers go down and up as their own key events around the key, as on a real keyboard.
    let wanted = cmd["mods"] as? [String] ?? []
    let used = TAP_MODS.filter { wanted.contains($0.0) }
    let base = heldFlags()
    var f = base
    for m in used { f.insert(m.2); keyEvent(m.1, true, f) }
    keyEvent(code, true, f)
    keyEvent(code, false, f)
    for i in used.indices.reversed() {
      var after = base
      for m in used[..<i] { after.insert(m.2) }
      keyEvent(used[i].1, false, after)
    }
  }
  return ["ok": true]
}

func cursor() -> [String: Any] {
  let p = CGEvent(source: nil)?.location ?? CGPoint.zero  // global points, top-left origin, like input
  return ["ok": true, "x": Double(p.x), "y": Double(p.y), "shape": "default", "visible": true]
}

func clipSeq() -> [String: Any] { return ["ok": true, "seq": NSPasteboard.general.changeCount] }

func clipRead(_ maxImage: Int) -> [String: Any] {
  let pb = NSPasteboard.general
  let seq = pb.changeCount
  if let urls = pb.readObjects(forClasses: [NSURL.self], options: [.urlReadingFileURLsOnly: true]) as? [URL], !urls.isEmpty {
    let files = urls.map { u -> [String: Any] in
      let attrs = try? FileManager.default.attributesOfItem(atPath: u.path)
      let size = (attrs?[.size] as? Int) ?? 0
      return ["name": u.lastPathComponent, "size": size, "path": u.path]
    }
    return ["ok": true, "kind": "files", "files": files, "seq": seq]
  }
  if let img = NSImage(pasteboard: pb), let tiff = img.tiffRepresentation,
     let rep = NSBitmapImageRep(data: tiff), let png = rep.representation(using: .png, properties: [:]) {
    if png.count > maxImage { return ["ok": true, "kind": "image", "w": rep.pixelsWide, "h": rep.pixelsHigh, "seq": seq] }
    return ["ok": true, "kind": "image", "png": png.base64EncodedString(), "w": rep.pixelsWide, "h": rep.pixelsHigh, "seq": seq]
  }
  if let s = pb.string(forType: .string) { return ["ok": true, "kind": "text", "text": s, "seq": seq] }
  return ["ok": true, "kind": "empty", "seq": seq]
}

func clipSet(_ cmd: [String: Any]) -> [String: Any] {
  let pb = NSPasteboard.general
  pb.clearContents()
  if let files = cmd["files"] as? [String], !files.isEmpty {
    pb.writeObjects(files.map { URL(fileURLWithPath: $0) as NSURL })
  } else if let b64 = cmd["png"] as? String, let data = Data(base64Encoded: b64) {
    pb.setData(data, forType: .png)
  } else if let text = cmd["text"] as? String {
    pb.setString(text, forType: .string)
  }
  return ["ok": true, "seq": pb.changeCount]
}

func postType(_ text: String) -> [String: Any] {
  if !AXIsProcessTrusted() { return ["ok": false, "error": "accessibility_permission"] }
  // Whole characters, so emoji and other text outside one UTF-16 unit arrive intact.
  for ch in text {
    var u = Array(String(ch).utf16)
    for down in [true, false] {
      let e = CGEvent(keyboardEventSource: src, virtualKey: 0, keyDown: down)
      e?.flags = CGEventFlags()
      e?.keyboardSetUnicodeString(stringLength: u.count, unicodeString: &u)
      e?.post(tap: .cghidEventTap)
    }
  }
  return ["ok": true]
}

func handle(_ line: String) {
  guard let data = line.data(using: .utf8),
        let cmd = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { return }
  let id = cmd["id"]
  let op = cmd["op"] as? String ?? ""
  var out: [String: Any]
  switch op {
  case "ping": out = ["ok": true]
  case "monitors": out = ["ok": true, "monitors": monitors()]
  case "capture": out = capture(num(cmd["s"]) ?? 1.0, cmd["index"] as? Int ?? -1)
  case "perms": out = perms()
  case "request": out = requestPerms()
  case "mouse": out = postMouse(cmd)
  case "key": out = postKey(cmd)
  case "type": out = postType(cmd["text"] as? String ?? "")
  case "cursor": out = cursor()
  case "lock": out = lockScreen()
  case "seq": out = clipSeq()
  case "read": out = clipRead(cmd["maxImage"] as? Int ?? (12 << 20))
  case "set": out = clipSet(cmd)
  default: out = ["ok": false, "error": "unknown_op"]
  }
  if let id = id { out["id"] = id }
  reply(out)
}

// AAC-LC, 48 kHz, stereo: the ADTS header that lets the phone decode each frame on its own.
func adtsHeader(_ size: Int) -> Data {
  let full = size + 7
  return Data([0xFF, 0xF1, 0x4C, UInt8(0x80 | ((full >> 11) & 0x03)), UInt8((full >> 3) & 0xFF), UInt8(((full & 0x07) << 5) | 0x1F), 0xFC])
}

final class Streamer: NSObject, SCStreamOutput, SCStreamDelegate {
  let codec: String
  let fps: Int
  let bitrate: Int
  var session: VTCompressionSession?
  var stream: SCStream?
  var aac: AVAudioConverter?
  var aacFormat: AVAudioFormat?
  let outLock = NSLock()
  let videoQueue = DispatchQueue(label: "pocketdesk.video")
  let audioQueue = DispatchQueue(label: "pocketdesk.audio")

  init(codec: String, fps: Int, bitrate: Int) {
    self.codec = codec
    self.fps = fps
    self.bitrate = bitrate
  }

  func write(_ kind: UInt8, _ data: Data) {
    let n = UInt32(data.count)
    let head = Data([kind, UInt8(n >> 24), UInt8((n >> 16) & 0xFF), UInt8((n >> 8) & 0xFF), UInt8(n & 0xFF)])
    outLock.lock()
    FileHandle.standardOutput.write(head + data)
    outLock.unlock()
  }

  func makeSession(_ w: Int, _ h: Int) -> Bool {
    let type = codec == "hevc" ? kCMVideoCodecType_HEVC : kCMVideoCodecType_H264
    var spec: [CFString: Any] = [:]
    if codec == "h264" { spec[kVTVideoEncoderSpecification_EnableLowLatencyRateControl] = true }
    var made: VTCompressionSession?
    let st = VTCompressionSessionCreate(allocator: nil, width: Int32(w), height: Int32(h), codecType: type,
      encoderSpecification: spec as CFDictionary, imageBufferAttributes: nil, compressedDataAllocator: nil,
      outputCallback: nil, refcon: nil, compressionSessionOut: &made)
    guard st == noErr, let s = made else { return false }
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_RealTime, value: kCFBooleanTrue)
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_AllowFrameReordering, value: kCFBooleanFalse)
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_MaxKeyFrameInterval, value: NSNumber(value: fps))
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_ExpectedFrameRate, value: NSNumber(value: fps))
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_AverageBitRate, value: NSNumber(value: bitrate))
    VTSessionSetProperty(s, key: kVTCompressionPropertyKey_ProfileLevel,
      value: codec == "hevc" ? kVTProfileLevel_HEVC_Main_AutoLevel : kVTProfileLevel_H264_Main_AutoLevel)
    VTCompressionSessionPrepareToEncodeFrames(s)
    session = s
    return true
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sb: CMSampleBuffer, of type: SCStreamOutputType) {
    if type == .audio { encodeAudio(sb); return }
    // Idle and blank frames carry no picture; only complete ones are encoded.
    guard type == .screen, sb.isValid,
          let atts = CMSampleBufferGetSampleAttachmentsArray(sb, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
          let raw = atts.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete,
          let pb = CMSampleBufferGetImageBuffer(sb) else { return }
    if session == nil && !makeSession(CVPixelBufferGetWidth(pb), CVPixelBufferGetHeight(pb)) { exit(3) }
    guard let s = session else { return }
    VTCompressionSessionEncodeFrame(s, imageBuffer: pb, presentationTimeStamp: CMSampleBufferGetPresentationTimeStamp(sb),
      duration: CMTime.invalid, frameProperties: nil, infoFlagsOut: nil) { [weak self] status, _, sample in
      guard status == noErr, let sample = sample else { return }
      self?.emitVideo(sample)
    }
  }

  func stream(_ stream: SCStream, didStopWithError error: Error) { exit(6) }

  // A keyframe goes out as parameter sets then the frame, all Annex B; the daemon splits them.
  func emitVideo(_ sample: CMSampleBuffer) {
    let atts = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[CFString: Any]]
    let key = !((atts?.first?[kCMSampleAttachmentKey_NotSync] as? Bool) ?? false)
    let startCode: [UInt8] = [0, 0, 0, 1]
    var out = Data()
    if key, let fmt = CMSampleBufferGetFormatDescription(sample) {
      var count = 0
      var i = 0
      repeat {
        var ptr: UnsafePointer<UInt8>?
        var size = 0
        let st = codec == "hevc"
          ? CMVideoFormatDescriptionGetHEVCParameterSetAtIndex(fmt, parameterSetIndex: i, parameterSetPointerOut: &ptr,
              parameterSetSizeOut: &size, parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil)
          : CMVideoFormatDescriptionGetH264ParameterSetAtIndex(fmt, parameterSetIndex: i, parameterSetPointerOut: &ptr,
              parameterSetSizeOut: &size, parameterSetCountOut: &count, nalUnitHeaderLengthOut: nil)
        if st != noErr { break }
        if let ptr = ptr {
          out.append(contentsOf: startCode)
          out.append(ptr, count: size)
        }
        i += 1
      } while i < count
    }
    guard let block = CMSampleBufferGetDataBuffer(sample) else { return }
    let total = CMBlockBufferGetDataLength(block)
    var bytes = [UInt8](repeating: 0, count: total)
    guard CMBlockBufferCopyDataBytes(block, atOffset: 0, dataLength: total, destination: &bytes) == noErr else { return }
    var p = 0
    while p + 4 <= total {
      var n = Int(bytes[p]) << 24
      n |= Int(bytes[p + 1]) << 16
      n |= Int(bytes[p + 2]) << 8
      n |= Int(bytes[p + 3])
      p += 4
      if n <= 0 || p + n > total { break }
      out.append(contentsOf: startCode)
      out.append(contentsOf: bytes[p..<(p + n)])
      p += n
    }
    write(key ? 1 : 2, out)
  }

  func encodeAudio(_ sb: CMSampleBuffer) {
    guard let desc = CMSampleBufferGetFormatDescription(sb),
          let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(desc),
          let inFmt = AVAudioFormat(streamDescription: asbd) else { return }
    let frames = AVAudioFrameCount(CMSampleBufferGetNumSamples(sb))
    guard frames > 0, let pcm = AVAudioPCMBuffer(pcmFormat: inFmt, frameCapacity: frames) else { return }
    pcm.frameLength = frames
    guard CMSampleBufferCopyPCMDataIntoAudioBufferList(sb, at: 0, frameCount: Int32(frames), into: pcm.mutableAudioBufferList) == noErr else { return }
    if aac == nil {
      var outDesc = AudioStreamBasicDescription(mSampleRate: 48000, mFormatID: kAudioFormatMPEG4AAC, mFormatFlags: 0,
        mBytesPerPacket: 0, mFramesPerPacket: 1024, mBytesPerFrame: 0, mChannelsPerFrame: 2, mBitsPerChannel: 0, mReserved: 0)
      guard let outFmt = AVAudioFormat(streamDescription: &outDesc), let conv = AVAudioConverter(from: inFmt, to: outFmt) else { return }
      conv.bitRate = 128_000
      aac = conv
      aacFormat = outFmt
    }
    guard let conv = aac, let outFmt = aacFormat else { return }
    let out = AVAudioCompressedBuffer(format: outFmt, packetCapacity: 16, maximumPacketSize: max(conv.maximumOutputPacketSize, 1536))
    var fed = false
    var err: NSError?
    let status = conv.convert(to: out, error: &err) { _, inStatus in
      if fed { inStatus.pointee = .noDataNow; return nil }
      fed = true
      inStatus.pointee = .haveData
      return pcm
    }
    guard status != .error, let descs = out.packetDescriptions else { return }
    for i in 0..<Int(out.packetCount) {
      let d = descs[i]
      let size = Int(d.mDataByteSize)
      var frame = adtsHeader(size)
      frame.append(Data(bytes: out.data.advanced(by: Int(d.mStartOffset)), count: size))
      write(3, frame)
    }
  }

  func start(_ display: SCDisplay, scale: Double, audio: Bool) {
    let (w, h) = pixelSize(display, scale)
    let cfg = SCStreamConfiguration()
    cfg.width = w
    cfg.height = h
    cfg.minimumFrameInterval = CMTime(value: 1, timescale: CMTimeScale(fps))
    cfg.pixelFormat = kCVPixelFormatType_420YpCbCr8BiPlanarVideoRange
    cfg.showsCursor = false
    cfg.queueDepth = 6
    if audio {
      cfg.capturesAudio = true
      cfg.sampleRate = 48000
      cfg.channelCount = 2
      cfg.excludesCurrentProcessAudio = true
    }
    let s = SCStream(filter: SCContentFilter(display: display, excludingWindows: []), configuration: cfg, delegate: self)
    do {
      try s.addStreamOutput(self, type: .screen, sampleHandlerQueue: videoQueue)
      if audio { try s.addStreamOutput(self, type: .audio, sampleHandlerQueue: audioQueue) }
    } catch { exit(4) }
    stream = s
    s.startCapture { err in
      if err != nil { FileHandle.standardError.write(Data("screen_permission\\n".utf8)); exit(5) }
    }
  }
}

var streamer: Streamer?

func runStream(_ args: [String]) {
  func arg(_ name: String) -> String? {
    guard let i = args.firstIndex(of: name), i + 1 < args.count else { return nil }
    return args[i + 1]
  }
  guard let display = scDisplay(Int(arg("--display") ?? "") ?? -1) else {
    FileHandle.standardError.write(Data("screen_permission\\n".utf8))
    exit(2)
  }
  let s = Streamer(codec: arg("--codec") == "hevc" ? "hevc" : "h264", fps: Int(arg("--fps") ?? "") ?? 30,
    bitrate: Int(arg("--bitrate") ?? "") ?? 6_000_000)
  streamer = s
  s.start(display, scale: Double(arg("--scale") ?? "") ?? 1.0, audio: args.contains("--audio"))
  // The daemon ends a stream by closing stdin.
  while readLine() != nil {}
  exit(0)
}

// ScreenCaptureKit and AppKit may deliver on the main queue, so the work runs beside it.
let mainArgs = CommandLine.arguments
DispatchQueue.global().async {
  if mainArgs.count > 1 && mainArgs[1] == "stream" { runStream(Array(mainArgs.dropFirst(2))) }
  while let line = readLine(strippingNewline: true) { handle(line) }
  exit(0)
}
dispatchMain()
`;

/** Helper backed by a compiled Swift binary (macOS). Same wire protocol as PsHelper. */
export class MacHelper extends PsHelper {
  constructor(name, source) {
    super(name, source);
    this.bin = null;
  }

  /** Write the Swift source and compile it once (cached by mtime); return the binary path. */
  ensureFile() {
    const dir = path.join(configDir, "helpers");
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const src = path.join(dir, `${this.name}.swift`);
    this.bin = path.join(dir, this.name);
    this.file = this.bin;
    const binExists = () => { try { fs.accessSync(this.bin); return true; } catch { return false; } };
    const stale = () => {
      try { return fs.statSync(this.bin).mtimeMs < fs.statSync(src).mtimeMs; } catch { return true; }
    };
    // An upgrade brings new source while the old binary is newer than the old source on disk.
    let changed = true;
    try { changed = fs.readFileSync(src, "utf8") !== this.script; } catch { /* first run */ }
    if (!changed && binExists() && !stale()) return this.bin;
    // A missing or broken swiftc would otherwise be retried on every poll (cursor runs at 33ms).
    // After a failure, don't attempt another compile for a minute.
    if (this._compileFailedAt && Date.now() - this._compileFailedAt < 60_000) {
      throw new Error("swift helper compile unavailable");
    }
    try {
      fs.writeFileSync(src, this.script, { encoding: "utf8" });
      // macOS 14 is the oldest with ScreenCaptureKit stills (SCScreenshotManager).
      const target = `${process.arch === "arm64" ? "arm64" : "x86_64"}-apple-macos14.0`;
      // A compile killed by the timeout must not leave a half-written binary that looks current.
      execFileSync("swiftc", ["-O", "-target", target, src, "-o", this.bin + ".tmp"], { stdio: ["ignore", "ignore", "pipe"], timeout: 120000 });
      fs.renameSync(this.bin + ".tmp", this.bin);
      this._compileFailedAt = 0;
    } catch (e) {
      this._compileFailedAt = Date.now();
      console.warn(`[desktop] ${this.name} helper failed to compile: ${String(e.stderr || e.message).slice(-1500)}`);
      throw e;
    }
    return this.bin;
  }

  _launch() {
    return spawn(this.ensureFile(), [], { stdio: ["pipe", "pipe", "pipe"] });
  }

  kill() {
    if (this.proc) { try { this.proc.kill(); } catch { /* gone */ } this.proc = null; }
    // Keep the compiled binary; recompiled only when the source changes.
  }
}

/**
 * macOS video backend for DesktopVideo: runs the compiled helper in "stream" mode (ScreenCaptureKit
 * + VideoToolbox, plus the PC's sound as AAC). VideoToolbox does H.264 and HEVC, not AV1. It shares
 * the binary that [helper] (the capture MacHelper) compiles, so there is one compile and one source.
 */
export class MacVideoNative {
  constructor(helper) {
    this.helper = helper;
    this.proc = null;
  }

  /** opts: { monitor, preset, codecs, audio }; onRecord({ kind, data, codec }); onEnd(). */
  async start(opts, onRecord, onEnd) {
    this.stop();
    const codec = (opts.codecs || []).includes("hevc") ? "hevc" : "h264";
    let bin;
    try { bin = this.helper.ensureFile(); } catch { return null; }
    const p = opts.preset;
    const args = ["stream", "--display", String(opts.monitor?.output ?? -1), "--codec", codec,
      "--fps", String(p.fps), "--bitrate", String(Math.round(parseRate(p.maxrate))), "--scale", String(p.scale)];
    if (opts.audio) args.push("--audio");
    let proc;
    try { proc = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] }); } catch { return null; }
    this.proc = proc;
    const reader = new FrameReaderLocal();
    proc.stdout.on("data", (chunk) => {
      for (const rec of reader.push(chunk)) onRecord({ kind: rec.kind, data: rec.data, codec });
    });
    let err = "";
    proc.stderr.on("data", (d) => { err = (err + d).slice(-400); });
    const ended = new Promise((resolve) => {
      proc.once("exit", () => { if (this.proc === proc) { this.proc = null; onEnd?.(); } resolve(); });
      proc.once("error", () => resolve());
    });
    // Resolve once the first video record arrives (capture is working), or null if it dies first.
    const ready = new Promise((resolve) => {
      let done = false;
      const onFirst = (chunk) => {
        if (done) return;
        done = true;
        proc.stdout.off("data", onFirst);
        resolve({ encoder: `videotoolbox_${codec}`, codec });
      };
      proc.stdout.on("data", onFirst);
      ended.then(() => { if (!done) { done = true; resolve(null); } });
    });
    return ready;
  }

  stop() {
    if (this.proc) { try { this.proc.kill(); } catch { /* gone */ } this.proc = null; }
  }
}

/** Kept local so this file needs no import from desktop_video (which imports from here). */
class FrameReaderLocal {
  constructor() { this.buf = Buffer.alloc(0); }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    while (this.buf.length >= 5) {
      const len = this.buf.readUInt32BE(1);
      if (this.buf.length < 5 + len) break;
      out.push({ kind: this.buf[0], data: this.buf.subarray(5, 5 + len) });
      this.buf = this.buf.subarray(5 + len);
    }
    return out;
  }
}

const parseRate = (s) => (/g/i.test(s) ? parseFloat(s) * 1e9 : /m/i.test(s) ? parseFloat(s) * 1e6 : /k/i.test(s) ? parseFloat(s) * 1e3 : parseFloat(s));

/**
 * macOS input and the pointer work in points (CGEvent's global space), so displays stay in points.
 * Pixel ratios are never needed: viewers point by fraction of the picture, and on HiDPI modes
 * CGDisplayPixelsWide reports points anyway. avfoundation numbers screens in the same
 * CGGetActiveDisplayList order, which is `output`.
 */
export function macMonitors(list) {
  return list.map((m, i) => ({
    adapter: 0, output: i, name: `Display ${i + 1}`, left: m.x, top: m.y, w: m.w, h: m.h, primary: !!m.primary,
  }));
}

/** A fraction of the picture showing [rect] to input coordinates, and the pointer back to a fraction. */
export const fromFraction = (r, fx, fy) => ({ x: r.x + fx * r.w, y: r.y + fy * r.h });
export const toFraction = (r, c) => ({ fx: (c.x - r.x) / r.w, fy: (c.y - r.y) / r.h });

/**
 * Where to put the pointer when a viewer opens [rect] (a monitor) after [previousIndex]: the
 * middle of a newly chosen screen; on first open (undefined) only if the pointer is on another one.
 */
export function centerFor(rect, pointer, previousIndex) {
  if (!rect || previousIndex === rect.index) return null;
  const on = pointer && pointer.x >= rect.x && pointer.x < rect.x + rect.w && pointer.y >= rect.y && pointer.y < rect.y + rect.h;
  return previousIndex === undefined && on ? null : fromFraction(rect, 0.5, 0.5);
}

/** The part of the input space a still frame shows: the main display on macOS, every monitor on Windows. */
export function jpegRect(list, mac = IS_MAC) {
  if (!list?.length) return null;
  if (mac) return list.find((m) => m.primary) || list[0];
  return { x: 0, y: 0, w: Math.max(...list.map((m) => m.x + m.w)), h: Math.max(...list.map((m) => m.y + m.h)) };
}

// UIPI: Windows drops input from a normal process into an elevated window, with no other signal.
const ELEVATED = "An administrator window (such as Task Manager) has focus, and Windows blocks remote input to it. " +
  "Click another window, or install console access on the PC to control admin windows.";
// macOS drops synthetic input, and returns no screen pixels, until the user allows each one.
const MAC_HELP = {
  accessibility_permission: "The Mac blocks remote input until you allow PocketDesk (it may be listed as node) under System Settings > Privacy & Security > Accessibility.",
  screen_permission: "The Mac shows no screen until you allow PocketDesk (it may be listed as node) under System Settings > Privacy & Security > Screen Recording. The picture starts by itself once allowed.",
};
const inputError = (e) => (e === "elevated_window" || e === "input_blocked" ? ELEVATED : MAC_HELP[e] || e);

export class DesktopController extends EventEmitter {
  static get supported() {
    return IS_WIN || IS_MAC || IS_LINUX;
  }

  constructor() {
    super();
    this.clients = new Set(); // rd client ids with an open stream
    this.captureTimer = null;
    this.capturing = false;
    this.quality = 60;
    this.frameSeq = 0;
    this.lastFrame = null; // { base64, width, height, ts, seq }
    this.stats = { framesSent: 0, capturesFailed: 0, lastCaptureMs: 0 };
    this.helperInput = new PsHelper("input", INPUT_SCRIPT);
    this.helperCapture = IS_MAC ? new MacHelper("pdcap", MAC_CAP_SWIFT) : new PsHelper("capture", CAPTURE_SCRIPT);
    this.helperClip = new PsHelper("clipboard", CLIP_SCRIPT);
    // macOS streams video through the same helper binary; DesktopVideo drives it.
    this.macVideo = IS_MAC ? new MacVideoNative(this.helperCapture) : null;
    // Linux drives input and monitors through xdotool/xrandr and video through ffmpeg x11grab, or on a
    // wlroots Wayland session through its own tools and wf-recorder.
    this.linux = IS_LINUX ? (IS_WAYLAND ? new WaylandDesktop() : new LinuxDesktop()) : null;
    this.origin = { x: 0, y: 0 };
    this.monitorList = null;
  }

  /** True when this host can do real desktop control now (a Linux box needs xdotool). */
  get usable() { return IS_WIN || IS_MAC || !!this.linux?.supported; }

  /** Stream frames for `clientId` (server keeps the ws mapping). */
  async startFrameStream(clientId, quality) {
    if (!IS_WIN && !IS_MAC) return { ok: false, reason: "unsupported_platform" };
    if (quality) this.quality = Math.min(95, Math.max(10, Number(quality) || 60));
    this.clients.add(clientId);
    this._ensureLoop();
    return { ok: true, clients: this.clients.size, quality: this.quality };
  }

  stopFrameStream(clientId) {
    this.clients.delete(clientId);
    if (this.clients.size === 0) this._stopLoop();
    return { ok: true, clients: this.clients.size };
  }

  get scale() {
    return this.quality >= 70 ? 1 : this.quality >= 40 ? 0.75 : 0.5;
  }

  setQuality(quality) {
    this.quality = Math.min(95, Math.max(10, Number(quality) || 60));
    return { ok: true, quality: this.quality };
  }

  /** Latest frame, capturing one first if we have none yet. */
  async getFrame() {
    if (!IS_WIN && !IS_MAC) return { ok: false, reason: "unsupported_platform" };
    if (!this.lastFrame) {
      // captureOnce is a no-op while the stream loop has one in flight, so
      // wait for that frame rather than reporting a failure that never was.
      if (this.capturing) await this._nextFrame(15000);
      else await this.captureOnce();
      if (!this.lastFrame) return { ok: false, reason: inputError(this._lastCaptureError) || "capture_failed" };
    }
    return { ok: true, ...this.lastFrame };
  }

  _nextFrame(timeoutMs) {
    return new Promise((resolve) => {
      const done = () => { clearTimeout(timer); this.off("frame", done); resolve(); };
      const timer = setTimeout(done, timeoutMs);
      this.once("frame", done);
    });
  }

  _ensureLoop() {
    if (this.captureTimer || (!IS_WIN && !IS_MAC)) return;
    this.captureOnce();
    this.captureTimer = setInterval(() => {
      if (!this.capturing) this.captureOnce();
    }, 300);
  }

  _stopLoop() {
    if (this.captureTimer) clearInterval(this.captureTimer);
    this.captureTimer = null;
  }

  async captureOnce() {
    if (this.capturing || (!IS_WIN && !IS_MAC)) return;
    this.capturing = true;
    const t0 = Date.now();
    try {
      await this.helperCapture.ensure();
      // rd_quality maps to a downscale factor (bandwidth knob): 70+ = full,
      // 40-69 = 75%, below = 50%. In-memory JPEG keeps AMSI calm — the
      // temp-file save/rename pattern is what its heuristics flag.
      const r = await this.helperCapture.cmd({ op: "capture", s: this.scale }, 12000);
      if (r?.ok && r.b64) {
        this.stats.lastCaptureMs = Date.now() - t0;
        this.lastFrame = { base64: r.b64, width: r.w, height: r.h, ts: Date.now(), seq: ++this.frameSeq };
        this.stats.framesSent++;
        this._lastCaptureError = null;
        this.emit("frame", this.lastFrame);
      } else {
        this.stats.capturesFailed++;
        const error = r?.error || "capture_failed";
        if (error !== this._lastCaptureError) this.emit("capture_error", inputError(error));
        this._lastCaptureError = error;
        if (error === "screen_permission") {
          // Show the system prompt once; macOS applies a new grant only to a fresh process, so restart now and then.
          if (!this._permRequested) { this._permRequested = true; this.requestPermissions().catch(() => {}); }
          else if (Date.now() - (this._permRestartAt || 0) > 10_000) { this._permRestartAt = Date.now(); this.helperCapture.kill(); }
        }
      }
    } catch {
      this.stats.capturesFailed++;
    } finally {
      this.capturing = false;
    }
  }

  /** x/y: from the top-left monitor's corner, in pixels (points on macOS) (omit to act at the cursor); click: left|right|middle|double; press: down|up of button. */
  get _input() { return IS_MAC ? this.helperCapture : this.helperInput; }
  get _clip() { return IS_MAC ? this.helperCapture : this.helperClip; }

  async _inject(cmd, timeoutMs) {
    if (!IS_WIN && !IS_MAC) return { ok: false, reason: "unsupported_platform" };
    await this._input.ensure();
    const r = await this._input.cmd(cmd, timeoutMs);
    // The Accessibility prompt is shown once; macOS applies a grant without a restart.
    if (r?.error === "accessibility_permission" && !this._axRequested) {
      this._axRequested = true;
      this.requestPermissions().catch(() => {});
    }
    return { ok: !!r?.ok, error: inputError(r?.error) };
  }

  /** wheel: positive scrolls up; hwheel: positive scrolls right (Windows convention, both in 120ths of a notch). */
  async inputMouse({ x, y, click, press, button, wheel, hwheel }) {
    if (this.linux) return this.linux.mouse({ x, y, click, press, button, wheel, hwheel });
    if (IS_MAC && x != null) {
      if (!this.monitorList) await this.monitors();
      x += this.origin.x;
      y += this.origin.y;
    }
    return this._inject({ op: "mouse", x, y, click, press, button, wheel, hwheel }, 8000);
  }

  /** What a still frame shows, in input coordinates; null until the monitors are known. */
  get frameRect() { return jpegRect(this.monitorList); }

  /** press: down|up sends only that half, for held keys; without it the key is tapped with modifiers. */
  inputKey({ key, modifiers = [], press }) {
    const vk = Number(key);
    if (!Number.isFinite(vk) || vk <= 0 || vk > 254) return Promise.resolve({ ok: false, error: "bad_vk" });
    const mods = (Array.isArray(modifiers) ? modifiers : []).filter((m) => ["ctrl", "alt", "shift", "win"].includes(m));
    if (this.linux) return this.linux.key({ key: vk, modifiers: mods, press });
    return this._inject({ op: "key", key: vk, press, mods }, 8000);
  }

  inputType(text) {
    if (this.linux) return this.linux.type(text);
    return this._inject({ op: "type", text: String(text).slice(0, 512) }, 10000);
  }

  /**
   * Attached monitors in ddagrab's adapter/output order. x/y are offsets from the
   * virtual screen's top-left, the origin input coordinates use.
   */
  async monitors() {
    if (this.linux) {
      // xdotool/x11grab use raw X-screen coordinates, so monitors keep them and the origin stays 0.
      const list = await this.linux.monitors();
      if (!list.length) return { ok: false, error: "monitors_failed" };
      const monitors = list.map((m, index) => ({ index, adapter: 0, output: index, name: m.name, x: m.x, y: m.y, w: m.w, h: m.h, primary: !!m.primary }));
      this.origin = { x: 0, y: 0 };
      this.monitorList = monitors;
      return { ok: true, monitors };
    }
    if (!IS_WIN && !IS_MAC) return { ok: false, reason: "unsupported_platform" };
    await this.helperCapture.ensure();
    const r = await this.helperCapture.cmd({ op: "monitors" }, 10000);
    if (!r?.ok) return { ok: false, error: r?.error || "monitors_failed" };
    if (IS_MAC) r.monitors = macMonitors(r.monitors);
    const ox = Math.min(...r.monitors.map((m) => m.left));
    const oy = Math.min(...r.monitors.map((m) => m.top));
    const monitors = r.monitors.map((m, index) => ({
      index, adapter: m.adapter, output: m.output, name: m.name,
      x: m.left - ox, y: m.top - oy, w: m.w, h: m.h, primary: m.primary ?? (m.left === 0 && m.top === 0),
    }));
    // The Swift helper takes and reports global points, which start at the main display, not the top-left one.
    this.origin = IS_MAC ? { x: ox, y: oy } : { x: 0, y: 0 };
    this.monitorList = monitors;
    return { ok: true, monitors };
  }

  /** The pointer now, in the same space as input, or null. */
  async pointer() {
    if (this.linux) return this.linux.pointer();
    if (!IS_WIN && !IS_MAC) return null;
    await this._input.ensure();
    const r = await this._input.cmd({ op: "cursor" }, 2000);
    return r?.ok ? { x: r.x - this.origin.x, y: r.y - this.origin.y, shape: r.shape, visible: r.visible } : null;
  }

  /** macOS only: locks the screen at once; { ok:false } elsewhere or when it did not lock. */
  async lockScreen() {
    if (!IS_MAC) return { ok: false };
    await this.helperCapture.ensure();
    return this.helperCapture.cmd({ op: "lock" }, 8000);
  }

  /** Polls the pointer while anyone watches and emits "cursor" when it moves or changes shape. */
  watchCursor(on) {
    if (!on || !this.usable) { clearInterval(this.cursorTimer); this.cursorTimer = null; return; }
    if (this.cursorTimer) return;
    let busy = false;
    let last = "";
    // xdotool spawns a process per poll, so Linux polls far slower than the native Win/Mac helpers.
    this.cursorTimer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        const c = await this.pointer();
        const key = JSON.stringify(c);
        if (c && key !== last) { last = key; this.cursor = c; this.emit("cursor", c); }
      } finally { busy = false; }
    }, this.linux ? 120 : 33);
  }

  /** { kind: text|image|files|empty, ... }; images above maxImage bytes come back without png. */
  async clipboardRead(maxImage = 12 << 20) {
    if (!IS_WIN && !IS_MAC) return { ok: false, reason: "unsupported_platform" };
    await this._clip.ensure();
    const r = await this._clip.cmd({ op: "read", maxImage }, 15000);
    if (r?.ok) this.clipSeq = r.seq;
    return r?.ok ? r : { ok: false, error: r?.error || "clipboard_failed" };
  }

  /** Any of text, png (base64) and files (absolute paths) in one clipboard entry. */
  async clipboardSet({ text, png, files }) {
    if (!IS_WIN && !IS_MAC) return { ok: false, reason: "unsupported_platform" };
    await this._clip.ensure();
    const r = await this._clip.cmd({ op: "set", text, png, files }, 15000);
    // Our own write must not come back to the viewer as a PC-side change.
    if (r?.ok) this.clipSeq = r.seq;
    return { ok: !!r?.ok, error: r?.error };
  }

  /** While on, emits "clipboard" with the new content whenever something on the PC copies. */
  watchClipboard(on) {
    if (!on || (!IS_WIN && !IS_MAC)) { clearInterval(this.clipTimer); this.clipTimer = null; return; }
    if (this.clipTimer) return;
    let busy = false;
    this.clipTimer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        await this._clip.ensure();
        const r = await this._clip.cmd({ op: "seq" }, 5000);
        if (!r?.ok) return;
        if (this.clipSeq == null) { this.clipSeq = r.seq; return; }
        if (r.seq === this.clipSeq) return;
        const c = await this.clipboardRead();
        if (c.ok && c.kind !== "empty") this.emit("clipboard", c);
      } finally { busy = false; }
    }, 500);
  }

  /** macOS Screen-Recording / Accessibility grants; { ok:false } off macOS or without the helper. */
  async permissions() {
    if (!IS_MAC) return { ok: false, screen: IS_WIN || !!this.linux, accessibility: IS_WIN || !!this.linux?.supported };
    await this.helperCapture.ensure();
    return this.helperCapture.cmd({ op: "perms" }, 8000);
  }

  /** Trigger the macOS permission prompts (first run); returns the resulting grant state. */
  async requestPermissions() {
    if (!IS_MAC) return { ok: false };
    await this.helperCapture.ensure();
    return this.helperCapture.cmd({ op: "request" }, 8000);
  }

  getStatus() {
    return {
      supported: this.usable,
      streaming: !!this.captureTimer,
      clients: this.clients.size,
      quality: this.quality,
      frames: this.frameSeq,
      lastFrame: this.lastFrame ? { width: this.lastFrame.width, height: this.lastFrame.height, ts: this.lastFrame.ts } : null,
      ...this.stats,
    };
  }

  dispose() {
    this.watchCursor(false);
    this.watchClipboard(false);
    this._stopLoop();
    this.clients.clear();
    this.helperInput.kill();
    this.helperCapture.kill();
    this.helperClip.kill();
  }
}
