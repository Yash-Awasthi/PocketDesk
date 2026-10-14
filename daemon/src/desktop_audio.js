/**
 * PC sound for desktop viewers: what the speakers play, as AAC-LC ADTS frames ("audio" events).
 * Windows: a WASAPI loopback helper hands raw samples to ffmpeg. Linux: ffmpeg reads the default
 * output's PipeWire/PulseAudio monitor. macOS: the native video helper captures sound itself.
 */
import { spawn, execFileSync } from "node:child_process";
import { EventEmitter } from "node:events";
import { PsHelper } from "./desktop_capture.js";

/** The PulseAudio/PipeWire monitor source for the current output, so capture is what the speakers play. */
export function pulseMonitorSource(run = (c, a) => execFileSync(c, a, { encoding: "utf8", timeout: 3000 })) {
  try {
    const sink = run("pactl", ["get-default-sink"]).trim();
    if (sink) return sink + ".monitor";
  } catch { /* pactl missing or no sink */ }
  return "default";
}

// Loopback capture of the default output, in its own process: the first stderr line is the
// sample format as JSON, then raw samples go to stdout. Silent stretches send nothing at all.
const LOOPBACK_SCRIPT = `
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Threading;
public static class RHA {
  [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator {}
  [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDeviceEnumerator { int EnumAudioEndpoints(int flow, int mask, out IntPtr devices); int GetDefaultAudioEndpoint(int flow, int role, out IMMDevice device); }
  [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IMMDevice { int Activate(ref Guid iid, int ctx, IntPtr p, [MarshalAs(UnmanagedType.IUnknown)] out object o); }
  [ComImport, Guid("1CB9AD4C-DBFA-4c32-B178-C2F568A703B2"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioClient {
    int Initialize(int shareMode, int flags, long bufferDuration, long periodicity, IntPtr format, IntPtr session);
    int GetBufferSize(out uint frames);
    int GetStreamLatency(out long latency);
    int GetCurrentPadding(out uint padding);
    int IsFormatSupported(int shareMode, IntPtr format, out IntPtr closest);
    int GetMixFormat(out IntPtr format);
    int GetDevicePeriod(out long def, out long min);
    int Start();
    int Stop();
    int Reset();
    int SetEventHandle(IntPtr h);
    int GetService(ref Guid iid, [MarshalAs(UnmanagedType.IUnknown)] out object o);
  }
  [ComImport, Guid("C8ADBD64-E71E-48a0-A4DE-185C395CD317"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
  interface IAudioCaptureClient {
    int GetBuffer(out IntPtr data, out uint frames, out uint flags, out ulong devPos, out ulong qpcPos);
    int ReleaseBuffer(uint frames);
    int GetNextPacketSize(out uint frames);
  }
  static void Check(int hr) { if (hr < 0) Marshal.ThrowExceptionForHR(hr); }
  public static void Run() {
    var en = (IMMDeviceEnumerator)new MMDeviceEnumerator();
    IMMDevice dev; Check(en.GetDefaultAudioEndpoint(0, 0, out dev));
    var iid = typeof(IAudioClient).GUID; object o; Check(dev.Activate(ref iid, 23, IntPtr.Zero, out o));
    var client = (IAudioClient)o;
    IntPtr fmt; Check(client.GetMixFormat(out fmt));
    int tag = Marshal.ReadInt16(fmt, 0) & 0xffff, channels = Marshal.ReadInt16(fmt, 2), rate = Marshal.ReadInt32(fmt, 4);
    int block = Marshal.ReadInt16(fmt, 12), bits = Marshal.ReadInt16(fmt, 14);
    bool isFloat = tag == 3 || (tag == 0xFFFE && Marshal.ReadInt32(fmt, 24) == 3);
    Check(client.Initialize(0, 0x00020000, 200000, 0, fmt, IntPtr.Zero));
    var cid = typeof(IAudioCaptureClient).GUID; object co; Check(client.GetService(ref cid, out co));
    var cap = (IAudioCaptureClient)co;
    Console.Error.WriteLine("{\\"rate\\":" + rate + ",\\"channels\\":" + channels + ",\\"bits\\":" + bits + ",\\"float\\":" + (isFloat ? "true" : "false") + "}");
    Console.Error.Flush();
    var outp = Console.OpenStandardOutput();
    var buf = new byte[0];
    Check(client.Start());
    while (true) {
      Thread.Sleep(10);
      uint n; Check(cap.GetNextPacketSize(out n));
      while (n > 0) {
        IntPtr data; uint frames, flags; ulong a, b;
        Check(cap.GetBuffer(out data, out frames, out flags, out a, out b));
        int bytes = (int)frames * block;
        if (buf.Length < bytes) buf = new byte[bytes];
        if ((flags & 2) != 0) Array.Clear(buf, 0, bytes); else Marshal.Copy(data, buf, 0, bytes);
        Check(cap.ReleaseBuffer(frames));
        outp.Write(buf, 0, bytes);
        outp.Flush();
        Check(cap.GetNextPacketSize(out n));
      }
    }
  }
}
'@
[RHA]::Run()
`;

