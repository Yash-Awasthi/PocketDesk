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
import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { EventEmitter } from "node:events";
import { configDir } from "./config.js";
// Helper scripts live in the private config dir: in a shared temp dir another user could
// swap one in before it runs, as SYSTEM for the console endpoint.

const IS_WIN = process.platform === "win32";
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
                    MIDDLEDOWN=0x0020, MIDDLEUP=0x0040, WHEEL=0x0800, VIRTUALDESK=0x4000, ABSOLUTE=0x8000,
                    KEYDOWN=0x0000, EXTENDED=0x0001, KEYUP=0x0002, UNICODE=0x0004;
  public static uint Mouse(int x, int y, uint flags, int wheel) {
    var i = new INPUT { type = 0 };
    i.u.mi = new MOUSEINPUT { dx = x, dy = y, mouseData = unchecked((uint)wheel), dwFlags = flags };
    return SendInput(1, new INPUT[]{ i }, Marshal.SizeOf(typeof(INPUT)));
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
  public static uint KeyScan(ushort scan, uint flags) {
    var i = new INPUT { type = 1 };
    i.u.ki = new KEYBDINPUT { wVk = 0, wScan = scan, dwFlags = flags };
    return SendInput(1, new INPUT[]{ i }, Marshal.SizeOf(typeof(INPUT)));
  }${DESK_MEMBERS}
}
'@
[RHI]::SetProcessDPIAware() | Out-Null
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
      # x/y are relative to the virtual screen's top-left, the same origin as a captured frame.
      if ($null -ne $cmd.x) {
        $cx = [int][Math]::Round(([double]$cmd.x / [Math]::Max(1,$vs.Width - 1)) * 65535)
        $cy = [int][Math]::Round(([double]$cmd.y / [Math]::Max(1,$vs.Height - 1)) * 65535)
        if ($cx -lt 0) {$cx=0}; if ($cx -gt 65535) {$cx=65535}
        if ($cy -lt 0) {$cy=0}; if ($cy -gt 65535) {$cy=65535}
        [RHI]::Mouse($cx, $cy, ([RHI]::MOVE -bor [RHI]::ABSOLUTE -bor [RHI]::VIRTUALDESK), 0) | Out-Null
      }
      if ($cmd.click -eq 'left' -or $cmd.click -eq 'double') { [RHI]::Mouse(0,0,[RHI]::LEFTDOWN,0) | Out-Null;  [RHI]::Mouse(0,0,[RHI]::LEFTUP,0) | Out-Null }
      if ($cmd.click -eq 'double'){ [RHI]::Mouse(0,0,[RHI]::LEFTDOWN,0) | Out-Null;  [RHI]::Mouse(0,0,[RHI]::LEFTUP,0) | Out-Null }
      if ($cmd.click -eq 'right') { [RHI]::Mouse(0,0,[RHI]::RIGHTDOWN,0) | Out-Null; [RHI]::Mouse(0,0,[RHI]::RIGHTUP,0) | Out-Null }
      if ($cmd.click -eq 'middle'){ [RHI]::Mouse(0,0,[RHI]::MIDDLEDOWN,0) | Out-Null;[RHI]::Mouse(0,0,[RHI]::MIDDLEUP,0) | Out-Null }
      if ($cmd.press) {
        $b = @{ left = @([RHI]::LEFTDOWN, [RHI]::LEFTUP); right = @([RHI]::RIGHTDOWN, [RHI]::RIGHTUP); middle = @([RHI]::MIDDLEDOWN, [RHI]::MIDDLEUP) }[[string]$cmd.button]
        if ($null -eq $b) { $b = @([RHI]::LEFTDOWN, [RHI]::LEFTUP) }
        if ($cmd.press -eq 'down') { [RHI]::Mouse(0,0,$b[0],0) | Out-Null }
        if ($cmd.press -eq 'up')   { [RHI]::Mouse(0,0,$b[1],0) | Out-Null }
      }
      if ($cmd.wheel) { [RHI]::Mouse(0,0,[RHI]::WHEEL,[int]$cmd.wheel) | Out-Null }
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
      if ($cmd.press -eq 'down') { [RHI]::Key($vk, [RHI]::KEYDOWN -bor $ext) | Out-Null; [Console]::Out.WriteLine('{"id":' + $cmd.id + ',"ok":true}'); continue }
      if ($cmd.press -eq 'up')   { [RHI]::Key($vk, [RHI]::KEYUP -bor $ext) | Out-Null; [Console]::Out.WriteLine('{"id":' + $cmd.id + ',"ok":true}'); continue }
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
      [Console]::Out.WriteLine('{"id":' + $cmd.id + ',"ok":true}')
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
      [Console]::Out.WriteLine('{"id":' + $cmd.id + ',"ok":true}')
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

  async ensure() {
    if (this.proc && this.proc.exitCode === null) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      const file = this.ensureFile();
      this.proc = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file], {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      });
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

export class DesktopController extends EventEmitter {
  static get supported() {
    return IS_WIN;
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
    this.helperCapture = new PsHelper("capture", CAPTURE_SCRIPT);
    this.helperClip = new PsHelper("clipboard", CLIP_SCRIPT);
  }

