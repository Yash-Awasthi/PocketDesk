// The support bundle: versions, ports, the local status lines, the policy booleans and the tail of
// the daemon log. Nothing that opens the PC: token, password, ticket and key values are removed by
// key and by value before the bundle leaves the machine.
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { configDir, configPath } from "./config.js";
import { daemonVersion, PROTOCOL_VERSION } from "./running.js";

const SECRET_KEY = /(token|secret|password|passwd|ticket|private|keystore|credential)/i;
const REDACTED = "[redacted]";
// A bundle is pasted into a chat window; one runaway line must not make it unreadable.
const MAX_TEXT = 64 * 1024;

/** A key that names a credential. Tested against the key alone, so a policy switch called `totp` stays. */
function secretKey(key) {
  return SECRET_KEY.test(key);
}

/** The config's credential values, so they can be scrubbed out of log text that copied them. */
export function knownSecrets(file = configPath) {
  let cfg;
  try {
    cfg = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return []; // no config yet, or half-written: the bundle still builds, it just has less to hide
  }
  const found = new Set();
  const walk = (value, key) => {
    if (typeof value === "string") {
      // Short values under a secret key are flags or labels, not credentials worth hiding.
      if (secretKey(key) && value.length >= 8) found.add(value);
      return;
    }
    if (Array.isArray(value)) {
      for (const item of value) walk(item, key);
      return;
    }
    if (value && typeof value === "object") for (const [k, v] of Object.entries(value)) walk(v, k);
  };
  walk(cfg, "");
  return [...found];
}

/**
 * Deep copy with credentials gone: a credential-named key is dropped whole, and every string has
 * the known secret values replaced. That second pass is what catches a token echoed into a log
 * line, where the key it came from is long gone.
 */
export function redact(value, secrets = []) {
  // Longest first, so a secret containing another secret is gone in one step.
  const list = [...new Set(secrets.map(String).filter(Boolean))].sort((a, b) => b.length - a.length);
  return walk(value, list);
}

function walk(value, secrets) {
  if (typeof value === "string") {
    let text = value;
    for (const s of secrets) text = text.split(s).join(REDACTED);
    return text.slice(0, MAX_TEXT);
  }
  if (value === null || typeof value === "number" || typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((item) => walk(item, secrets));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value)) {
      if (secretKey(k)) continue; // the value is never inspected
      out[k] = walk(v, secrets);
    }
    return out;
  }
  return value;
}

/** The last [maxBytes] of each log the daemon and the tray leave in the config folder. */
export function logTail(
  dir = configDir,
  names = ["daemon.log", "daemon.log.1", "tray.log"],
  maxBytes = 64 * 1024,
) {
  const out = [];
  for (const name of names) {
    const file = path.join(dir, name);
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) continue;
      const start = Math.max(0, st.size - maxBytes);
      const buf = Buffer.alloc(st.size - start);
      const fd = fs.openSync(file, "r");
      try {
        fs.readSync(fd, buf, 0, buf.length, start);
      } finally {
        fs.closeSync(fd);
      }
      out.push({ name, text: buf.toString("utf8") });
    } catch {
      // Missing is the normal case (no service installed); an unreadable file must not fail a
      // bundle someone is making because the daemon is already misbehaving.
    }
  }
  return out;
}

/** The document a person attaches to a support request. Pure, so the test can build one by hand. */
export function bundle({
  ports = {},
  sessions = [],
  policy = {},
  status = [],
  logs = [],
  secrets = [],
  platform = process.platform,
  arch = process.arch,
  version = daemonVersion(),
  now = Date.now(),
} = {}) {
  const doc = {
    at: new Date(now).toISOString(),
    app: { name: "pocketdesk", version: version || "unknown", protocol: PROTOCOL_VERSION },
    runtime: { node: process.version, platform, arch, release: os.release() },
    ports: {
      daemon: Number(ports.daemon) || 0,
      page: Number(ports.page) || 0,
      cli: Number(ports.cli) || 0,
      usb: Number(ports.usb) || 0,
    },
    sessions: {
      count: sessions.length,
      items: sessions.map((s) => ({
        id: String(s.id ?? "").slice(0, 8),
        harnessId: String(s.harnessId ?? ""),
        kind: String(s.kind ?? "terminal"),
        state: String(s.state ?? ""),
      })),
    },
    policy: {
      control: Boolean(policy.control),
      remote: Boolean(policy.remote),
      password: Boolean(policy.password),
      totp: Boolean(policy.totp),
      recording: Boolean(policy.recording),
    },
    status: status.map(String),
    logs,
  };
  // Final pass: whatever a log line or a caller slipped in, a known secret value cannot survive,
  // and a credential-named key is dropped even when its value looks harmless.
  return redact(doc, secrets);
}
