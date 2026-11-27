// What is running on this PC, for the hub's Running page. Pure, so a test can build it without a daemon.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { PROTOCOL_VERSION } from "./version.js";
export { PROTOCOL_VERSION };

/** The daemon's own package version, read from package.json beside this module's folder. */
export function daemonVersion(dir = path.dirname(fileURLToPath(import.meta.url))) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, "..", "package.json"), "utf8")).version || "unknown";
  } catch {
    return "unknown";
  }
}

export function snapshot({
  version,
  ports = {},
  sessions = [],
  streams = {},
  policy = {},
  now = Date.now(),
} = {}) {
  const items = sessions.map((s) => ({
    id: String(s.id ?? ""),
    harnessId: String(s.harnessId ?? ""),
    kind: String(s.kind ?? "terminal"),
    state: String(s.state ?? ""),
    cwd: typeof s.cwd === "string" ? s.cwd : "",
    bytes: Number(s.bytes) || 0,
  }));
  return {
    at: new Date(now).toISOString(),
    version: { daemon: version || "unknown", protocol: PROTOCOL_VERSION, node: process.version },
    ports: {
      daemon: Number(ports.daemon) || 0,
      page: Number(ports.page) || 0,
      cli: Number(ports.cli) || 0,
      usb: Number(ports.usb) || 0,
    },
    sessions: { count: items.length, items },
    streams: {
      video: Number(streams.video) || 0,
      desktop: Number(streams.desktop) || 0,
      audio: Number(streams.audio) || 0,
      remote: Number(streams.remote) || 0,
    },
    policy: {
      control: Boolean(policy.control),
      remote: Boolean(policy.remote),
      password: Boolean(policy.password),
      totp: Boolean(policy.totp),
      recording: Boolean(policy.recording),
    },
  };
}
