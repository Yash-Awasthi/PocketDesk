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
 * of a 1-2s process spawn. Scripts are written to temp .ps1 files once and
 * run with -ExecutionPolicy Bypass -File (deterministic quoting).
 *
 * Capture runs on a ~300ms loop ONLY while at least one rd client is
 * attached; zero clients → loop fully stops. Non-Windows degrades cleanly
 * ({ ok:false, reason:"unsupported_platform" }), like tmux on Windows.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
// fs/os/path still used: helper scripts are written to temp .ps1 files once
// (deterministic for AV scanners, no shell-quoting issues).

const IS_WIN = process.platform === "win32";
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** JSON-safe, ASCII-only wire line (PS 5.1 stdin is happiest with ASCII). */
function wireLine(obj) {
  return JSON.stringify(obj).replace(/[\u0080-\uFFFF]/g, (c) => "\\u" + c.charCodeAt(0).toString(16).padStart(4, "0")) + "\n";
}

const COMMON_PRELUDE = `
$ErrorActionPreference = 'Stop'
`;

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
                    KEYDOWN=0x0000, KEYUP=0x0002, UNICODE=0x0004;
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
  public static uint KeyScan(ushort scan, uint flags) {
    var i = new INPUT { type = 1 };
    i.u.ki = new KEYBDINPUT { wVk = 0, wScan = scan, dwFlags = flags };
    return SendInput(1, new INPUT[]{ i }, Marshal.SizeOf(typeof(INPUT)));
  }
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
  if ($op -eq 'mouse') {
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
      if ($cmd.press -eq 'down')  { [RHI]::Mouse(0,0,[RHI]::LEFTDOWN,0) | Out-Null }
      if ($cmd.press -eq 'up')    { [RHI]::Mouse(0,0,[RHI]::LEFTUP,0) | Out-Null }
      if ($cmd.wheel) { [RHI]::Mouse(0,0,[RHI]::WHEEL,[int]$cmd.wheel) | Out-Null }
      [Console]::Out.WriteLine('{"id":' + $cmd.id + ',"ok":true}')
    } catch { [Console]::Out.WriteLine((@{id=$cmd.id; ok=$false; error=$_.Exception.Message} | ConvertTo-Json -Compress)) }
    continue
  }
  if ($op -eq 'key') {
    try {
      $vk = [uint16]$cmd.key
      $mods = @($cmd.mods)
      if ($mods -contains 'ctrl')  { [RHI]::Key(0x11, [RHI]::KEYDOWN) | Out-Null }
      if ($mods -contains 'alt')   { [RHI]::Key(0x12, [RHI]::KEYDOWN) | Out-Null }
      if ($mods -contains 'shift') { [RHI]::Key(0x10, [RHI]::KEYDOWN) | Out-Null }
      [RHI]::Key($vk, [RHI]::KEYDOWN) | Out-Null
      [RHI]::Key($vk, [RHI]::KEYUP) | Out-Null
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
public static class RHD {
  [DllImport("user32.dll")] public static extern bool SetProcessDPIAware();
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
  if ($op -eq 'capture') {
    try {
      $vs = [System.Windows.Forms.SystemInformation]::VirtualScreen
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

/** Persistent PowerShell helper with id-matched request/reply. */
class PsHelper {
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

  /** Write the script to a temp .ps1 once (AV-deterministic, no quoting issues). */
  ensureFile() {
    if (this.file) {
      try {
        fs.accessSync(this.file);
        return this.file;
      } catch { /* rewrite below */ }
    }
    this.file = path.join(os.tmpdir(), `pocketdesk-${this.name}.ps1`);
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
        for (const [, w] of [...this.waiters.values()]) {
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

  /** x/y: virtual-screen pixels from its top-left (omit to act at the cursor); click: left|right|middle|double; press: down|up. */
  async inputMouse({ x, y, click, press, wheel }) {
    if (!IS_WIN) return { ok: false, reason: "unsupported_platform" };
    await this.helperInput.ensure();
    const r = await this.helperInput.cmd({ op: "mouse", x, y, click, press, wheel }, 8000);
    return { ok: !!r?.ok, error: r?.error };
  }

  async inputKey({ key, modifiers = [] }) {
    if (!IS_WIN) return { ok: false, reason: "unsupported_platform" };
    const vk = Number(key);
    if (!Number.isFinite(vk) || vk <= 0 || vk > 254) return { ok: false, error: "bad_vk" };
    await this.helperInput.ensure();
    const r = await this.helperInput.cmd({ op: "key", key: vk, mods: Array.isArray(modifiers) ? modifiers : [] }, 8000);
    return { ok: !!r?.ok, error: r?.error };
  }

  async inputType(text) {
    if (!IS_WIN) return { ok: false, reason: "unsupported_platform" };
    await this.helperInput.ensure();
    const r = await this.helperInput.cmd({ op: "type", text: String(text).slice(0, 512) }, 10000);
    return { ok: !!r?.ok, error: r?.error };
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
    this._stopLoop();
    this.clients.clear();
    this.helperInput.kill();
    this.helperCapture.kill();
  }
}
