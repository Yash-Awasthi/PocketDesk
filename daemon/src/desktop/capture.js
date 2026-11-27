/**
 * Windows/macOS desktop capture + input helper layer, split from desktop_capture.js.
 * Owns the persistent helper processes, frame capture and the DesktopController.
 */

import { spawn, execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { configDir } from "../config.js";
import { LinuxDesktop, IS_LINUX } from "../linux_desktop.js";
import { WaylandDesktop, IS_WAYLAND } from "../wayland_desktop.js";
import { InputController, inputError } from "./input.js";
import { clampQuality, captureFrameDXGI, dxgiArgs, ffmpegPath, parseRate } from "./encode.js";
import { orderFor, describeModes, classifyCause, verdict } from "./capture_modes.js";
import { macMonitors } from "./topology.js";
// Helper scripts live in the private config dir: in a shared temp dir another user could
// swap one in before it runs, as SYSTEM for the console endpoint.

const IS_WIN = process.platform === "win32";
const IS_MAC = process.platform === "darwin";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Whether this process can see elevated windows (UIPI). A non-elevated daemon captures only
// unelevated windows and injects input only into them. Cached: elevation does not change at runtime.
let _elevated = null;
function isElevated() {
  if (_elevated !== null) return _elevated;
  if (!IS_WIN) {
    _elevated = true;
    return _elevated;
  }
  try {
    execFileSync("net", ["session"], { stdio: "ignore", windowsHide: true, timeout: 3000 });
    _elevated = true;
  } catch {
    _elevated = false;
  }
  return _elevated;
}

// Foreground window rectangle, in virtual-screen coordinates; null off Windows or on failure.
const FG_RECT_SCRIPT =
  "Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public struct R{public int L,T,Rt,B;}public static class FG{[DllImport(\"user32.dll\")]public static extern IntPtr GetForegroundWindow();[DllImport(\"user32.dll\")]public static extern bool GetWindowRect(IntPtr h,out R r);}';$h=[FG]::GetForegroundWindow();$r=New-Object R;[FG]::GetWindowRect($h,[ref]$r)|Out-Null;'{0} {1} {2} {3}' -f $r.L,$r.T,$r.Rt,$r.B";
function foregroundRect() {
  if (!IS_WIN) return null;
  try {
    const out = execFileSync(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", FG_RECT_SCRIPT],
      { encoding: "utf8", windowsHide: true, timeout: 4000 },
    );
    const m = out.trim().match(/^(-?\d+)\s+(-?\d+)\s+(-?\d+)\s+(-?\d+)$/);
    return m ? { left: +m[1], top: +m[2], right: +m[3], bottom: +m[4] } : null;
  } catch {
    return null;
  }
}

/** JSON-safe, ASCII-only wire line (PS 5.1 stdin is happiest with ASCII). */
function wireLine(obj) {
  return (
    JSON.stringify(obj).replace(
      /[\u0080-\uFFFF]/g,
      (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0"),
    ) + "\n"
  );
}

/** One raw BGRA frame from a DXGI output, cropped to the window rectangle. */
function captureFrameDXGIRaw(output, crop) {
  const args = dxgiArgs(60, output);
  const gi = args.indexOf("-filter_complex");
  if (gi >= 0) args[gi + 1] += `,crop=${crop.w}:${crop.h}:${crop.x}:${crop.y}`;
  const fi = args.indexOf("-f");
  const argv = fi >= 0 ? [...args.slice(0, fi), "-f", "rawvideo", "-pix_fmt", "bgra", "pipe:1"] : args;
  return new Promise((resolve) => {
    let out = Buffer.alloc(0);
    let stderr = "";
    let done = false;
    const child = spawn(ffmpegPath(), argv, { windowsHide: true });
    const finish = (r) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      try {
        child.kill("SIGKILL");
      } catch {}
      resolve(r);
    };
    const timer = setTimeout(() => finish({ ok: false, error: "ffmpeg_timeout" }), 10000);
    child.stdout.on("data", (d) => (out = Buffer.concat([out, d])));
    child.stderr.on("data", (d) => (stderr += d.toString()));
    child.on("error", (e) => finish({ ok: false, error: e.message }));
    child.on("close", (code) => {
      if (code !== 0 || out.length < crop.w * crop.h * 4)
        return finish({ ok: false, error: stderr.trim() || `ffmpeg exited ${code}` });
      finish({ ok: true, frame: out });
    });
  });
}

/** Distinct colours (cap 50000) and mean luminance on every 2nd pixel, as the helper counts. */
function measureBgra(buf, w, h) {
  const seen = new Set();
  let sum = 0;
  let n = 0;
  for (let y = 0; y < h; y++) {
    const row = y * w * 4;
    for (let x = 0; x < w; x += 2) {
      const i = row + x * 4;
      const b = buf[i];
      const g = buf[i + 1];
      const r = buf[i + 2];
      if (seen.size < 50000) seen.add((r << 16) | (g << 8) | b);
      sum += (r * 299 + g * 587 + b * 114) / 1000;
      n++;
    }
  }
  return { colours: seen.size, luminance: n ? sum / n : 0 };
}

const COMMON_PRELUDE = `
$ErrorActionPreference = 'Stop'
`;

// The console endpoint runs as SYSTEM in the console session, which may attach to the
// secure desktop (UAC, lock screen). Only it gets this, so the user daemon's scripts stay unchanged.
const IS_CONSOLE = IS_WIN && !!process.env.RH_CONSOLE;
const DESK_MEMBERS = IS_CONSOLE
  ? `
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
`
  : "";
const followInput = (cls) => (IS_CONSOLE ? `[${cls}]::FollowInput()\n  ` : "");

const INPUT_SCRIPT =
  COMMON_PRELUDE +
  `
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
      if ($null -ne $cmd.dx) {
        $cx = [int]$cmd.dx; $cy = [int]$cmd.dy; $pos = [RHI]::MOVE
      } elseif ($null -ne $cmd.x) {
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

const CAPTURE_SCRIPT =
  COMMON_PRELUDE +
  `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -AssemblyName System.Drawing
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
using System.Collections.Generic;
public static class RHD {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
  [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr value);
  /** Real pixels on every monitor: a system-aware process gets virtualised coords on other-DPI screens. */
  public static void DpiAware() {
    try { if (SetProcessDpiAwarenessContext(new IntPtr(-4))) return; } catch { }
    SetProcessDPIAware();
  }
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
  [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] static extern bool GetWindowDisplayAffinity(IntPtr hwnd, out uint affinity);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
  /**
   * Title of the focused window when Windows excludes it from capture (a game shielding its
   * screen), or "". WDA_MONITOR = 1, WDA_EXCLUDEFROMCAPTURE = 0x11: both reach CopyFromScreen
   * and Desktop Duplication as black, and only the window's own process may clear the flag.
   */
  public static string BlockedWindow() {
    IntPtr h = GetForegroundWindow();
    if (h == IntPtr.Zero) return "";
    uint a;
    if (!GetWindowDisplayAffinity(h, out a) || (a != 1 && a != 0x11)) return "";
    var sb = new StringBuilder(256);
    GetWindowText(h, sb, sb.Capacity);
    return sb.ToString();
  }
  [StructLayout(LayoutKind.Sequential)] public struct WRECT { public int L, T, R, B; }
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out WRECT r);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("shell32.dll")] static extern int SHQueryUserNotificationState(out int state);
  /**
   * [state, d3d, pid, w, h, title] for the focused window. state is SHQueryUserNotificationState:
   * 2 a fullscreen app is in front, 3 a D3D app has taken the display (true exclusive fullscreen,
   * outside DWM, so Desktop Duplication and GDI come back empty until it lets go).
   */
  public static string[] Fullscreen() {
    int s = -1;
    int hr = SHQueryUserNotificationState(out s);
    IntPtr h = GetForegroundWindow();
    var sb = new StringBuilder(256);
    if (h != IntPtr.Zero) GetWindowText(h, sb, sb.Capacity);
    var r = new WRECT();
    uint pid = 0;
    if (h != IntPtr.Zero) { GetWindowRect(h, out r); GetWindowThreadProcessId(h, out pid); }
    return new string[] {
      (hr == 0 ? s : -1).ToString(),
      (s == 3 ? "true" : "false"),
      pid.ToString(),
      (r.R - r.L).ToString(),
      (r.B - r.T).ToString(),
      sb.ToString(),
    };
  }
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetClassName(IntPtr h, StringBuilder s, int n);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr p);
  [DllImport("user32.dll")] static extern bool PrintWindow(IntPtr h, IntPtr dc, uint flags);
  [DllImport("user32.dll")] static extern IntPtr GetWindowDC(IntPtr h);
  [DllImport("user32.dll")] static extern int ReleaseDC(IntPtr h, IntPtr dc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern IntPtr CreateCompatibleBitmap(IntPtr dc, int w, int h);
  [DllImport("gdi32.dll")] static extern IntPtr SelectObject(IntPtr dc, IntPtr o);
  [DllImport("gdi32.dll")] static extern bool BitBlt(IntPtr d, int x, int y, int w, int h, IntPtr s, int sx, int sy, int rop);
  [DllImport("gdi32.dll")] static extern bool DeleteObject(IntPtr o);
  [DllImport("gdi32.dll")] static extern bool DeleteDC(IntPtr dc);
  [DllImport("gdi32.dll")] static extern int GetDIBits(IntPtr dc, IntPtr bmp, uint start, uint lines, byte[] bits, ref BMI bi, uint usage);
  delegate bool EnumProc(IntPtr h, IntPtr p);
  [StructLayout(LayoutKind.Sequential)] public struct BIH { public uint size; public int width, height; public ushort planes, bits; public uint compression, image; public int xppm, yppm; public uint used, important; }
  [StructLayout(LayoutKind.Sequential)] public struct BMI { public BIH h; public uint colors; }

  /** One-line JSON text: quotes and backslashes escaped, control characters flattened. */
  public static string Esc(string s) {
    if (s == null) return "";
    StringBuilder b = new StringBuilder(s.Length + 8);
    foreach (char c in s) {
      if (c == '"' || c == (char)92) { b.Append((char)92); b.Append(c); }
      else if (c < 32) b.Append(' ');
      else b.Append(c);
    }
    return b.ToString();
  }
  static string K(string k) { return '"' + k + '"' + ':'; }
  static string Num(double v) { return v.ToString("0.0", System.Globalization.CultureInfo.InvariantCulture); }
  static string Aff(uint a) {
    if (a == 0) return "none (0)";
    if (a == 1) return "monitor (1)";
    if (a == 0x11) return "excluded (17)";
    return "0x" + a.ToString("X");
  }

  /** The shape every window entry carries; titles are clipped to 80 characters. */
  static string WinJson(IntPtr h) {
    StringBuilder t = new StringBuilder(512);
    GetWindowText(h, t, t.Capacity);
    string title = t.ToString();
    if (title.Length > 80) title = title.Substring(0, 80);
    StringBuilder c = new StringBuilder(256);
    GetClassName(h, c, c.Capacity);
    uint pid = 0;
    GetWindowThreadProcessId(h, out pid);
    string proc = "?";
    try { proc = System.Diagnostics.Process.GetProcessById((int)pid).ProcessName; } catch { }
    WRECT r = new WRECT();
    if (!GetWindowRect(h, out r)) { r.L = 0; r.T = 0; r.R = 0; r.B = 0; }
    uint a = 0;
    GetWindowDisplayAffinity(h, out a);
    StringBuilder b = new StringBuilder(256);
    b.Append('{');
    b.Append(K("hwnd")).Append(h.ToInt64());
    b.Append(',').Append(K("title")).Append('"').Append(Esc(title)).Append('"');
    b.Append(',').Append(K("pid")).Append(pid);
    b.Append(',').Append(K("process")).Append('"').Append(Esc(proc)).Append('"');
    b.Append(',').Append(K("class")).Append('"').Append(Esc(c.ToString())).Append('"');
    b.Append(',').Append(K("affinity")).Append('"').Append(Esc(Aff(a))).Append('"');
    b.Append(',').Append(K("w")).Append(r.R - r.L);
    b.Append(',').Append(K("h")).Append(r.B - r.T);
    b.Append(',').Append(K("x")).Append(r.L);
    b.Append(',').Append(K("y")).Append(r.T);
    b.Append('}');
    return b.ToString();
  }

  /** Pixels of a window (PrintWindow) or of the desktop under the same rect, top-down 32bpp. */
  static byte[] Grab(IntPtr hwnd, int x, int y, int w, int h, bool print, out bool ok) {
    ok = false;
    IntPtr src = print ? GetWindowDC(hwnd) : GetWindowDC(IntPtr.Zero);
    if (src == IntPtr.Zero) return null;
    IntPtr mem = CreateCompatibleDC(src);
    IntPtr bmp = CreateCompatibleBitmap(src, w, h);
    IntPtr old = SelectObject(mem, bmp);
    try {
      if (print) ok = PrintWindow(hwnd, mem, 2);
      else ok = BitBlt(mem, 0, 0, w, h, src, x, y, 0x00CC0020);
      SelectObject(mem, old);
      BMI bi = new BMI();
      bi.h.size = (uint)Marshal.SizeOf(typeof(BIH));
      bi.h.width = w;
      bi.h.height = -h;
      bi.h.planes = 1;
      bi.h.bits = 32;
      byte[] buf = new byte[w * h * 4];
      int got = GetDIBits(mem, bmp, 0, (uint)h, buf, ref bi, 0);
      return got == h ? buf : null;
    } finally {
      DeleteObject(bmp);
      DeleteDC(mem);
      ReleaseDC(print ? hwnd : IntPtr.Zero, src);
    }
  }

  /** Every 2nd pixel: distinct colours capped at 50000, mean luminance on the 299/587/114 weights. */
  static void Count(byte[] buf, int w, int h, out int colours, out double luminance) {
    HashSet<int> seen = new HashSet<int>();
    long sum = 0, n = 0;
    for (int y = 0; y < h; y++) {
      int row = y * w * 4;
      for (int x = 0; x < w; x += 2) {
        int i = row + x * 4;
        int b = buf[i], g = buf[i + 1], r = buf[i + 2];
        if (seen.Count < 50000) seen.Add((r << 16) | (g << 8) | b);
        sum += (r * 299 + g * 587 + b * 114) / 1000;
        n++;
      }
    }
    colours = seen.Count;
    luminance = n == 0 ? 0 : (double)sum / n;
  }

  /** Percent of sampled pixels that differ by more than 24 summed channels, as the probe measured it. */
  static double Diff(byte[] a, byte[] b, int w, int h, int inset = 0) {
    long differ = 0, total = 0;
    for (int y = inset; y < h - inset; y++) {
      int row = y * w * 4;
      for (int x = inset; x < w - inset; x += 2) {
        int i = row + x * 4;
        int d = Math.Abs(a[i] - b[i]) + Math.Abs(a[i + 1] - b[i + 1]) + Math.Abs(a[i + 2] - b[i + 2]);
        if (d > 24) differ++;
        total++;
      }
    }
    return total == 0 ? 0 : 100.0 * differ / total;
  }

  static string RoutesJson(IntPtr hwnd, int x, int y, int w, int h) {
    bool pok, sok;
    byte[] pb = Grab(hwnd, 0, 0, w, h, true, out pok);
    byte[] sb = Grab(hwnd, x, y, w, h, false, out sok);
    if (pb == null || sb == null) return "null";
    int pc, sc;
    double pl, sl;
    Count(pb, w, h, out pc, out pl);
    Count(sb, w, h, out sc, out sl);
    string verdict = pc <= 2 ? "blocked" : Diff(pb, sb, w, h) < 0.5 ? "identical_to_desktop" : "usable";
    StringBuilder b = new StringBuilder(256);
    b.Append('{').Append(K("printwindow")).Append('{');
    b.Append(K("ok")).Append(pok ? "true" : "false");
    b.Append(',').Append(K("colours")).Append(pc);
    b.Append(',').Append(K("luminance")).Append(Num(pl));
    b.Append(',').Append(K("verdict")).Append('"').Append(verdict).Append('"');
    b.Append('}');
    b.Append(',').Append(K("screen")).Append('{');
    b.Append(K("ok")).Append(sok ? "true" : "false");
    b.Append(',').Append(K("colours")).Append(sc);
    b.Append(',').Append(K("luminance")).Append(Num(sl));
    b.Append('}').Append('}');
    return b.ToString();
  }

  static string JsonError(string cause, string detail) {
    StringBuilder b = new StringBuilder(128);
    b.Append('{').Append(K("ok")).Append("false");
    b.Append(',').Append(K("cause")).Append('"').Append(Esc(cause)).Append('"');
    if (detail != null && detail.Length > 0) b.Append(',').Append(K("detail")).Append('"').Append(Esc(detail)).Append('"');
    b.Append('}');
    return b.ToString();
  }
  static string Pct(double v) { return v.ToString("0.00", System.Globalization.CultureInfo.InvariantCulture); }

  /** One route, one window: colours and mean luminance. mode is printwindow or screen. */
  public static string ShotJson(string mode, long hwndValue) {
    IntPtr h = new IntPtr(hwndValue);
    if (h == IntPtr.Zero) return JsonError("no_window", "");
    WRECT r = new WRECT();
    if (!GetWindowRect(h, out r) || r.R <= r.L || r.B <= r.T) return JsonError("no_window", "");
    int w = r.R - r.L, hh = r.B - r.T;
    bool ok;
    byte[] buf = Grab(h, r.L, r.T, w, hh, mode == "printwindow", out ok);
    if (buf == null) return JsonError("capture_empty", "");
    int colours; double lum;
    Count(buf, w, hh, out colours, out lum);
    StringBuilder b = new StringBuilder(256);
    b.Append('{').Append(K("ok")).Append("true");
    b.Append(',').Append(K("mode")).Append('"').Append(Esc(mode)).Append('"');
    b.Append(',').Append(K("w")).Append(w);
    b.Append(',').Append(K("h")).Append(hh);
    b.Append(',').Append(K("colours")).Append(colours);
    b.Append(',').Append(K("luminance")).Append(Num(lum));
    b.Append(',').Append(K("uniform")).Append(colours <= 2 ? "true" : "false");
    b.Append('}');
    return b.ToString();
  }

  /** control/gate/reverse on the screen route against the gated PrintWindow render; leaves the gate off. */
  public static string CheckJson(long hwndValue) {
    IntPtr h = new IntPtr(hwndValue);
    if (h == IntPtr.Zero) return JsonError("no_window", "");
    WRECT r = new WRECT();
    if (!GetWindowRect(h, out r) || r.R <= r.L || r.B <= r.T) return JsonError("no_window", "");
    int w = r.R - r.L, hh = r.B - r.T;
    string err = "";
    bool on = false;
    try {
      if (!RHGate.Ensure(hwndValue, true, out err)) return JsonError(CauseFor(err), err);
      on = true;
      System.Threading.Thread.Sleep(120);
      bool rok;
      byte[] reference = Grab(h, 0, 0, w, hh, true, out rok);
      if (reference == null) return JsonError("exclusive_fullscreen", "PrintWindow returned nothing");
      int rc; double rl;
      Count(reference, w, hh, out rc, out rl);
      if (rc <= 2) return JsonError("exclusive_fullscreen", "PrintWindow is still uniform with the gate on");
      bool rok2;
      byte[] again = Grab(h, 0, 0, w, hh, true, out rok2);
      if (again == null || Diff(reference, again, w, hh, 12) > 0.5)
        return JsonError("window_moving", "the window redrew between frames; pause it and run the check again");
      if (!RHGate.Ensure(hwndValue, false, out err)) return JsonError(CauseFor(err), err);
      on = false;
      System.Threading.Thread.Sleep(120);
      bool cok;
      byte[] control = Grab(h, r.L, r.T, w, hh, false, out cok);
      if (!RHGate.Ensure(hwndValue, true, out err)) return JsonError(CauseFor(err), err);
      on = true;
      System.Threading.Thread.Sleep(120);
      bool gok;
      byte[] gated = Grab(h, r.L, r.T, w, hh, false, out gok);
      if (!RHGate.Ensure(hwndValue, false, out err)) return JsonError(CauseFor(err), err);
      on = false;
      System.Threading.Thread.Sleep(120);
      bool vok;
      byte[] reverse = Grab(h, r.L, r.T, w, hh, false, out vok);
      if (control == null || gated == null || reverse == null) return JsonError("capture_empty", "");
      int cc, gc, vc; double cl, gl, vl;
      Count(control, w, hh, out cc, out cl);
      Count(gated, w, hh, out gc, out gl);
      Count(reverse, w, hh, out vc, out vl);
      double controlPct = Diff(control, reference, w, hh, 12);
      double gatedPct = Diff(gated, reference, w, hh, 12);
      double reversePct = Diff(reverse, reference, w, hh, 12);
      StringBuilder b = new StringBuilder(320);
      b.Append('{').Append(K("ok")).Append("true");
      b.Append(',').Append(K("route")).Append('"').Append("screen").Append('"');
      b.Append(',').Append(K("reference")).Append('"').Append("printwindow").Append('"');
      b.Append(',').Append(K("w")).Append(w);
      b.Append(',').Append(K("h")).Append(hh);
      b.Append(',').Append(K("controlPct")).Append(Pct(controlPct));
      b.Append(',').Append(K("gatedPct")).Append(Pct(gatedPct));
      b.Append(',').Append(K("reversePct")).Append(Pct(reversePct));
      b.Append(',').Append(K("controlColours")).Append(cc);
      b.Append(',').Append(K("gatedColours")).Append(gc);
      b.Append(',').Append(K("reverseColours")).Append(vc);
      b.Append('}');
      return b.ToString();
    } finally {
      if (on) { string ignored; RHGate.Ensure(hwndValue, false, out ignored); }
    }
  }

  static string CauseFor(string err) {
    if (err == null) return "unknown";
    if (err.IndexOf("win32=5") >= 0) return "needs_elevation";
    if (err.IndexOf("open_process") >= 0) return "protected_process";
    if (err.IndexOf("target_is_32bit") >= 0 || err.IndexOf("helper_not_64bit") >= 0) return "architecture_mismatch";
    if (err.IndexOf("prologue_not_indirect_jump") >= 0 || err.IndexOf("export_missing") >= 0) return "unsupported_export";
    if (err.IndexOf("no_window") >= 0 || err.IndexOf("no_target_process") >= 0) return "no_window";
    return "unknown";
  }
  /** What this PC offers right now: windows, foreground, fullscreen state and which route reads it. */
  public static string ProbeJson() {
    List<string> wins = new List<string>();
    EnumWindows(delegate(IntPtr h, IntPtr p) {
      if (wins.Count >= 60) return false;
      try {
        if (!IsWindowVisible(h)) return true;
        StringBuilder t = new StringBuilder(512);
        if (GetWindowText(h, t, t.Capacity) <= 0) return true;
        wins.Add(WinJson(h));
      } catch { }
      return true;
    }, IntPtr.Zero);

    StringBuilder b = new StringBuilder(8192);
    b.Append('{').Append(K("windows")).Append('[').Append(string.Join(",", wins)).Append(']');

    IntPtr fg = GetForegroundWindow();
    string fgj = "null";
    if (fg != IntPtr.Zero) {
      try { fgj = WinJson(fg); } catch { fgj = "null"; }
    }
    b.Append(',').Append(K("foreground")).Append(fgj);

    string[] f = Fullscreen();
    b.Append(',').Append(K("fullscreen")).Append('{');
    b.Append(K("d3d")).Append(f[1] == "true" ? "true" : "false");
    b.Append(',').Append(K("state")).Append(f[0]);
    b.Append(',').Append(K("pid")).Append(f[2]);
    b.Append(',').Append(K("title")).Append('"').Append(Esc(f[5])).Append('"');
    b.Append('}');

    string routes = "null";
    if (fg != IntPtr.Zero) {
      WRECT r = new WRECT();
      if (GetWindowRect(fg, out r) && r.R > r.L && r.B > r.T) {
        try { routes = RoutesJson(fg, r.L, r.T, r.R - r.L, r.B - r.T); } catch { routes = "null"; }
      }
    }
    b.Append(',').Append(K("routes")).Append(routes).Append('}');
    return b.ToString();
  }
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
public static class RHGate {
  const uint PROCESS_CREATE_THREAD = 0x0002, PROCESS_VM_OPERATION = 0x0008;
  const uint PROCESS_VM_WRITE = 0x0020, PROCESS_VM_READ = 0x0010, PROCESS_QUERY_INFORMATION = 0x0400;
  const uint MEM_COMMIT_RESERVE = 0x3000, MEM_RELEASE = 0x8000;
  const uint PAGE_EXECUTE_READWRITE = 0x40, PAGE_READWRITE = 0x04;
  const int STUB_AT = 0x000, ORIGINAL_AT = 0x100, SWITCH_AT = 0x110, PAGE_SIZE = 0x1000;

  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr OpenProcess(uint a, bool inherit, uint pid);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr VirtualAllocEx(IntPtr p, IntPtr at, UIntPtr n, uint type, uint prot);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool VirtualFreeEx(IntPtr p, IntPtr at, UIntPtr n, uint type);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool VirtualProtectEx(IntPtr p, IntPtr at, UIntPtr n, uint prot, out uint old);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool WriteProcessMemory(IntPtr p, IntPtr at, byte[] b, UIntPtr n, out UIntPtr written);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool ReadProcessMemory(IntPtr p, IntPtr at, byte[] b, UIntPtr n, out UIntPtr read);
  [DllImport("kernel32.dll", SetLastError = true)] static extern IntPtr CreateRemoteThread(IntPtr p, IntPtr attrs, UIntPtr stack, IntPtr start, IntPtr param, uint flags, out uint id);
  [DllImport("kernel32.dll")] static extern uint WaitForSingleObject(IntPtr h, uint ms);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
  [DllImport("kernel32.dll", CharSet = CharSet.Ansi)] static extern IntPtr GetProcAddress(IntPtr module, string name);
  [DllImport("kernel32.dll", SetLastError = true)] static extern bool IsWow64Process(IntPtr p, out bool wow);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("user32.dll")] static extern bool GetWindowDisplayAffinity(IntPtr h, out uint a);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr h);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern int GetWindowText(IntPtr h, StringBuilder s, int n);
  delegate bool GateProc(IntPtr h, IntPtr p);
  [DllImport("user32.dll")] static extern bool EnumWindows(GateProc cb, IntPtr p);

  static string Q(string s) { return '"' + RHD.Esc(s) + '"'; }
  static string Fail(string error, int win32, string note) {
    return "{" + Q("ok") + ":false" + "," + Q("error") + ":" + Q(error) +
           "," + Q("win32") + ":" + win32 + "," + Q("note") + ":" + Q(note) + "}";
  }
  static string OkJson(bool hasBefore, uint before, bool hasAfter, uint after, bool gated, IntPtr hwnd, uint pid, string note) {
    return "{" + Q("ok") + ":true" +
           "," + Q("affinityBefore") + ":" + (hasBefore ? before.ToString() : "-1") +
           "," + Q("affinityAfter") + ":" + (hasAfter ? after.ToString() : "-1") +
           "," + Q("gated") + ":" + (gated ? "true" : "false") +
           "," + Q("hwnd") + ":" + hwnd.ToInt64() +
           "," + Q("pid") + ":" + pid +
           "," + Q("note") + ":" + Q(note) + "}";
  }

  /** action is on, off or status; hwnd and pid are both optional but one must resolve a process. */
  public static string Run(string action, long hwndValue, uint pidArg) {
    if (action == null) action = "";
    if (action != "on" && action != "off" && action != "status") return Fail("bad_action", 0, "");
    if (IntPtr.Size != 8) return Fail("helper_not_64bit", 0, "the stub is x64 only");
    IntPtr hwnd = new IntPtr(hwndValue);
    uint pid = pidArg;
    if (hwndValue != 0 && pid == 0) GetWindowThreadProcessId(hwnd, out pid);
    if (pid == 0) return Fail("no_target_process", 0, "pass hwnd or pid");
    bool beforeKnown = false;
    uint before = 0;
    if (hwndValue != 0) beforeKnown = GetWindowDisplayAffinity(hwnd, out before);
    if (hwndValue == 0) {
      hwnd = FindWindow(pid);
      if (hwnd != IntPtr.Zero) beforeKnown = GetWindowDisplayAffinity(hwnd, out before);
    }
    IntPtr p = OpenProcess(PROCESS_CREATE_THREAD | PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, false, pid);
    if (p == IntPtr.Zero) {
      int e = Marshal.GetLastWin32Error();
      string note = e == 5 ? "the target is elevated or owned by another user; this caller cannot open it" : "";
      return Fail(e == 5 ? "open_process_denied" : "open_process", e, note);
    }
    try { return Step(action, p, hwnd, pid, beforeKnown, before); }
    catch (Exception ex) { return Fail(ex.GetType().Name, 0, ""); }
    finally { CloseHandle(p); }
  }

  static string Step(string action, IntPtr p, IntPtr hwnd, uint pid, bool beforeKnown, uint before) {
    bool wow = false;
    if (IsWow64Process(p, out wow) && wow) return Fail("target_is_32bit", 0, "this helper is x64; a 32-bit target needs the x86 stub");
    IntPtr export = GetProcAddress(GetModuleHandle("user32.dll"), "SetWindowDisplayAffinity");
    if (export == IntPtr.Zero) return Fail("export_missing", 0, "");
    byte[] head = new byte[6];
    UIntPtr got;
    if (!ReadProcessMemory(p, export, head, (UIntPtr)6, out got) || (int)got != 6)
      return Fail("prologue_unreadable", Marshal.GetLastWin32Error(), "");
    if (head[0] != 0xFF || head[1] != 0x25) return Fail("prologue_not_indirect_jump", 0, "");
    IntPtr slot = new IntPtr(export.ToInt64() + 6 + BitConverter.ToInt32(head, 2));
    if ((slot.ToInt64() & 7) != 0) return Fail("slot_not_aligned", 0, "refusing a non-atomic pointer write");
    byte[] ptr = new byte[8];
    if (!ReadProcessMemory(p, slot, ptr, (UIntPtr)8, out got) || (int)got != 8)
      return Fail("slot_unreadable", Marshal.GetLastWin32Error(), "");
    long current = BitConverter.ToInt64(ptr, 0);
    bool ours = current != 0 && current != export.ToInt64() && LooksLikeStub(p, current);

    if (action == "status") {
      bool on = false;
      if (ours) {
        byte[] swb = new byte[1];
        if (ReadProcessMemory(p, new IntPtr(current + SWITCH_AT), swb, (UIntPtr)1, out got) && (int)got == 1) on = swb[0] == 1;
      }
      return OkJson(beforeKnown, before, beforeKnown, before, on, hwnd, pid, ours ? (on ? "gate_on" : "gate_off") : "nothing_to_turn_off");
    }

    if (action == "off") {
      if (!ours) return Fail("no_gate", 0, "nothing to turn off");
      if (!WriteBytes(p, new IntPtr(current + SWITCH_AT), new byte[] { 0 })) return Fail("switch_write", Marshal.GetLastWin32Error(), "");
      byte[] rb = new byte[1];
      ReadProcessMemory(p, new IntPtr(current + SWITCH_AT), rb, (UIntPtr)1, out got);
      if (rb[0] != 0) return Fail("switch_readback", 0, "");
      uint after = 0;
      bool afterKnown = hwnd != IntPtr.Zero && GetWindowDisplayAffinity(hwnd, out after);
      return OkJson(beforeKnown, before, afterKnown, after, false, hwnd, pid, "switch_off");
    }

    if (hwnd == IntPtr.Zero) return Fail("no_window", 0, "the process has no visible window to clear");
    if (ours) {
      // Already gated: find the existing page from the slot and flip the switch back, then clear once.
      if (!WriteBytes(p, new IntPtr(current + SWITCH_AT), new byte[] { 1 })) return Fail("switch_write", Marshal.GetLastWin32Error(), "");
      byte[] saved = new byte[8];
      if (!ReadProcessMemory(p, new IntPtr(current + ORIGINAL_AT), saved, (UIntPtr)8, out got) || (int)got != 8)
        return Fail("original_unreadable", Marshal.GetLastWin32Error(), "");
      string t = Clear(p, hwnd, BitConverter.ToInt64(saved, 0));
      if (t != "") return Fail(t, 0, "");
      uint now = 0;
      bool nowKnown = GetWindowDisplayAffinity(hwnd, out now);
      if (nowKnown && now != 0) return Fail("clear_failed", 0, "the gate is in place but the flag is still set");
      return OkJson(beforeKnown, before, nowKnown, now, true, hwnd, pid, "gate_was_present");
    }

    IntPtr page = VirtualAllocEx(p, IntPtr.Zero, (UIntPtr)PAGE_SIZE, MEM_COMMIT_RESERVE, PAGE_EXECUTE_READWRITE);
    if (page == IntPtr.Zero) return Fail("alloc_page", Marshal.GetLastWin32Error(), "");
    IntPtr stub = new IntPtr(page.ToInt64() + STUB_AT);
    IntPtr orig = new IntPtr(page.ToInt64() + ORIGINAL_AT);
    IntPtr sw = new IntPtr(page.ToInt64() + SWITCH_AT);
    if (!WriteBytes(p, orig, BitConverter.GetBytes(current)) || !WriteBytes(p, sw, new byte[] { 1 })) {
      VirtualFreeEx(p, page, UIntPtr.Zero, MEM_RELEASE);
      return Fail("page_write", Marshal.GetLastWin32Error(), "");
    }
    byte[] code = Stub(stub.ToInt64(), sw.ToInt64(), orig.ToInt64());
    if (code == null) {
      VirtualFreeEx(p, page, UIntPtr.Zero, MEM_RELEASE);
      return Fail("stub_range", 0, "the saved pointer is more than 2 GB from the stub");
    }
    if (!WriteBytes(p, stub, code) || !WritePointer(p, slot, stub.ToInt64())) {
      VirtualFreeEx(p, page, UIntPtr.Zero, MEM_RELEASE);
      return Fail("install", Marshal.GetLastWin32Error(), "");
    }
    byte[] verify = new byte[8];
    ReadProcessMemory(p, slot, verify, (UIntPtr)8, out got);
    if (BitConverter.ToInt64(verify, 0) != stub.ToInt64()) return Fail("slot_verify", 0, "the write did not take");
    string err = Clear(p, hwnd, current);
    if (err != "") return Fail(err, 0, "the gate is in place but the clear thread failed");
    uint finalAff = 0;
    bool finalKnown = GetWindowDisplayAffinity(hwnd, out finalAff);
    if (finalKnown && finalAff != 0) return Fail("clear_failed", 0, "the slot points at the gate but the flag is still set");
    return OkJson(beforeKnown, before, finalKnown, finalAff, true, hwnd, pid, "gated");
  }

  /** mov al, byte [switch] / test al, al / jz +6 / mov eax, 1 / ret / jmp qword [original]. */
  static byte[] Stub(long at, long sw, long originalSlot) {
    List<byte> c = new List<byte>();
    c.Add(0xA0);
    c.AddRange(BitConverter.GetBytes(sw));
    c.AddRange(new byte[] { 0x84, 0xC0 });
    c.AddRange(new byte[] { 0x74, 0x06 });
    c.AddRange(new byte[] { 0xB8, 0x01, 0x00, 0x00, 0x00 });
    c.Add(0xC3);
    // The last jump stays rip-relative: the slot sits above 4 GB and a disp32 absolute truncates.
    c.AddRange(new byte[] { 0xFF, 0x25 });
    long rel = originalSlot - (at + c.Count + 4);
    if (rel < int.MinValue || rel > int.MaxValue) return null;
    c.AddRange(BitConverter.GetBytes((int)rel));
    return c.ToArray();
  }

  /** mov rcx, hwnd / mov edx, 0 / mov rax, fn / sub rsp,0x28 / call rax / add rsp,0x28 / ret. */
  static byte[] CallCode(long hwnd, long fn) {
    List<byte> c = new List<byte>();
    c.AddRange(new byte[] { 0x48, 0xB9 });
    c.AddRange(BitConverter.GetBytes(hwnd));
    c.AddRange(new byte[] { 0xBA });
    c.AddRange(BitConverter.GetBytes(0));
    c.AddRange(new byte[] { 0x48, 0xB8 });
    c.AddRange(BitConverter.GetBytes(fn));
    c.AddRange(new byte[] { 0x48, 0x83, 0xEC, 0x28 });
    c.AddRange(new byte[] { 0xFF, 0xD0 });
    c.AddRange(new byte[] { 0x48, 0x83, 0xC4, 0x28 });
    c.Add(0xC3);
    return c.ToArray();
  }

  /** Runs the call stub in a remote thread; empty string means it returned. */
  static string Clear(IntPtr p, IntPtr hwnd, long fn) {
    byte[] code = CallCode(hwnd.ToInt64(), fn);
    IntPtr mem = VirtualAllocEx(p, IntPtr.Zero, (UIntPtr)code.Length, MEM_COMMIT_RESERVE, PAGE_EXECUTE_READWRITE);
    if (mem == IntPtr.Zero) return "alloc_thread_code";
    if (!WriteBytes(p, mem, code)) {
      VirtualFreeEx(p, mem, UIntPtr.Zero, MEM_RELEASE);
      return "thread_code_write";
    }
    uint id;
    IntPtr th = CreateRemoteThread(p, IntPtr.Zero, UIntPtr.Zero, mem, IntPtr.Zero, 0, out id);
    if (th == IntPtr.Zero) {
      VirtualFreeEx(p, mem, UIntPtr.Zero, MEM_RELEASE);
      return "create_thread";
    }
    uint waited = WaitForSingleObject(th, 5000);
    CloseHandle(th);
    VirtualFreeEx(p, mem, UIntPtr.Zero, MEM_RELEASE);
    return waited == 0 ? "" : "thread_timeout";
  }

  static bool LooksLikeStub(IntPtr p, long at) {
    byte[] head = new byte[1];
    UIntPtr got;
    if (!ReadProcessMemory(p, new IntPtr(at), head, (UIntPtr)1, out got) || (int)got != 1) return false;
    return head[0] == 0xA0;
  }

  /** Engages or releases the gate for one window; empty error means it worked. */
  public static bool Ensure(long hwndValue, bool on, out string error) {
    error = "";
    if (IntPtr.Size != 8) { error = "helper_not_64bit"; return false; }
    IntPtr hwnd = new IntPtr(hwndValue);
    uint pid = 0;
    if (hwndValue != 0) GetWindowThreadProcessId(hwnd, out pid);
    if (pid == 0) { error = "no_target_process"; return false; }
    IntPtr p = OpenProcess(PROCESS_CREATE_THREAD | PROCESS_VM_OPERATION | PROCESS_VM_WRITE | PROCESS_VM_READ | PROCESS_QUERY_INFORMATION, false, pid);
    if (p == IntPtr.Zero) { error = "open_process win32=" + Marshal.GetLastWin32Error(); return false; }
    try {
      uint before = 0;
      bool beforeKnown = GetWindowDisplayAffinity(hwnd, out before);
      string r = Step(on ? "on" : "off", p, hwnd, pid, beforeKnown, before);
      if (r.IndexOf("\\\"ok\\\":true") < 0) { error = r; return false; }
      return true;
    } catch (Exception ex) { error = ex.GetType().Name; return false; }
    finally { CloseHandle(p); }
  }
  static bool WriteBytes(IntPtr p, IntPtr at, byte[] bytes) {
    UIntPtr written;
    return WriteProcessMemory(p, at, bytes, (UIntPtr)bytes.Length, out written) && (int)written == bytes.Length;
  }

  static bool WritePointer(IntPtr p, IntPtr slot, long value) {
    uint old;
    if (!VirtualProtectEx(p, slot, (UIntPtr)8, PAGE_READWRITE, out old)) return false;
    bool ok = WriteBytes(p, slot, BitConverter.GetBytes(value));
    uint ignored;
    VirtualProtectEx(p, slot, (UIntPtr)8, old, out ignored);
    return ok;
  }

  static IntPtr FindWindow(uint pid) {
    IntPtr found = IntPtr.Zero;
    EnumWindows(delegate(IntPtr h, IntPtr x) {
      if (!IsWindowVisible(h)) return true;
      uint other;
      GetWindowThreadProcessId(h, out other);
      if (other != pid) return true;
      StringBuilder t = new StringBuilder(256);
      if (GetWindowText(h, t, t.Capacity) <= 0) return true;
      found = h;
      return false;
    }, IntPtr.Zero);
    return found;
  }
}
'@
[RHD]::DpiAware()
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
  if ($op -eq 'protected') {
    try { [Console]::Out.WriteLine((@{id=$cmd.id; ok=$true; blocked=[RHD]::BlockedWindow()} | ConvertTo-Json -Compress)) }
    catch { [Console]::Out.WriteLine((@{id=$cmd.id; ok=$false; error=$_.Exception.Message} | ConvertTo-Json -Compress)) }
    continue
  }
  if ($op -eq 'fullscreen') {
    try {
      $f = [RHD]::Fullscreen()
      [Console]::Out.WriteLine((@{id=$cmd.id; ok=$true; state=[int]$f[0]; d3d=($f[1] -eq 'true'); pid=[int]$f[2]; w=[int]$f[3]; h=[int]$f[4]; title=$f[5]} | ConvertTo-Json -Compress))
    }
    catch { [Console]::Out.WriteLine((@{id=$cmd.id; ok=$false; error=$_.Exception.Message} | ConvertTo-Json -Compress)) }
    continue
  }
  if ($op -eq 'probe') {
    try { [Console]::Out.WriteLine(('{"id":' + $cmd.id + ',"ok":true,' + [RHD]::ProbeJson().Substring(1))) }
    catch { [Console]::Out.WriteLine((@{id=$cmd.id; ok=$false; error=$_.Exception.Message} | ConvertTo-Json -Compress)) }
    continue
  }
  if ($op -eq 'gate') {
    try {
      $h = [long]0
      if ($null -ne $cmd.hwnd) { $h = [long]$cmd.hwnd }
      $tg = [uint32]0
      if ($null -ne $cmd.pid) { $tg = [uint32]$cmd.pid }
      [Console]::Out.WriteLine(('{"id":' + $cmd.id + ',' + [RHGate]::Run([string]$cmd.action, $h, $tg).Substring(1)))
    }
    catch { [Console]::Out.WriteLine((@{id=$cmd.id; ok=$false; error=$_.Exception.Message; win32=0} | ConvertTo-Json -Compress)) }
    continue
  }
  if ($op -eq 'shot') {
    try {
      $h = [long]0
      if ($null -ne $cmd.hwnd) { $h = [long]$cmd.hwnd }
      [Console]::Out.WriteLine(('{"id":' + $cmd.id + ',' + [RHD]::ShotJson([string]$cmd.mode, $h).Substring(1)))
    }
    catch { [Console]::Out.WriteLine((@{id=$cmd.id; ok=$false; error=$_.Exception.Message} | ConvertTo-Json -Compress)) }
    continue
  }
  if ($op -eq 'check') {
    try {
      $h = [long]0
      if ($null -ne $cmd.hwnd) { $h = [long]$cmd.hwnd }
      [Console]::Out.WriteLine(('{"id":' + $cmd.id + ',' + [RHD]::CheckJson($h).Substring(1)))
    }
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
      [Console]::Out.WriteLine((@{id=$cmd.id; ok=$true; w=$w; h=$h; blocked=[RHD]::BlockedWindow(); b64=$b64} | ConvertTo-Json -Compress))
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
const CLIP_SCRIPT =
  COMMON_PRELUDE +
  `
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
    this.stderrTail = ""; // the last thing the helper said on stderr (a compile error, usually)
    this.failed = ""; // why it never answered, once one ping loop has failed
  }

  /** @type {((obj: any) => void) | null} */
  onEvent = null;

  /** Write the script to a private .ps1 once (AV-deterministic, no quoting issues). */
  ensureFile() {
    if (this.file) {
      try {
        fs.accessSync(this.file);
        return this.file;
      } catch {
        /* rewrite below */
      }
    }
    fs.mkdirSync(path.join(configDir, "helpers"), { recursive: true, mode: 0o700 });
    this.file = path.join(configDir, "helpers", `${this.name}.ps1`);
    fs.writeFileSync(this.file, this.script, { encoding: "utf8" });
    return this.file;
  }

  /** Spawn the helper process. Overridden per platform (PowerShell on Windows). */
  _launch() {
    const file = this.ensureFile();
    return spawn(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", file],
      {
        windowsHide: true,
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
  }

  async ensure() {
    if (this.proc && this.proc.exitCode === null) return;
    if (this.starting) return this.starting;
    this.starting = (async () => {
      // A helper that cannot start (no swiftc, a failed compile) leaves cmd() answering helper_not_running.
      try {
        this.proc = this._launch();
      } catch {
        this.proc = null;
        return;
      }
      this.buf = "";
      this.stderrTail = "";
      this.failed = "";
      this.proc.stdout.setEncoding("utf8");
      this.proc.stdout.on("data", (d) => {
        this.buf += d;
        let nl;
        while ((nl = this.buf.indexOf("\n")) >= 0) {
          const line = this.buf.slice(0, nl).trim();
          this.buf = this.buf.slice(nl + 1);
          if (!line) continue;
          let obj;
          try {
            obj = JSON.parse(line);
          } catch {
            continue;
          }
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
      // Never swallowed: when Add-Type fails, this is the only explanation the user gets.
      this.proc.stderr.setEncoding("utf8");
      this.proc.stderr.on("data", (d) => {
        this.stderrTail = (this.stderrTail + d).slice(-4000);
      });
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
      // It never answered: remember why, and do not leave a half-dead process behind.
      this.failed = (
        this.stderrTail.trim().split(/\r?\n/).filter(Boolean).slice(-3).join(" ") ||
        "the helper did not start"
      ).slice(0, 400);
      if (this.proc)
        try {
          this.proc.kill();
        } catch {
          /* already gone */
        }
      this.proc = null;
    })();
    try {
      await this.starting;
    } finally {
      this.starting = null;
    }
  }

  cmd(obj, timeoutMs = 15000) {
    if (!this.proc || this.proc.exitCode !== null) {
      const detail = this.failed || this.stderrTail.trim().slice(-400);
      return Promise.resolve({ ok: false, error: "helper_not_running", ...(detail ? { detail } : {}) });
    }
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
      try {
        this.proc.kill();
      } catch {
        /* already gone */
      }
      this.proc = null;
    }
    if (this.file) {
      try {
        fs.unlinkSync(this.file);
      } catch {
        /* best effort */
      }
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
    const binExists = () => {
      try {
        fs.accessSync(this.bin);
        return true;
      } catch {
        return false;
      }
    };
    const stale = () => {
      try {
        return fs.statSync(this.bin).mtimeMs < fs.statSync(src).mtimeMs;
      } catch {
        return true;
      }
    };
    // An upgrade brings new source while the old binary is newer than the old source on disk.
    let changed = true;
    try {
      changed = fs.readFileSync(src, "utf8") !== this.script;
    } catch {
      /* first run */
    }
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
      execFileSync("swiftc", ["-O", "-target", target, src, "-o", this.bin + ".tmp"], {
        stdio: ["ignore", "ignore", "pipe"],
        timeout: 120000,
      });
      fs.renameSync(this.bin + ".tmp", this.bin);
      this._compileFailedAt = 0;
    } catch (e) {
      this._compileFailedAt = Date.now();
      console.warn(
        `[desktop] ${this.name} helper failed to compile: ${String(e.stderr || e.message).slice(-1500)}`,
      );
      throw e;
    }
    return this.bin;
  }

  _launch() {
    return spawn(this.ensureFile(), [], { stdio: ["pipe", "pipe", "pipe"] });
  }

  kill() {
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        /* gone */
      }
      this.proc = null;
    }
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
    try {
      bin = this.helper.ensureFile();
    } catch {
      return null;
    }
    const p = opts.preset;
    const args = [
      "stream",
      "--display",
      String(opts.monitor?.output ?? -1),
      "--codec",
      codec,
      "--fps",
      String(p.fps),
      "--bitrate",
      String(Math.round(parseRate(p.maxrate))),
      "--scale",
      String(p.scale),
    ];
    if (opts.audio) args.push("--audio");
    let proc;
    try {
      proc = spawn(bin, args, { stdio: ["pipe", "pipe", "pipe"] });
    } catch {
      return null;
    }
    this.proc = proc;
    const reader = new FrameReaderLocal();
    proc.stdout.on("data", (chunk) => {
      for (const rec of reader.push(chunk)) onRecord({ kind: rec.kind, data: rec.data, codec });
    });
    let err = "";
    proc.stderr.on("data", (d) => {
      err = (err + d).slice(-400);
    });
    const ended = new Promise((resolve) => {
      proc.once("exit", () => {
        if (this.proc === proc) {
          this.proc = null;
          onEnd?.();
        }
        resolve();
      });
      proc.once("error", () => resolve());
    });
    // Resolve once the first video record arrives (capture is working), or null if it dies first.
    const ready = new Promise((resolve) => {
      let done = false;
      const onFirst = (_chunk) => {
        if (done) return;
        done = true;
        proc.stdout.off("data", onFirst);
        resolve({ encoder: `videotoolbox_${codec}`, codec });
      };
      proc.stdout.on("data", onFirst);
      ended.then(() => {
        if (!done) {
          done = true;
          resolve(null);
        }
      });
    });
    return ready;
  }

  stop() {
    if (this.proc) {
      try {
        this.proc.kill();
      } catch {
        /* gone */
      }
      this.proc = null;
    }
  }
}

/** Kept local so this file needs no import from desktop_video (which imports from here). */
class FrameReaderLocal {
  constructor() {
    this.buf = Buffer.alloc(0);
  }

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

export class DesktopController extends InputController {
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
    this.helperCapture = IS_MAC
      ? new MacHelper("pdcap", MAC_CAP_SWIFT)
      : new PsHelper("capture", CAPTURE_SCRIPT);
    this.helperClip = new PsHelper("clipboard", CLIP_SCRIPT);
    // macOS streams video through the same helper binary; DesktopVideo drives it.
    this.macVideo = IS_MAC ? new MacVideoNative(this.helperCapture) : null;
    // Linux drives input and monitors through xdotool/xrandr and video through ffmpeg x11grab, or on a
    // wlroots Wayland session through its own tools and wf-recorder.
    this.linux = IS_LINUX ? (IS_WAYLAND ? new WaylandDesktop() : new LinuxDesktop()) : null;
    this.origin = { x: 0, y: 0 };
    this.monitorList = null;
    this.blocked = ""; // focused window that excludes itself from capture
    this.captureModeId = "auto"; // rung order the phone asked for
    this.captureAllowed = false;
    this.protectedTimer = null;
  }

  /** True when this host can do real desktop control now (a Linux box needs xdotool). */
  get usable() {
    return IS_WIN || IS_MAC || !!this.linux?.supported;
  }

  /** Stream frames for `clientId` (server keeps the ws mapping). */
  async startFrameStream(clientId, quality) {
    if (!IS_WIN && !IS_MAC) return { ok: false, reason: "unsupported_platform" };
    if (quality) this.quality = clampQuality(quality);
    this.clients.add(clientId);
    this._ensureLoop();
    // Honest start: a viewer must not be told the stream is live before a frame exists, or a helper
    // that cannot capture leaves a black window with no reason. The first frame or failure decides.
    if (!this.lastFrame) {
      const first = await new Promise((resolve) => {
        const done = (r) => {
          clearTimeout(timer);
          this.off("frame", onFrame);
          resolve(r);
        };
        const onFrame = () => done({ ok: true });
        const timer = setTimeout(
          () =>
            done({
              ok: false,
              reason: inputError(this._lastCaptureError || "capture_timeout", this._lastCaptureDetail),
            }),
          6000,
        );
        this.once("frame", onFrame);
      });
      if (!first.ok) {
        this.clients.delete(clientId);
        if (!this.clients.size) this._stopLoop();
        return first;
      }
    }
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
    this.quality = clampQuality(quality);
    return { ok: true, quality: this.quality };
  }

  /** Latest frame, capturing one first if we have none yet. */
  async getFrame() {
    if (!IS_WIN && !IS_MAC) return { ok: false, reason: "unsupported_platform" };
    if (!this.lastFrame) {
      // captureOnce is a no-op while the stream loop has one in flight, so
      // wait for that frame rather than reporting a failure that never was.
      if (this.capturing) await this._nextFrame(15000);
      else if (IS_WIN && (await this._tryDXGI())) {
        /* frame set from DXGI */
      } else await this.captureOnce();
      if (!this.lastFrame)
        return { ok: false, reason: inputError(this._lastCaptureError) || "capture_failed" };
    }
    return { ok: true, ...this.lastFrame };
  }

  /** Snapshot via DXGI Desktop Duplication (captures exclusive fullscreen games that
   *  GDI CopyFromScreen misses). Returns true when it produced a frame. */
  async _tryDXGI() {
    const t0 = Date.now();
    const dxgi = await captureFrameDXGI(this.quality);
    if (dxgi?.ok && dxgi.b64) {
      this._setFrame(dxgi.b64, dxgi.width, dxgi.height, t0);
      return true;
    }
    this._lastCaptureError = dxgi?.error || "dxgi_failed";
    return false;
  }

  _nextFrame(timeoutMs) {
    return new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        this.off("frame", done);
        resolve();
      };
      const timer = setTimeout(done, timeoutMs);
      this.once("frame", done);
    });
  }

  _ensureLoop() {
    if (this.captureTimer || (!IS_WIN && !IS_MAC)) return;
    this.captureOnce();
    // The still-frame fallback used to sit at ~3 fps. A warm PowerShell capture costs ~80-150 ms,
    // so 150 ms keeps the picture usable without letting a slow capture queue up (capturing guard).
    this.captureTimer = setInterval(() => {
      if (!this.capturing) this.captureOnce();
    }, 150);
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
        this._setFrame(r.b64, r.w, r.h, t0, r.blocked || "");
      } else {
        this.stats.capturesFailed++;
        const error = r?.error || "capture_failed";
        if (error !== this._lastCaptureError) this.emit("capture_error", inputError(error, r?.detail));
        this._lastCaptureError = error;
        this._lastCaptureDetail = r?.detail || "";
        if (error === "screen_permission") {
          // Show the system prompt once; macOS applies a new grant only to a fresh process, so restart now and then.
          if (!this._permRequested) {
            this._permRequested = true;
            this.requestPermissions().catch(() => {});
          } else if (Date.now() - (this._permRestartAt || 0) > 10_000) {
            this._permRestartAt = Date.now();
            this.helperCapture.kill();
          }
        }
      }
    } catch {
      this.stats.capturesFailed++;
    } finally {
      this.capturing = false;
    }
  }

  /** Set lastFrame from a captured result, updating stats and emitting "frame". */
  _setFrame(b64, width, height, t0, blocked) {
    this.stats.lastCaptureMs = Date.now() - t0;
    this.lastFrame = { base64: b64, width, height, ts: Date.now(), seq: ++this.frameSeq };
    this.stats.framesSent++;
    this._lastCaptureError = null;
    this._lastCaptureDetail = "";
    if (blocked !== undefined) this._noteBlocked(blocked);
    this.emit("frame", this.lastFrame);
  }

  /** Remember which focused window blocks capture, and tell watchers when it changes. */
  _noteBlocked(title) {
    const t = String(title || "");
    if (t === this.blocked) return;
    this.blocked = t;
    this.emit("capture_blocked", t);
  }

  /**
   * While a desktop viewer is attached, drop a marker file an alpha build of a
   * capture-restricted app can look for. The window's own process is the only one
   * allowed to clear WDA_EXCLUDEFROMCAPTURE, so this is the documented handshake:
   * present = PocketDesk is mirroring, clear the flag; gone = restore it.
   */
  setCaptureAllowed(on) {
    if (!IS_WIN) return;
    // The elevated task does not always inherit LOCALAPPDATA, and the marker has to land in the user's
    // own profile: that is the path the alpha app polls. USERPROFILE is always there.
    const base =
      process.env.LOCALAPPDATA ||
      (process.env.USERPROFILE ? path.join(process.env.USERPROFILE, "AppData", "Local") : "");
    if (!base) {
      if (!this._markerWarned) {
        this._markerWarned = true;
        console.warn(
          "[pocketdesk] no LOCALAPPDATA or USERPROFILE: the alpha capture marker cannot be written",
        );
      }
      return;
    }
    const dir = path.join(base, "PocketDesk");
    const flag = path.join(dir, "allow-capture");
    try {
      if (on) {
        fs.mkdirSync(dir, { recursive: true });
        if (!fs.existsSync(flag))
          fs.writeFileSync(flag, JSON.stringify({ app: "PocketDesk", at: new Date().toISOString() }) + "\n");
      } else {
        try {
          fs.unlinkSync(flag);
        } catch {
          /* already gone */
        }
      }
    } catch {
      /* best effort; the app simply keeps its protection */
    }
    this.captureAllowed = !!on;
  }

  /** Poll the focused window's display affinity while anyone watches (video mode included). */
  watchProtected(on) {
    if (!on || !IS_WIN) {
      clearInterval(this.protectedTimer);
      this.protectedTimer = null;
      return;
    }
    if (this.protectedTimer) return;
    const check = async () => {
      try {
        await this.helperCapture.ensure();
        const r = await this.helperCapture.cmd({ op: "protected" }, 3000);
        if (r?.ok) this._noteBlocked(r.blocked || "");
      } catch {
        /* helper restarting */
      }
    };
    check();
    this.protectedTimer = setInterval(check, 2000);
  }

  /** The focused window right now if it excludes itself from capture. */
  async protectedNow() {
    if (!IS_WIN) return { ok: true, blocked: "" };
    try {
      await this.helperCapture.ensure();
      const r = await this.helperCapture.cmd({ op: "protected" }, 3000);
      if (r?.ok) this._noteBlocked(r.blocked || "");
      return { ok: !!r?.ok, blocked: r?.blocked || "" };
    } catch (e) {
      return { ok: false, error: e.message, blocked: "" };
    }
  }

  /**
   * The focused window's fullscreen state: { d3d } is true while a D3D app owns the display outside
   * DWM (true exclusive fullscreen), which every user-mode capture API returns black for.
   */
  async fullscreenNow() {
    if (!IS_WIN) return { ok: true, d3d: false, state: 0, title: "" };
    try {
      await this.helperCapture.ensure();
      const r = await this.helperCapture.cmd({ op: "fullscreen" }, 3000);
      return {
        ok: !!r?.ok,
        d3d: r?.d3d === true,
        state: r?.state ?? 0,
        title: r?.title || "",
        pid: r?.pid || 0,
        w: r?.w || 0,
        h: r?.h || 0,
      };
    } catch (e) {
      return { ok: false, d3d: false, state: 0, title: "", error: e.message };
    }
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
      const monitors = list.map((m, index) => ({
        index,
        adapter: 0,
        output: index,
        name: m.name,
        x: m.x,
        y: m.y,
        w: m.w,
        h: m.h,
        primary: !!m.primary,
      }));
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
      index,
      adapter: m.adapter,
      output: m.output,
      name: m.name,
      x: m.left - ox,
      y: m.top - oy,
      w: m.w,
      h: m.h,
      primary: m.primary ?? (m.left === 0 && m.top === 0),
    }));
    // An extended desktop is several outputs side by side, and ddagrab only ever grabs one of them.
    // The whole desktop is listed first, as one picture, so a viewer sees both screens as they are and
    // picks a single screen only when it wants one. A one-screen PC gets no extra entry (same picture).
    if (monitors.length > 1) {
      const w = Math.max(...monitors.map((m) => m.x + m.w));
      const h = Math.max(...monitors.map((m) => m.y + m.h));
      monitors.unshift({
        index: 0,
        adapter: 0,
        output: 0,
        all: true,
        name: "All screens",
        x: 0,
        y: 0,
        w,
        h,
        primary: false,
      });
      monitors.forEach((m, i) => {
        m.index = i;
      });
    }
    // The Swift helper takes and reports global points, which start at the main display, not the top-left one.
    this.origin = IS_MAC ? { x: ox, y: oy } : { x: 0, y: 0 };
    this.monitorList = monitors;
    return { ok: true, monitors };
  }

  /** The monitor holding the foreground window, so a game on a second screen can be mirrored
   *  without the viewer picking it. Null when unknown (off Windows, no monitors listed, no rect). */
  async foregroundMonitor() {
    if (!IS_WIN) return null;
    if (!this.monitorList) return null;
    const rect = foregroundRect();
    if (!rect) return null;
    const cx = (rect.left + rect.right) / 2 - this.origin.x;
    const cy = (rect.top + rect.bottom) / 2 - this.origin.y;
    // The all-screens entry covers every point, so it would always match first; a real screen is wanted.
    return (
      this.monitorList.find((m) => !m.all && cx >= m.x && cx < m.x + m.w && cy >= m.y && cy < m.y + m.h) ||
      null
    );
  }

  /** macOS Screen-Recording / Accessibility grants; { ok:false } off macOS or without the helper. */
  async permissions() {
    if (!IS_MAC)
      return { ok: false, screen: IS_WIN || !!this.linux, accessibility: IS_WIN || !!this.linux?.supported };
    await this.helperCapture.ensure();
    return this.helperCapture.cmd({ op: "perms" }, 8000);
  }

  /** Trigger the macOS permission prompts (first run); returns the resulting grant state. */
  async requestPermissions() {
    if (!IS_MAC) return { ok: false };
    await this.helperCapture.ensure();
    return this.helperCapture.cmd({ op: "request" }, 8000);
  }

  /** The window the phone means: an explicit hwnd, else a protected one, else the foreground. */
  async captureTarget(msg = {}) {
    if (!IS_WIN) return null;
    await this.helperCapture.ensure();
    const probe = await this.helperCapture.cmd({ op: "probe" }, 20000);
    if (!probe?.ok) return null;
    const wins = probe.windows || [];
    if (msg.hwnd) return wins.find((w) => w.hwnd === Number(msg.hwnd)) || null;
    if (probe.foreground && probe.foreground.affinity !== "none (0)") return probe.foreground;
    return wins.find((w) => w.affinity !== "none (0)") || probe.foreground || wins[0] || null;
  }

  /** The monitor holding the window centre, for the DXGI output index and pixel origin. */
  async monitorFor(win) {
    try {
      const r = await this.helperCapture.cmd({ op: "monitors" }, 8000);
      const list = r?.ok ? r.monitors || [] : [];
      const cx = win.x + win.w / 2;
      const cy = win.y + win.h / 2;
      return (
        list.find((m) => cx >= m.left && cx < m.left + m.w && cy >= m.top && cy < m.top + m.h) ||
        list[0] ||
        null
      );
    } catch {
      return null;
    }
  }

  /** A DXGI frame cropped to the window rectangle, or null when the output cannot be read. */
  async dxgiCrop(win) {
    const mon = await this.monitorFor(win);
    if (!mon) return null;
    const x = Math.max(0, win.x - mon.left);
    const y = Math.max(0, win.y - mon.top);
    const w = Math.min(win.w, mon.w - x) & ~1;
    const h = Math.min(win.h, mon.h - y) & ~1;
    if (w < 2 || h < 2) return null;
    const r = await captureFrameDXGIRaw(mon.output, { x, y, w, h });
    return r.ok ? { frame: r.frame, w, h } : null;
  }

  /** One rung, measured. A uniform frame is a refusal, not a picture. */
  async shotMode(mode, win) {
    if (!IS_WIN) return { ok: false, cause: "no_window" };
    if (!win) return { ok: false, cause: "no_window" };
    if (mode === "printwindow" || mode === "screen") {
      const r = await this.helperCapture.cmd({ op: "shot", mode, hwnd: win.hwnd }, 20000);
      if (!r?.ok) return { ok: false, cause: r?.cause || "capture_empty" };
      return {
        ok: r.colours > 2,
        mode,
        w: r.w,
        h: r.h,
        colours: r.colours,
        luminance: r.luminance,
        uniform: !!r.uniform,
        cause: r.colours > 2 ? "" : "uniform",
      };
    }
    if (mode === "dxgi") {
      const c = await this.dxgiCrop(win);
      if (!c) return { ok: false, cause: "exclusive_fullscreen" };
      const m = measureBgra(c.frame, c.w, c.h);
      return {
        ok: m.colours > 2,
        mode,
        w: c.w,
        h: c.h,
        colours: m.colours,
        luminance: m.luminance,
        uniform: m.colours <= 2,
        cause: m.colours > 2 ? "" : "uniform",
      };
    }
    if (mode === "fullscreen") {
      const f = await this.fullscreenNow();
      return {
        ok: false,
        mode,
        cause: f?.d3d ? "exclusive_fullscreen" : "no_window",
        d3d: !!f?.d3d,
      };
    }
    return { ok: false, cause: "unknown" };
  }

  /** The phone's list/set: no mode lists the rungs, a mode walks the ladder and remembers the pick. */
  async captureMode(msg = {}) {
    if (!IS_WIN) return { type: "desktop_capture", ok: false, error: "unsupported_platform" };
    const requested = msg.mode ? String(msg.mode) : "";
    if (!requested)
      return {
        type: "desktop_capture",
        ok: true,
        current: this.captureModeId,
        modes: describeModes(this.captureModeId),
      };
    let order;
    try {
      order = orderFor(requested);
    } catch (e) {
      return {
        type: "desktop_capture",
        ok: false,
        error: "unknown_mode",
        mode: requested,
        cause: classifyCause("unknown", e.message),
      };
    }
    const win = await this.captureTarget(msg);
    if (!win)
      return {
        type: "desktop_capture",
        ok: false,
        error: "no_window",
        mode: requested,
        attempts: [],
        cause: classifyCause("no_window"),
      };
    const attempts = [];
    for (const mode of order) {
      const r = await this.shotMode(mode, win);
      attempts.push({ mode, ok: r.ok, why: r.ok ? "readable" : r.cause || "failed" });
      if (r.ok) {
        this.captureModeId = requested;
        return {
          type: "desktop_capture",
          ok: true,
          mode,
          requested,
          current: this.captureModeId,
          window: { hwnd: win.hwnd, title: win.title, pid: win.pid },
          frame: { w: r.w, h: r.h, colours: r.colours, luminance: r.luminance },
          attempts,
        };
      }
    }
    const last = attempts[attempts.length - 1] || { why: "unknown" };
    const detail =
      last.why === "uniform" ? "the window returned a uniform frame; engage the gate, then try again" : "";
    return {
      type: "desktop_capture",
      ok: false,
      error: last.why,
      requested,
      window: { hwnd: win.hwnd, title: win.title, pid: win.pid },
      attempts,
      cause: classifyCause(last.why === "uniform" ? "unknown" : last.why, detail),
    };
  }

  /** The check: control, gate, gated, off, reverse, measured against the window's own render. */
  async checkCapture(msg = {}) {
    if (!IS_WIN) return { type: "desktop_capture_check", ok: false, error: "unsupported_platform" };
    const win = await this.captureTarget(msg);
    if (!win)
      return {
        type: "desktop_capture_check",
        ok: false,
        error: "no_window",
        cause: classifyCause("no_window"),
      };
    await this.helperCapture.ensure();
    const r = await this.helperCapture.cmd({ op: "check", hwnd: win.hwnd }, 60000);
    if (!r?.ok)
      return {
        type: "desktop_capture_check",
        ok: false,
        error: r?.error || "check_failed",
        window: { hwnd: win.hwnd, title: win.title, pid: win.pid },
        cause: classifyCause(r?.cause || "unknown", r?.detail),
      };
    const numbers = {
      controlPct: r.controlPct,
      gatedPct: r.gatedPct,
      reversePct: r.reversePct,
      width: r.w,
      height: r.h,
      expectedWidth: win.w,
      expectedHeight: win.h,
    };
    const v = verdict(numbers);
    return {
      type: "desktop_capture_check",
      ok: v.ok,
      route: r.route,
      reference: r.reference,
      window: { hwnd: win.hwnd, title: win.title, pid: win.pid },
      numbers,
      verdict: v,
    };
  }
  getStatus() {
    return {
      supported: this.usable,
      elevated: IS_WIN ? isElevated() : null,
      blocked: this.blocked,
      captureAllowed: this.captureAllowed,
      streaming: !!this.captureTimer,
      clients: this.clients.size,
      quality: this.quality,
      frames: this.frameSeq,
      lastFrame: this.lastFrame
        ? { width: this.lastFrame.width, height: this.lastFrame.height, ts: this.lastFrame.ts }
        : null,
      ...this.stats,
    };
  }

  dispose() {
    this.watchCursor(false);
    this.watchClipboard(false);
    this.watchProtected(false);
    this.setCaptureAllowed(false);
    this._stopLoop();
    this.clients.clear();
    this.helperInput.kill();
    this.helperCapture.kill();
    this.helperClip.kill();
  }
}

/** The phone's two capture cases: list or set a mode, and run the gate check. */
export function handleCaptureMode(desktop, msg = {}) {
  if (msg.type === "desktop_capture_check") return desktop.checkCapture(msg);
  return desktop.captureMode(msg);
}
