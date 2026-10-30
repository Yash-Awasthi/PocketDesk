// SPDX-License-Identifier: GPL-3.0-or-later
// adb (Android platform-tools) and scrcpy-server (Apache-2.0, Genymobile), fetched once into
// ~/.pocketdesk/tools when the PC first drives a phone. Download approach adapted from TwinDesk.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { configDir } from "../config.js";

export const SCRCPY_VERSION = "5.0.1";
const SCRCPY_URL = `https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}/scrcpy-server-v${SCRCPY_VERSION}`;
const SCRCPY_SHA256 = "764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536";
const TOOLS = path.join(configDir, "tools");
const EXE = process.platform === "win32" ? "adb.exe" : "adb";
const PT_OS = { win32: "windows", darwin: "darwin", linux: "linux" }[process.platform];

/** A developer's own adb first: two adb builds on one PC keep killing each other's server on 5037. */
export function findAdb() {
  const onPath = String(process.env.PATH || "").split(path.delimiter).filter(Boolean).map((d) => path.join(d, EXE));
  const sdk = (p) => path.basename(path.dirname(p)).toLowerCase() === "platform-tools";
  const local = process.env.LOCALAPPDATA;
  const home = os.homedir();
  return [
    process.env.ADB,
    process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, "platform-tools", EXE),
    process.env.ANDROID_SDK_ROOT && path.join(process.env.ANDROID_SDK_ROOT, "platform-tools", EXE),
    local && path.join(local, "Android", "Sdk", "platform-tools", EXE),
    path.join(home, "Library", "Android", "sdk", "platform-tools", EXE),
    path.join(home, "Android", "Sdk", "platform-tools", EXE),
    ...onPath.filter(sdk),
    path.join(TOOLS, "platform-tools", EXE),
    ...onPath.filter((p) => !sdk(p)),
  ].find((p) => p && fs.existsSync(p)) || null;
}

export const serverPath = () => path.join(TOOLS, `scrcpy-server-v${SCRCPY_VERSION}`);

function download(url, to, hops = 5) {
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { "user-agent": "PocketDesk" } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops > 0) {
        res.resume();
        return resolve(download(new URL(res.headers.location, url).href, to, hops - 1));
      }
      if (res.statusCode !== 200) { res.resume(); return reject(new Error(`download failed: HTTP ${res.statusCode}`)); }
      const out = fs.createWriteStream(to);
      res.pipe(out);
      out.on("finish", () => out.close(resolve));
      out.on("error", reject);
    }).on("error", reject);
  });
}

let fetching = null;

/** Both tools present, fetching what is missing; resolves to { adb, server }. */
export function ensureTools() {
  return (fetching ||= (async () => {
    fs.mkdirSync(TOOLS, { recursive: true });
    let adb = findAdb();
    if (!adb) {
      if (!PT_OS) throw new Error(`no adb for ${process.platform}`);
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pocketdesk-adb-"));
      try {
        const zip = path.join(tmp, "pt.zip");
        await download(`https://dl.google.com/android/repository/platform-tools-latest-${PT_OS}.zip`, zip);
        execFileSync("tar", ["-xf", zip, "-C", TOOLS], { stdio: "ignore", windowsHide: true });
      } finally { fs.rmSync(tmp, { recursive: true, force: true }); }
      adb = findAdb();
      if (!adb) throw new Error("adb did not unpack");
      if (process.platform !== "win32") fs.chmodSync(adb, 0o755);
    }
    const server = serverPath();
    if (!fs.existsSync(server)) {
      const part = `${server}.part`;
      await download(SCRCPY_URL, part);
      const sum = crypto.createHash("sha256").update(fs.readFileSync(part)).digest("hex");
      if (sum !== SCRCPY_SHA256) { fs.rmSync(part, { force: true }); throw new Error("scrcpy-server checksum mismatch"); }
      fs.renameSync(part, server);
    }
    return { adb, server };
  })().finally(() => { fetching = null; }));
}
