// SPDX-License-Identifier: GPL-3.0-or-later
// The phone as an Xbox 360 controller on this PC, through the ViGEmBus driver and
// native/pad (pocketdesk-pad). Games see a real controller; nothing to set up per game.
import { spawn } from "node:child_process";
import { findNative } from "../native.js";

export default function pcPadHandlers(ctx) {
  const { send } = ctx;
  let proc = null;
  let ready = false;
  let error = "";
  const owners = new Map(); // pad number -> the socket driving it

  function helper() {
    if (proc) return proc;
    const exe = findNative("pocketdesk-pad");
    if (!exe) { error = "the controller helper is not installed"; return null; }
    proc = spawn(exe, [], { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    ready = false;
    proc.stdout.on("data", (d) => { if (String(d).includes("ready")) ready = true; });
    proc.stderr.on("data", (d) => { error = String(d).trim(); });
    proc.stdin.on("error", () => {});
    proc.on("exit", () => { proc = null; ready = false; owners.clear(); });
    return proc;
  }

  const int = (v, lo, hi) => Math.max(lo, Math.min(hi, Math.round(Number(v) || 0)));

  return {
    async pc_gamepad_status(ws) {
      const p = helper();
      await new Promise((r) => setTimeout(r, p && !ready ? 800 : 0));
      send(ws, { type: "pc_gamepad_status", ok: !!p && ready, error: ready ? "" : error || "starting" });
    },
    /** One controller's whole state, sent whenever it changes; off unplugs it. */
    async pc_gamepad(ws, msg) {
      const pad = int(msg.pad, 0, 3);
      const owner = owners.get(pad);
      // A pad belongs to the phone that plugged it in, until it unplugs.
      if (owner && owner !== ws && owner.readyState === 1) return;
      const p = helper();
      if (!p) return send(ws, { type: "pc_gamepad_status", ok: false, error });
      if (msg.off) {
        owners.delete(pad);
        return p.stdin.write(`${pad} off\n`);
      }
      if (!owner) {
        owners.set(pad, ws);
        ws.once?.("close", () => { if (owners.get(pad) === ws) { owners.delete(pad); proc?.stdin.write(`${pad} off\n`); } });
      }
      p.stdin.write(`${pad} ${int(msg.buttons, 0, 0xffff)} ${int(msg.lt, 0, 255)} ${int(msg.rt, 0, 255)} ${int(msg.lx, -32768, 32767)} ${int(msg.ly, -32768, 32767)} ${int(msg.rx, -32768, 32767)} ${int(msg.ry, -32768, 32767)}\n`);
    },
  };
}
