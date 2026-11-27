// SPDX-License-Identifier: GPL-3.0-or-later
// adb (Android platform-tools) and scrcpy-server (Apache-2.0, Genymobile), fetched once into
// ~/.pocketdesk/tools when the PC first drives a phone. Download approach adapted from TwinDesk.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import https from "node:https";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import { configDir } from "../config.js";

export const SCRCPY_VERSION = "5.0.1";
const SCRCPY_URL = `https://github.com/Genymobile/scrcpy/releases/download/v${SCRCPY_VERSION}/scrcpy-server-v${SCRCPY_VERSION}`;
export const SCRCPY_SHA256 = "764eb6f79811d5211fe9df341120882ba9994c7a61b897d7bf3fb662e53bc536";

// Versioned, checksummed builds; "latest" would let Google swap the bytes under a pinned hash.
// The sha256 values were computed from downloads whose sha1 match Google's repository2-1.xml.
export const PLATFORM_TOOLS = {
  win32: {
    url: "https://dl.google.com/android/repository/platform-tools_r37.0.3-win.zip",
    sha256: "89d108360a3bf2924d3bea837239edaccc22fd6ff5befd3787c4348a9fe4f09d",
  },
  darwin: {
    url: "https://dl.google.com/android/repository/platform-tools_r37.0.3-darwin.zip",
    sha256: "df21339b9371fef9b19264404338dc686f59a88a1dce634b963da344909001d6",
  },
  linux: {
    url: "https://dl.google.com/android/repository/platform-tools_r37.0.3-linux.zip",
    sha256: "214548146cadb2ca3508143d8a1d4be4c59de5bb837253e3ede89ed74cf450d1",
  },
};

const TOOLS = path.join(configDir, "tools");
const EXE = process.platform === "win32" ? "adb.exe" : "adb";

/** A developer's own adb first: two adb builds on one PC keep killing each other's server on 5037. */
export function findAdb() {
  const onPath = String(process.env.PATH || "")
    .split(path.delimiter)
    .filter(Boolean)
    .map((d) => path.join(d, EXE));
  const sdk = (p) => path.basename(path.dirname(p)).toLowerCase() === "platform-tools";
  const local = process.env.LOCALAPPDATA;
  const home = os.homedir();
  return (
    [
      process.env.ADB,
      process.env.ANDROID_HOME && path.join(process.env.ANDROID_HOME, "platform-tools", EXE),
      process.env.ANDROID_SDK_ROOT && path.join(process.env.ANDROID_SDK_ROOT, "platform-tools", EXE),
      local && path.join(local, "Android", "Sdk", "platform-tools", EXE),
      path.join(home, "Library", "Android", "sdk", "platform-tools", EXE),
      path.join(home, "Android", "Sdk", "platform-tools", EXE),
      ...onPath.filter(sdk),
      path.join(TOOLS, "platform-tools", EXE),
      ...onPath.filter((p) => !sdk(p)),
    ].find((p) => p && fs.existsSync(p)) || null
  );
}

export const serverPath = () => path.join(TOOLS, `scrcpy-server-v${SCRCPY_VERSION}`);

/** http for a local test server, https for the real hosts; follows redirects. */
function download(url, to, hops = 5) {
  return new Promise((resolve, reject) => {
    const mod = new URL(url).protocol === "http:" ? http : https;
    mod
      .get(url, { headers: { "user-agent": "PocketDesk" } }, (res) => {
        if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location && hops > 0) {
          res.resume();
          return resolve(download(new URL(res.headers.location, url).href, to, hops - 1));
        }
        if (res.statusCode !== 200) {
          res.resume();
          return reject(new Error(`download failed: HTTP ${res.statusCode}`));
        }
        const out = fs.createWriteStream(to);
        res.pipe(out);
        out.on("finish", () => out.close(resolve));
        out.on("error", reject);
      })
      .on("error", reject);
  });
}

/** Download to `<to>.part`, verify sha256, and rename into place only on a match. */
export async function downloadVerified(url, to, expectedSha256) {
  const part = `${to}.part`;
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    await download(url, part);
    const sum = crypto.createHash("sha256").update(fs.readFileSync(part)).digest("hex");
    if (sum !== expectedSha256) throw new Error(`download checksum mismatch: ${url}`);
    fs.renameSync(part, to);
  } catch (e) {
    fs.rmSync(part, { force: true });
    throw e;
  }
}

function untar(zip, dir) {
  execFileSync("tar", ["-xf", zip, "-C", dir], { stdio: "ignore", windowsHide: true });
}

let fetching = null;

/** Both tools present, fetching what is missing; resolves to { adb, server }. */
export function ensureTools(deps = {}) {
  const fetchVerified = deps.downloadVerified || downloadVerified;
  const locate = deps.findAdb || findAdb;
  const unpack = deps.untar || untar;
  return (fetching ||= (async () => {
    fs.mkdirSync(TOOLS, { recursive: true });
    let adb = locate();
    if (!adb) {
      const pt = PLATFORM_TOOLS[process.platform];
      if (!pt) throw new Error(`no adb for ${process.platform}`);
      const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pocketdesk-adb-"));
      try {
        const zip = path.join(tmp, "pt.zip");
        await fetchVerified(pt.url, zip, pt.sha256);
        unpack(zip, TOOLS);
      } finally {
        fs.rmSync(tmp, { recursive: true, force: true });
      }
      adb = locate();
      if (!adb) throw new Error("adb did not unpack");
      if (process.platform !== "win32") fs.chmodSync(adb, 0o755);
    }
    const server = serverPath();
    if (!fs.existsSync(server)) await fetchVerified(SCRCPY_URL, server, SCRCPY_SHA256);
    return { adb, server };
  })().finally(() => {
    fetching = null;
  }));
}
