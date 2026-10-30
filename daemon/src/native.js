// SPDX-License-Identifier: GPL-3.0-or-later
// PocketDesk's own Windows helpers (native/, built with Rust): the virtual webcam and the virtual
// Xbox controller. An install keeps them in <install>/native; a checkout builds them into
// native/target/release.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";

const here = path.dirname(fileURLToPath(import.meta.url));
const DIRS = [
  process.env.POCKETDESK_NATIVE,
  path.join(here, "..", "..", "native"),
  path.join(here, "..", "..", "native", "target", "release"),
].filter(Boolean);

export function findNative(name) {
  const file = process.platform === "win32" ? `${name}.exe` : name;
  return DIRS.map((d) => path.join(d, file)).find((p) => fs.existsSync(p)) || null;
}

/** Runs [exe] with [args] elevated (UAC prompt) and resolves to its exit code. */
export function runElevated(exe, args) {
  const list = args.map((a) => `'${String(a).replace(/'/g, "''")}'`).join(",");
  const cmd = `$p = Start-Process -FilePath '${exe.replace(/'/g, "''")}' -ArgumentList ${list || "@()"} -Verb RunAs -WindowStyle Hidden -Wait -PassThru; exit $p.ExitCode`;
  return new Promise((resolve) => {
    const p = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", cmd], { windowsHide: true });
    p.on("exit", (code) => resolve(code ?? 1));
    p.on("error", () => resolve(1));
  });
}

/** Runs [exe] and resolves to its stdout, trimmed. */
export function runOut(exe, args) {
  return new Promise((resolve) => {
    let out = "";
    const p = spawn(exe, args, { windowsHide: true });
    p.stdout.on("data", (d) => { out += d; });
    p.on("exit", () => resolve(out.trim()));
    p.on("error", () => resolve(""));
  });
}