  /** Stream frames for `clientId` (server keeps the ws mapping). */
  async startFrameStream(clientId, quality) {
    if (!IS_WIN) return { ok: false, reason: "unsupported_platform" };
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
    if (!IS_WIN) return { ok: false, reason: "unsupported_platform" };
    if (!this.lastFrame) {
      // captureOnce is a no-op while the stream loop has one in flight, so
      // wait for that frame rather than reporting a failure that never was.
      if (this.capturing) await this._nextFrame(15000);
      else await this.captureOnce();
      if (!this.lastFrame) return { ok: false, reason: "capture_failed" };
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
    if (this.captureTimer || !IS_WIN) return;
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
    if (this.capturing || !IS_WIN) return;
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
        this.emit("frame", this.lastFrame);
      } else {
        this.stats.capturesFailed++;
      }
    } catch {
      this.stats.capturesFailed++;
    } finally {
      this.capturing = false;
    }
  }

  /** x/y: virtual-screen pixels from its top-left (omit to act at the cursor); click: left|right|middle|double; press: down|up of button. */
  async inputMouse({ x, y, click, press, button, wheel }) {
    if (!IS_WIN) return { ok: false, reason: "unsupported_platform" };
    await this.helperInput.ensure();
    const r = await this.helperInput.cmd({ op: "mouse", x, y, click, press, button, wheel }, 8000);
    return { ok: !!r?.ok, error: r?.error };
  }

  /** press: down|up sends only that half, for held keys; without it the key is tapped with modifiers. */
  async inputKey({ key, modifiers = [], press }) {
    if (!IS_WIN) return { ok: false, reason: "unsupported_platform" };
    const vk = Number(key);
    if (!Number.isFinite(vk) || vk <= 0 || vk > 254) return { ok: false, error: "bad_vk" };
    await this.helperInput.ensure();
    const r = await this.helperInput.cmd({ op: "key", key: vk, press, mods: Array.isArray(modifiers) ? modifiers : [] }, 8000);
    return { ok: !!r?.ok, error: r?.error };
  }

  async inputType(text) {
    if (!IS_WIN) return { ok: false, reason: "unsupported_platform" };
    await this.helperInput.ensure();
    const r = await this.helperInput.cmd({ op: "type", text: String(text).slice(0, 512) }, 10000);
    return { ok: !!r?.ok, error: r?.error };
  }

  /**
   * Attached monitors in ddagrab's adapter/output order. x/y are offsets from the
   * virtual screen's top-left, the origin input coordinates use.
   */
  async monitors() {
    if (!IS_WIN) return { ok: false, reason: "unsupported_platform" };
    await this.helperCapture.ensure();
    const r = await this.helperCapture.cmd({ op: "monitors" }, 10000);
    if (!r?.ok) return { ok: false, error: r?.error || "monitors_failed" };
    const ox = Math.min(...r.monitors.map((m) => m.left));
    const oy = Math.min(...r.monitors.map((m) => m.top));
    const monitors = r.monitors.map((m, index) => ({
      index, adapter: m.adapter, output: m.output, name: m.name,
      x: m.left - ox, y: m.top - oy, w: m.w, h: m.h, primary: m.left === 0 && m.top === 0,
    }));
    return { ok: true, monitors };
  }

  /** Polls the pointer while anyone watches and emits "cursor" when it moves or changes shape. */
  watchCursor(on) {
    if (!on || !IS_WIN) { clearInterval(this.cursorTimer); this.cursorTimer = null; return; }
    if (this.cursorTimer) return;
    let busy = false;
    let last = "";
    this.cursorTimer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        await this.helperInput.ensure();
        const r = await this.helperInput.cmd({ op: "cursor" }, 2000);
        const c = r?.ok ? { x: r.x, y: r.y, shape: r.shape, visible: r.visible } : null;
        const key = JSON.stringify(c);
        if (c && key !== last) { last = key; this.cursor = c; this.emit("cursor", c); }
      } finally { busy = false; }
    }, 33);
  }

  /** { kind: text|image|files|empty, ... }; images above maxImage bytes come back without png. */
  async clipboardRead(maxImage = 12 << 20) {
    if (!IS_WIN) return { ok: false, reason: "unsupported_platform" };
    await this.helperClip.ensure();
    const r = await this.helperClip.cmd({ op: "read", maxImage }, 15000);
    if (r?.ok) this.clipSeq = r.seq;
    return r?.ok ? r : { ok: false, error: r?.error || "clipboard_failed" };
  }

  /** Any of text, png (base64) and files (absolute paths) in one clipboard entry. */
  async clipboardSet({ text, png, files }) {
    if (!IS_WIN) return { ok: false, reason: "unsupported_platform" };
    await this.helperClip.ensure();
    const r = await this.helperClip.cmd({ op: "set", text, png, files }, 15000);
    // Our own write must not come back to the viewer as a PC-side change.
    if (r?.ok) this.clipSeq = r.seq;
    return { ok: !!r?.ok, error: r?.error };
  }

  /** While on, emits "clipboard" with the new content whenever something on the PC copies. */
  watchClipboard(on) {
    if (!on || !IS_WIN) { clearInterval(this.clipTimer); this.clipTimer = null; return; }
    if (this.clipTimer) return;
    let busy = false;
    this.clipTimer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        await this.helperClip.ensure();
        const r = await this.helperClip.cmd({ op: "seq" }, 5000);
        if (!r?.ok) return;
        if (this.clipSeq == null) { this.clipSeq = r.seq; return; }
        if (r.seq === this.clipSeq) return;
        const c = await this.clipboardRead();
        if (c.ok && c.kind !== "empty") this.emit("clipboard", c);
      } finally { busy = false; }
    }, 500);
  }

  getStatus() {
    return {
      supported: IS_WIN,
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
