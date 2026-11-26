// One log format, one folder, one rotation rule for the daemon.
//
// Every line is JSON: {"ts","event",...} with secrets and this machine's home
// folder taken out before it is written, so a log pasted into a bug report
// cannot carry a pairing token or say where the account lives. Rotation is
// size-based because a terminal left open for a week must not fill the disk.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export const MAX_BYTES = 5 * 1024 * 1024;
export const MAX_FILES = 5;

/** `<profile>/logs`, or an absolute dataDir. RH_HOME wins so tests never touch the real profile. */
export function logDir(dataDir = ".pocketdesk") {
  if (path.isAbsolute(dataDir)) return dataDir.endsWith("logs") ? dataDir : path.join(dataDir, "logs");
  const root = process.env.RH_HOME || path.join(os.homedir(), dataDir);
  return path.join(root, "logs");
}

// Keys whose value is never useful in a log and always dangerous.
const SECRET_KEY =
  /^(token|devicetoken|pairingtoken|password|pass|secret|apikey|api_key|authorization|cookie|totp)$/i;
// Values embedded in prose: "token=abc", "Authorization: Bearer abc".
const INLINE = [
  [/\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]{6,}/gi, "$1 <redacted>"],
  [/\b(token|password|secret|api[_-]?key|code)=([^\s&"',;]{4,})/gi, "$1=<redacted>"],
];

/** A copy of [value] with secret keys, credential-shaped strings and the home folder removed. */
export function redact(value, depth = 0) {
  if (depth > 6) return "<deep>";
  if (typeof value === "string") {
    let out = value;
    for (const [re, to] of INLINE) out = out.replace(re, to);
    const home = os.homedir();
    if (home) out = out.split(home).join("~").split(home.replace(/\\/g, "/")).join("~");
    return out;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  if (value && typeof value === "object") {
    const out = {};
    for (const [k, v] of Object.entries(value))
      out[k] = SECRET_KEY.test(k) ? "<redacted>" : redact(v, depth + 1);
    return out;
  }
  return value;
}

/** The one line shape: ISO time, event name, redacted fields. */
export function record(event, data = {}, now = new Date()) {
  return JSON.stringify({ ts: now.toISOString(), event, ...redact(data) }) + "\n";
}

/**
 * Append [line] to [file], moving the file aside once it would exceed [maxBytes].
 * Keeps [maxFiles] files: the live one plus .1 .. .(maxFiles-1), newest first.
 */
export function appendLine(file, line, { maxBytes = MAX_BYTES, maxFiles = MAX_FILES } = {}) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const size = fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
  if (size > 0 && size + Buffer.byteLength(line) > maxBytes) {
    // Oldest goes first: drop .(maxFiles-1), then shift down to .1, then the live file.
    fs.rmSync(`${file}.${maxFiles - 1}`, { force: true });
    for (let i = maxFiles - 2; i >= 1; i--) {
      if (fs.existsSync(`${file}.${i}`)) fs.renameSync(`${file}.${i}`, `${file}.${i + 1}`);
    }
    fs.renameSync(file, `${file}.1`);
  }
  fs.appendFileSync(file, line, { mode: 0o600 });
}

/** Today's file: the daemon restarts keep appending to one file per day. */
export function dailyFile(dir, now = new Date()) {
  return path.join(dir, `daemon-${now.toISOString().slice(0, 10)}.log`);
}
