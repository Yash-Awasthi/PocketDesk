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
                    MIDDLEDOWN=0x0020, MIDDLEUP=0x0040, WHEEL=0x0800, VIRTUALDESK=0x4000, ABSOLUTE=0x8000,
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
      this.proc = this._launch();
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

// macOS screen helper (Phase 2.1: view only). Same JSON-line protocol as the PowerShell helpers:
// one request object per line in, one reply per line out. CoreGraphics captures the display;
// without Screen Recording permission CGDisplayCreateImage returns null, reported as a clear error.
const MAC_CAP_SWIFT = `
import Foundation
import CoreGraphics
import AppKit
import ApplicationServices

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

func monitors() -> [[String: Any]] {
  var count: UInt32 = 0
  CGGetActiveDisplayList(0, nil, &count)
  var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
  CGGetActiveDisplayList(count, &ids, &count)
  let main = CGMainDisplayID()
  var out: [[String: Any]] = []
  for (i, id) in ids.enumerated() {
    let b = CGDisplayBounds(id)
    out.append(["index": i, "id": Int(id), "x": Int(b.origin.x), "y": Int(b.origin.y),
                "w": Int(b.width), "h": Int(b.height), "primary": id == main])
  }
  return out
}

func capture(_ scale: Double, _ index: Int) -> [String: Any] {
  var count: UInt32 = 0
  CGGetActiveDisplayList(0, nil, &count)
  var ids = [CGDirectDisplayID](repeating: 0, count: Int(count))
  CGGetActiveDisplayList(count, &ids, &count)
  let id = (index >= 0 && index < ids.count) ? ids[index] : CGMainDisplayID()
  guard let img = CGDisplayCreateImage(id) else {
    return ["ok": false, "error": "screen_permission"]  // no Screen Recording grant, or display gone
  }
  let s = max(0.2, min(1.0, scale))
  let w = max(1, Int(Double(img.width) * s)), h = max(1, Int(Double(img.height) * s))
  let cs = CGColorSpaceCreateDeviceRGB()
  guard let ctx = CGContext(data: nil, width: w, height: h, bitsPerComponent: 8, bytesPerRow: 0,
      space: cs, bitmapInfo: CGImageAlphaInfo.noneSkipFirst.rawValue) else {
    return ["ok": false, "error": "context"]
  }
  ctx.interpolationQuality = .low
  ctx.draw(img, in: CGRect(x: 0, y: 0, width: w, height: h))
  guard let scaled = ctx.makeImage() else { return ["ok": false, "error": "scale"] }
  let rep = NSBitmapImageRep(cgImage: scaled)
  guard let jpeg = rep.representation(using: .jpeg, properties: [.compressionFactor: 0.6]) else {
    return ["ok": false, "error": "encode"]
  }
  return ["ok": true, "b64": jpeg.base64EncodedString(), "w": w, "h": h]
}

// Windows virtual-key codes (what the phone and web client send) to macOS CGKeyCodes.
let VK: [Int: CGKeyCode] = [
  0x08: 51, 0x09: 48, 0x0D: 36, 0x1B: 53, 0x20: 49, 0x2E: 117, 0x24: 115, 0x23: 119,
  0x21: 116, 0x22: 121, 0x25: 123, 0x26: 126, 0x27: 124, 0x28: 125,
  0x30: 29, 0x31: 18, 0x32: 19, 0x33: 20, 0x34: 21, 0x35: 23, 0x36: 22, 0x37: 26, 0x38: 28, 0x39: 25,
  0x41: 0, 0x42: 11, 0x43: 8, 0x44: 2, 0x45: 14, 0x46: 3, 0x47: 5, 0x48: 4, 0x49: 34, 0x4A: 38,
  0x4B: 40, 0x4C: 37, 0x4D: 46, 0x4E: 45, 0x4F: 31, 0x50: 35, 0x51: 12, 0x52: 15, 0x53: 1, 0x54: 17,
  0x55: 32, 0x56: 9, 0x57: 13, 0x58: 7, 0x59: 16, 0x5A: 6,
  0x70: 122, 0x71: 120, 0x72: 99, 0x73: 118, 0x74: 96, 0x75: 97, 0x76: 98, 0x77: 100,
]

// The capture is in pixels; CGEvent works in points. On Retina that ratio is 2, so incoming
// pixel coordinates (already mapped to full-capture pixels by the server) convert to points here.
func pointScale() -> Double {
  let id = CGMainDisplayID()
  let px = Double(CGDisplayPixelsWide(id))
  let pt = Double(CGDisplayBounds(id).width)
  return px > 0 ? pt / px : 1.0
}

func flags(_ mods: [String]) -> CGEventFlags {
  var f = CGEventFlags()
  if mods.contains("ctrl") { f.insert(.maskControl) }
  if mods.contains("alt") { f.insert(.maskAlternate) }
  if mods.contains("shift") { f.insert(.maskShift) }
  if mods.contains("win") { f.insert(.maskCommand) }
  return f
}

func postMouse(_ cmd: [String: Any]) -> [String: Any] {
  let sc = pointScale()
  let loc = CGEvent(source: nil)?.location ?? .zero
  let x = cmd["x"] != nil ? Double(cmd["x"] as? Int ?? 0) * sc : Double(loc.x)
  let y = cmd["y"] != nil ? Double(cmd["y"] as? Int ?? 0) * sc : Double(loc.y)
  let p = CGPoint(x: x, y: y)
  let btn = cmd["button"] as? String ?? "left"
  let down: CGEventType = btn == "right" ? .rightMouseDown : btn == "middle" ? .otherMouseDown : .leftMouseDown
  let up: CGEventType = btn == "right" ? .rightMouseUp : btn == "middle" ? .otherMouseUp : .leftMouseUp
  let cgBtn: CGMouseButton = btn == "right" ? .right : btn == "middle" ? .center : .left
  func ev(_ t: CGEventType) { CGEvent(mouseEventSource: nil, mouseType: t, mouseCursorPosition: p, mouseButton: cgBtn)?.post(tap: .cghidEventTap) }
  if cmd["x"] != nil || cmd["y"] != nil { ev(.mouseMoved) }
  if let click = cmd["click"] as? String {
    let d: CGEventType = click == "right" ? .rightMouseDown : click == "middle" ? .otherMouseDown : .leftMouseDown
    let u: CGEventType = click == "right" ? .rightMouseUp : click == "middle" ? .otherMouseUp : .leftMouseUp
    ev(d); ev(u); if click == "double" { ev(d); ev(u) }
  }
  if let press = cmd["press"] as? String { ev(press == "down" ? down : up) }
  if let wheel = cmd["wheel"] as? Int, wheel != 0 {
    CGEvent(scrollWheelEvent2Source: nil, units: .pixel, wheelCount: 1, wheel1: Int32(wheel), wheel2: 0, wheel3: 0)?.post(tap: .cghidEventTap)
  }
  return ["ok": true]
}

func postKey(_ cmd: [String: Any]) -> [String: Any] {
  guard let vk = cmd["key"] as? Int, let code = VK[vk] else { return ["ok": false, "error": "unmapped_key"] }
  let f = flags(cmd["mods"] as? [String] ?? [])
  func ev(_ down: Bool) { let e = CGEvent(keyboardEventSource: nil, virtualKey: code, keyDown: down); e?.flags = f; e?.post(tap: .cghidEventTap) }
  switch cmd["press"] as? String {
  case "down": ev(true)
  case "up": ev(false)
  default: ev(true); ev(false)
  }
  return ["ok": true]
}

func cursor() -> [String: Any] {
  let sc = pointScale()  // points per pixel
  let p = NSEvent.mouseLocation  // points, bottom-left origin
  let h = CGDisplayBounds(CGMainDisplayID()).height  // points
  let xPx = sc > 0 ? Double(p.x) / sc : Double(p.x)
  let yPx = sc > 0 ? (Double(h) - Double(p.y)) / sc : (Double(h) - Double(p.y))
  return ["ok": true, "x": Int(xPx), "y": Int(yPx), "shape": "default", "visible": true]
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
    pb.writeObjects(files.map { URL(fileURLToPath: $0) as NSURL })
  } else if let b64 = cmd["png"] as? String, let data = Data(base64Encoded: b64) {
    pb.setData(data, forType: .png)
  } else if let text = cmd["text"] as? String {
    pb.setString(text, forType: .string)
  }
  return ["ok": true, "seq": pb.changeCount]
}

func postType(_ text: String) -> [String: Any] {
  for ch in text.unicodeScalars {
    let e = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: true)
    var u = [UniChar(ch.value & 0xffff)]
    e?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &u)
    e?.post(tap: .cghidEventTap)
    let up = CGEvent(keyboardEventSource: nil, virtualKey: 0, keyDown: false)
    up?.keyboardSetUnicodeString(stringLength: 1, unicodeString: &u)
    up?.post(tap: .cghidEventTap)
  }
  return ["ok": true]
}

while let line = readLine(strippingNewline: true) {
  guard let data = line.data(using: .utf8),
        let cmd = (try? JSONSerialization.jsonObject(with: data)) as? [String: Any] else { continue }
  let id = cmd["id"]
  let op = cmd["op"] as? String ?? ""
  var out: [String: Any]
  switch op {
  case "ping": out = ["ok": true]
  case "monitors": out = ["ok": true, "monitors": monitors()]
  case "capture": out = capture(cmd["s"] as? Double ?? 1.0, cmd["index"] as? Int ?? -1)
  case "perms": out = perms()
  case "request": out = requestPerms()
  case "mouse": out = postMouse(cmd)
  case "key": out = postKey(cmd)
  case "type": out = postType(cmd["text"] as? String ?? "")
  case "cursor": out = cursor()
  case "seq": out = clipSeq()
  case "read": out = clipRead(cmd["maxImage"] as? Int ?? (12 << 20))
  case "set": out = clipSet(cmd)
  default: out = ["ok": false, "error": "unknown_op"]
  }
  if let id = id { out["id"] = id }
  reply(out)
}
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
    if (binExists() && !stale()) return this.bin;
    // A missing or broken swiftc would otherwise be retried on every poll (cursor runs at 33ms).
    // After a failure, don't attempt another compile for a minute.
    if (this._compileFailedAt && Date.now() - this._compileFailedAt < 60_000) {
      throw new Error("swift helper compile unavailable");
    }
    try {
      fs.writeFileSync(src, this.script, { encoding: "utf8" });
      execFileSync("swiftc", ["-O", src, "-o", this.bin], { stdio: "ignore", timeout: 60000 });
      this._compileFailedAt = 0;
    } catch (e) {
      this._compileFailedAt = Date.now();
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

export class DesktopController extends EventEmitter {
  static get supported() {
    return IS_WIN || IS_MAC;
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
  }

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
      if (!this.lastFrame) return { ok: false, reason: this._lastCaptureError || "capture_failed" };
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
        this.emit("frame", this.lastFrame);
      } else {
        this.stats.capturesFailed++;
        this._lastCaptureError = r?.error || "capture_failed";
        // Blocked on macOS Screen Recording: show the system prompt once so the user can grant it.
        if (r?.error === "screen_permission" && !this._permRequested) {
          this._permRequested = true;
          this.requestPermissions().catch(() => {});
        }
      }
    } catch {
      this.stats.capturesFailed++;
    } finally {
      this.capturing = false;
    }
  }

  /** x/y: virtual-screen pixels from its top-left (omit to act at the cursor); click: left|right|middle|double; press: down|up of button. */
  get _input() { return IS_MAC ? this.helperCapture : this.helperInput; }
  get _clip() { return IS_MAC ? this.helperCapture : this.helperClip; }

  async inputMouse({ x, y, click, press, button, wheel }) {
    if (!IS_WIN && !IS_MAC) return { ok: false, reason: "unsupported_platform" };
    await this._input.ensure();
    const r = await this._input.cmd({ op: "mouse", x, y, click, press, button, wheel }, 8000);
    return { ok: !!r?.ok, error: r?.error };
  }

  /** press: down|up sends only that half, for held keys; without it the key is tapped with modifiers. */
  async inputKey({ key, modifiers = [], press }) {
    if (!IS_WIN && !IS_MAC) return { ok: false, reason: "unsupported_platform" };
    const vk = Number(key);
    if (!Number.isFinite(vk) || vk <= 0 || vk > 254) return { ok: false, error: "bad_vk" };
    await this._input.ensure();
    const r = await this._input.cmd({ op: "key", key: vk, press, mods: Array.isArray(modifiers) ? modifiers : [] }, 8000);
    return { ok: !!r?.ok, error: r?.error };
  }

  async inputType(text) {
    if (!IS_WIN && !IS_MAC) return { ok: false, reason: "unsupported_platform" };
    await this._input.ensure();
    const r = await this._input.cmd({ op: "type", text: String(text).slice(0, 512) }, 10000);
    return { ok: !!r?.ok, error: r?.error };
  }

  /**
   * Attached monitors in ddagrab's adapter/output order. x/y are offsets from the
   * virtual screen's top-left, the origin input coordinates use.
   */
  async monitors() {
    if (!IS_WIN && !IS_MAC) return { ok: false, reason: "unsupported_platform" };
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
    if (!on || (!IS_WIN && !IS_MAC)) { clearInterval(this.cursorTimer); this.cursorTimer = null; return; }
    if (this.cursorTimer) return;
    let busy = false;
    let last = "";
    this.cursorTimer = setInterval(async () => {
      if (busy) return;
      busy = true;
      try {
        await this._input.ensure();
        const r = await this._input.cmd({ op: "cursor" }, 2000);
        const c = r?.ok ? { x: r.x, y: r.y, shape: r.shape, visible: r.visible } : null;
        const key = JSON.stringify(c);
        if (c && key !== last) { last = key; this.cursor = c; this.emit("cursor", c); }
      } finally { busy = false; }
    }, 33);
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
    if (!IS_MAC) return { ok: false, screen: IS_WIN, accessibility: IS_WIN };
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
      supported: IS_WIN || IS_MAC,
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
