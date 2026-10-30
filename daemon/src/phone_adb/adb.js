// SPDX-License-Identifier: GPL-3.0-or-later
// The adb client the PC drives a phone with: wireless-debugging pairing and connect, shell,
// push and port forwards to scrcpy-server. Adapted from TwinDesk (GPL-3.0, inukaasith).
import { execFile, spawn } from "node:child_process";
import * as adbmdns from "./adbmdns.js";

export class Adb {
  constructor(bin, server) {
    this.bin = bin;
    this.server = server;
  }

  run(args, { timeout = 15000, input } = {}) {
    return new Promise((resolve) => {
      const p = execFile(this.bin, args, { timeout, maxBuffer: 16 << 20, windowsHide: true, encoding: "buffer" }, (err, out, errOut) => {
        resolve({ code: err ? (typeof err.code === "number" ? err.code : -1) : 0, out: String(out || ""), err: String(errOut || err?.message || ""), raw: out });
      });
      if (input != null) p.stdin.end(input);
    });
  }

  /** [{ serial, state, model? }] */
  async devices() {
    const r = await this.run(["devices", "-l"]);
    return r.out.split(/\r?\n/).slice(1).map((l) => l.trim()).filter(Boolean).map((l) => {
      const [serial, state, ...rest] = l.split(/\s+/);
      const model = rest.find((x) => x.startsWith("model:"))?.slice(6).replace(/_/g, " ");
      return { serial, state, model, wireless: /:\d+$|_adb-tls-connect/.test(serial) };
    }).filter((d) => d.serial && d.state);
  }

  /** The phone's wireless-debugging services; adb's own mDNS often misses what ours hears. */
  async mdns() {
    const [r, ours] = await Promise.all([this.run(["mdns", "services"], { timeout: 5000 }), adbmdns.query()]);
    const out = [];
    for (const l of r.out.split(/\r?\n/)) {
      const m = /^(\S+)\s+_adb-tls-(pairing|connect)\._tcp\.?\s+([\d.]+):(\d+)/.exec(l.trim());
      if (m) out.push({ name: m[1], type: m[2], address: m[3], port: Number(m[4]) });
    }
    for (const s of ours) if (!out.some((o) => o.type === s.type && o.address === s.address && o.port === s.port)) out.push(s);
    return out;
  }

  async pair(address, port, code) {
    const r = await this.run(["pair", `${address}:${port}`, String(code)], { timeout: 20000 });
    const text = `${r.out}${r.err}`.trim();
    return { ok: /Successfully paired/i.test(text), text };
  }

  async connect(address, port) {
    const r = await this.run(["connect", `${address}:${port}`], { timeout: 10000 });
    const text = `${r.out}${r.err}`.trim();
    return { ok: /connected to|already connected/i.test(text) && !/failed|unable|cannot/i.test(text), text };
  }

  disconnect(serial) { return this.run(["disconnect", serial], { timeout: 5000 }); }
  shell(serial, command, opts) { return this.run(["-s", serial, "shell", command], opts); }
  push(serial, local, remote) { return this.run(["-s", serial, "push", local, remote], { timeout: 120000 }); }
  install(serial, apk) { return this.run(["-s", serial, "install", "-r", "-g", apk], { timeout: 180000 }); }

  /** A local TCP port forwarded to an abstract socket on the phone. */
  async forward(serial, abstractName) {
    const r = await this.run(["-s", serial, "forward", "tcp:0", `localabstract:${abstractName}`]);
    const port = Number(r.out.trim());
    if (!port) throw new Error(`adb forward failed: ${r.err.trim() || r.out.trim()}`);
    return port;
  }

  unforward(serial, port) { return this.run(["-s", serial, "forward", "--remove", `tcp:${port}`], { timeout: 5000 }); }

  spawnShell(serial, command) {
    return spawn(this.bin, ["-s", serial, "shell", command], { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
  }

  /** The phone's screen as a PNG (exec-out keeps the bytes binary). */
  async screencap(serial) {
    const r = await this.run(["-s", serial, "exec-out", "screencap", "-p"], { timeout: 15000 });
    return r.code === 0 ? r.raw : null;
  }
}
