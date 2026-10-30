// SPDX-License-Identifier: GPL-3.0-or-later
// The phone's camera as the "PocketDesk Webcam" on Windows 11: scrcpy streams the camera's H.264,
// ffmpeg decodes it to BGRX, and pocketdesk-vcam-host hands each frame to the virtual camera
// that Zoom, Teams, Meet and the Camera app pick like any other.
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { findNative, runElevated, runOut } from "./native.js";

export class Webcam extends EventEmitter {
  constructor() {
    super();
    this.on("error", () => {});
    this.state = "off";
  }

  get host() { return findNative("pocketdesk-vcam-host"); }

  async status() {
    if (process.platform !== "win32") return { supported: false, reason: "Windows 11 only" };
    const host = this.host;
    if (!host) return { supported: false, reason: "the webcam helper is not installed" };
    return { supported: true, registered: (await runOut(host, ["--status"])) === "registered", state: this.state, facing: this.facing || null, error: this.error || "" };
  }

  /** Registers the camera with Windows once; asks for administrator rights. */
  async register() {
    const host = this.host;
    if (!host) throw new Error("the webcam helper is not installed");
    if (await runElevated(host, ["--register"])) throw new Error("registering the webcam was cancelled or failed");
  }

  /** [session] is a scrcpy camera session already started; its video becomes the webcam. */
  start(session, name) {
    this.stop();
    const host = this.host;
    if (!host) throw new Error("the webcam helper is not installed");
    this.session = session;
    this.state = "starting";
    this.error = "";
    this.vcam = spawn(host, ["--name", name || "Phone"], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.vcam.stderr.on("data", (d) => { this.error = String(d).trim(); });
    this.vcam.on("exit", () => { if (this.session === session) this.stop(); });
    this.vcam.stdin.on("error", () => {});
    let size = null;
    session.on("size", (s) => {
      // A new size (the phone turned, the other camera) needs a decoder that knows it. The same
      // size again is only the encoder restarting, and the running decoder keeps going.
      if (size && size.width === s.width && size.height === s.height) return;
      size = s;
      this.decoder(s);
    });
    session.on("video", (p) => {
      // Kept even before a decoder exists: the parameter sets can come ahead of the size.
      if (p.config) this.config = p.data;
      if (!this.ff || this.ff.killed) return;
      // A fresh decoder needs the parameter sets in front of its first keyframe.
      const data = p.key && this.config && !this.fed ? Buffer.concat([this.config, p.data]) : p.data;
      if (!this.fed && !p.key && !p.config) return;
      this.fed = true;
      this.ff.stdin.write(data);
    });
    session.on("closed", () => { if (this.session === session) this.stop(); });
  }

  decoder({ width, height }) {
    try { this.ff?.kill(); } catch {}
    this.fed = false;
    const ff = spawn(process.env.FFMPEG_PATH || "ffmpeg", [
      // A tiny probe size leaves ffmpeg waiting for more of the stream before it decodes anything.
      "-hide_banner", "-loglevel", "error", "-flags", "low_delay",
      "-f", "h264", "-i", "pipe:0", "-f", "rawvideo", "-pix_fmt", "bgr0", "pipe:1",
    ], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    this.ff = ff;
    ff.stdin.on("error", () => {});
    ff.stderr.on("data", (d) => { this.error = `ffmpeg: ${String(d).trim().split(/\r?\n/).pop()}`; });
    ff.on("error", (e) => { this.error = `ffmpeg: ${e.message}`; this.emit("change"); });
    const len = width * height * 4;
    const head = Buffer.alloc(12);
    head.write("PDVF", 0, "ascii");
    head.writeUInt32LE(width, 4);
    head.writeUInt32LE(height, 8);
    let pending = [];
    let have = 0;
    ff.stdout.on("data", (d) => {
      pending.push(d);
      have += d.length;
      while (have >= len) {
        const all = pending.length === 1 ? pending[0] : Buffer.concat(pending);
        const frame = all.subarray(0, len);
        const rest = all.subarray(len);
        pending = rest.length ? [rest] : [];
        have = rest.length;
        // A camera app that stalls the pipe loses frames, never gains delay.
        if (this.vcam?.stdin.writableLength < len * 2) {
          this.vcam.stdin.write(head);
          this.vcam.stdin.write(frame);
        }
        if (this.state !== "on") { this.state = "on"; this.emit("change"); }
      }
    });
  }

  stop() {
    const was = this.state;
    this.state = "off";
    try { this.ff?.kill(); } catch {}
    try { this.vcam?.stdin.end(); } catch {}
    const s = this.session;
    this.session = null;
    this.ff = null;
    this.vcam = null;
    this.config = null;
    if (s && !s.closed) s.stop();
    if (was !== "off") this.emit("change");
  }
}
