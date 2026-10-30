// SPDX-License-Identifier: GPL-3.0-or-later
// A phone or tablet as an extra screen: a virtual monitor at its size (Virtual Display Driver),
// which the phone then views and drives like any other monitor of this PC.
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runElevated } from "../native.js";

const SCRIPT = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "scripts", "vdd.ps1");

export default function displayHandlers(ctx) {
  const { send } = ctx;
  let busy = false;
  const run = (args) => runElevated("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", SCRIPT, ...args]);

  return {
    async display_extend(ws, msg) {
      if (process.platform !== "win32") return send(ws, { type: "display_extend", ok: false, error: "An extra screen needs Windows on the PC" });
      if (busy) return send(ws, { type: "display_extend", ok: false, error: "Already adding a screen" });
      const w = Math.max(640, Math.min(7680, Number(msg.w) | 0)) & ~1;
      const h = Math.max(480, Math.min(4320, Number(msg.h) | 0)) & ~1;
      busy = true;
      try {
        // Windows asks the PC's owner first (administrator rights for the driver).
        const code = await run(["-Width", String(w), "-Height", String(h)]);
        send(ws, code === 0 ? { type: "display_extend", ok: true, w, h }
          : { type: "display_extend", ok: false, error: "The PC did not add the screen: allow the administrator prompt on the PC (details in %TEMP%\\pocketdesk-vdd.log)" });
      } finally { busy = false; }
    },
    async display_extend_off(ws) {
      if (process.platform !== "win32") return;
      const code = await run(["-Off"]);
      send(ws, { type: "display_extend_off", ok: code === 0 });
    },
  };
}