const AAC_OUT = ["-ac", "2", "-ar", "48000", "-c:a", "aac", "-b:a", "128k", "-f", "adts", "-flush_packets", "1", "pipe:1"];

/** ffmpeg input arguments for raw loopback samples in the format the helper announced. */
export function rawInput(fmt) {
  const f = fmt.float ? "f32le" : { 16: "s16le", 24: "s24le", 32: "s32le" }[fmt.bits] || "s16le";
  return ["-f", f, "-ar", String(fmt.rate), "-ac", String(fmt.channels), "-i", "pipe:0"];
}

/** ADTS frames out of a byte stream; the header's 13-bit length says where each one ends. */
export class AdtsReader {
  constructor() { this.buf = Buffer.alloc(0); }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    while (this.buf.length >= 7) {
      if (this.buf[0] !== 0xff || (this.buf[1] & 0xf6) !== 0xf0) {
        const next = this.buf.indexOf(0xff, 1);
        this.buf = next < 0 ? Buffer.alloc(0) : this.buf.subarray(next);
        continue;
      }
      const len = ((this.buf[3] & 3) << 11) | (this.buf[4] << 3) | (this.buf[5] >> 5);
      if (len < 7) { this.buf = this.buf.subarray(1); continue; }
      if (this.buf.length < len) break;
      out.push(this.buf.subarray(0, len));
      this.buf = this.buf.subarray(len);
    }
    return out;
  }
}

export class DesktopAudio extends EventEmitter {
  constructor({ ffmpeg = process.env.FFMPEG_PATH || "ffmpeg", platform = process.platform } = {}) {
    super();
    this.ffmpeg = ffmpeg;
    this.platform = platform;
    this.procs = [];
    this.helper = new PsHelper("loopback", LOOPBACK_SCRIPT);
  }

  get running() { return this.procs.length > 0; }

  start() {
    if (this.running || !["win32", "linux"].includes(this.platform)) return;
    if (this.platform === "linux") return this._encode(["-f", "pulse", "-fragment_size", "1920", "-i", pulseMonitorSource()]);
    let loop;
    try {
      loop = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-File", this.helper.ensureFile()],
        { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch { return; }
    this.procs.push(loop);
    loop.on("exit", () => this.stop());
    let head = "";
    const onHead = (d) => {
      head += d;
      const nl = head.indexOf("\n");
      if (nl < 0) return;
      loop.stderr.off("data", onHead);
      let fmt;
      try { fmt = JSON.parse(head.slice(0, nl)); } catch { return this.stop(); }
      const enc = this._encode(rawInput(fmt));
      if (enc) loop.stdout.pipe(enc.stdin).on("error", () => {});
    };
    loop.stderr.setEncoding("utf8");
    loop.stderr.on("data", onHead);
  }

  _encode(input) {
    let proc;
    try {
      proc = spawn(this.ffmpeg, ["-hide_banner", "-loglevel", "error", "-fflags", "nobuffer", ...input, ...AAC_OUT],
        { stdio: ["pipe", "pipe", "ignore"], windowsHide: true });
    } catch { this.stop(); return null; }
    this.procs.push(proc);
    proc.stdin.on("error", () => {});
    const adts = new AdtsReader();
    proc.stdout.on("data", (chunk) => { for (const f of adts.push(chunk)) this.emit("audio", f); });
    proc.on("error", () => this.stop());
    proc.on("exit", () => this.stop());
    return proc;
  }

  stop() {
    const procs = this.procs;
    this.procs = [];
    for (const p of procs) { try { p.kill(); } catch { /* already gone */ } }
  }
}
