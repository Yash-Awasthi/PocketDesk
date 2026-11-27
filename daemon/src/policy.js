// Machine policy: the machine owner's kill switch, read before any remote sense starts. The keys live
// in HKLM\SOFTWARE\PocketDesk\Policy, with C:\ProgramData\PocketDesk\policy.json as the console's copy.
// A key set to 0 in either store disables its feature; an unset key leaves the feature on, so a
// machine with no policy behaves exactly as before. Reads are cheap (one `reg query` per key, cached
// for a second) because the check sits in front of every message.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { writeFileAtomic } from "./atomic_write.js";
import { isElevated } from "./status.js";

/** The four keys the published contract names (docs/INTEGRITY.md, docs/SETUP-PC.md). */
export const POLICY_KEYS = Object.freeze([
  "AllowRemoteControl",
  "AllowWebcam",
  "AllowPhoneControl",
  "AllowClipboard",
]);

const IS_WIN = process.platform === "win32";

/** The registry key, overridable so a test can use HKCU and the real decoder without admin. */
export function regKey() {
  return process.env.RH_POLICY_REG || "HKLM\\SOFTWARE\\PocketDesk\\Policy";
}

/** The JSON store; ProgramData is where the console reads it from. */
export function jsonPath() {
  return (
    process.env.RH_POLICY_JSON ||
    path.join(
      process.env.ProgramData || process.env.ALLUSERSPROFILE || "C:\\ProgramData",
      "PocketDesk",
      "policy.json",
    )
  );
}

function dword(raw) {
  if (typeof raw === "number") return raw;
  if (typeof raw !== "string") return undefined;
  const t = raw.trim();
  if (/^0x[0-9a-f]+$/i.test(t)) return Number.parseInt(t.slice(2), 16);
  if (/^\d+$/.test(t)) return Number(t);
  return undefined;
}

/**
 * One value from the registry, or undefined when it is absent. Exported for the store test: the
 * parse is the part that can be wrong, and `reg query` prints a table a human reads, not JSON.
 */
export function parseRegQuery(output, name) {
  const re = new RegExp(`^\\s*${name}\\s+REG_(?:DWORD|S Z|SZ|EXPAND_SZ)\\s+(.+?)\\s*$`, "im");
  const m = re.exec(String(output || ""));
  return m ? dword(m[1]) : undefined;
}

/** The registry values this machine has. A missing key or a refused query reads as "nothing set". */
export function registryValues(key = regKey()) {
  if (!IS_WIN && !process.env.RH_POLICY_REG) return {};
  const out = {};
  for (const name of POLICY_KEYS) {
    try {
      const text = execFileSync("reg", ["query", key, "/v", name], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      });
      const v = parseRegQuery(text, name);
      if (v !== undefined) out[name] = v;
    } catch {
      /* absent value, absent key, or no reg.exe: all mean unset */
    }
  }
  return out;
}

/** The JSON store's values, ignoring a file that is missing, unreadable or not an object. */
export function jsonValues(file = jsonPath()) {
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return {};
  }
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return {};
  const out = {};
  for (const name of POLICY_KEYS) {
    const v = dword(raw[name]);
    if (v !== undefined) out[name] = v;
  }
  return out;
}

/**
 * Every key's effective state: the stricter of the two stores wins, so an owner who set either
 * copy to 0 is obeyed. `source` names where that 0 came from, for the refusal message.
 */
export function policyState() {
  const reg = registryValues();
  const json = jsonValues();
  const out = {};
  for (const name of POLICY_KEYS) {
    const off = [];
    if (reg[name] === 0) off.push(`HKLM (${regKey()})`);
    if (json[name] === 0) off.push(jsonPath());
    out[name] = {
      allowed: off.length === 0,
      value: off.length ? 0 : (reg[name] ?? json[name]),
      source: off[0],
      registry: reg[name],
      json: json[name],
    };
  }
  return out;
}

// One `reg query` per key per second: policy is checked per message, and an owner's edit takes
// effect on the next second, not on the next restart.
let cached = null;
let cachedAt = 0;
const CACHE_MS = 1000;

export function currentPolicy({ fresh = false } = {}) {
  const now = Date.now();
  if (fresh || !cached || now - cachedAt > CACHE_MS) {
    cached = policyState();
    cachedAt = now;
  }
  return cached;
}

/** Forget the cached read so a set or reset is visible immediately. */
export function invalidate() {
  cached = null;
  cachedAt = 0;
}

/** True when this process may change policy: registry writes and ProgramData both need admin. */
export function isAdmin() {
  return isElevated();
}

/** A value for one key, or throw the reason a write cannot happen here. */
export function setKey(name, value, { requireAdmin = true } = {}) {
  if (!POLICY_KEYS.includes(name))
    throw new Error(`not a policy key: ${name} (keys: ${POLICY_KEYS.join(", ")})`);
  const v = value === true ? 1 : value === false ? 0 : dword(value);
  if (v !== 0 && v !== 1) throw new Error(`policy value must be 0 or 1, not ${value}`);
  if (requireAdmin && !isAdmin()) throw new Error("changing machine policy needs an administrator prompt");
  const done = [];
  if (IS_WIN) {
    execFileSync("reg", ["add", regKey(), "/v", name, "/t", "REG_DWORD", "/d", String(v), "/f"], {
      stdio: "ignore",
      windowsHide: true,
    });
    done.push(`${regKey()}\\${name}=${v}`);
  }
  const file = jsonPath();
  const json = jsonValues(file);
  json[name] = v;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  writeFileAtomic(file, JSON.stringify(json, null, 2) + "\n", { mode: 0o644 });
  done.push(`${file}: ${name}=${v}`);
  invalidate();
  return done;
}

/** Remove a key from both stores, or every key when none is named. */
export function resetKey(name, { requireAdmin = true } = {}) {
  const names = name ? [name] : [...POLICY_KEYS];
  for (const n of names)
    if (!POLICY_KEYS.includes(n)) throw new Error(`not a policy key: ${n} (keys: ${POLICY_KEYS.join(", ")})`);
  if (requireAdmin && !isAdmin()) throw new Error("changing machine policy needs an administrator prompt");
  const done = [];
  for (const n of names) {
    if (IS_WIN) {
      try {
        execFileSync("reg", ["delete", regKey(), "/v", n, "/f"], { stdio: "ignore", windowsHide: true });
        done.push(`removed ${regKey()}\\${n}`);
      } catch {
        /* was not set */
      }
    }
  }
  const file = jsonPath();
  const json = jsonValues(file);
  let changed = false;
  for (const n of names)
    if (n in json) {
      delete json[n];
      changed = true;
    }
  if (changed) writeFileAtomic(file, JSON.stringify(json, null, 2) + "\n", { mode: 0o644 });
  done.push(`${file}: ${names.join(", ")} cleared`);
  invalidate();
  return done;
}

// Which messages count as a remote sense. Kept explicit: a new handler is not gated by accident,
// and a guard test asserts every listed type is a real handler.
const REMOTE_CONTROL = new Set([
  "desktop_start",
  "remote_input",
  "desktop_mouse",
  "desktop_key",
  "desktop_type",
  "deck_key",
  "kvm_in",
]);
const WEBCAM = new Set(["adb_webcam", "adb_webcam_register"]);
const PHONE_CONTROL =
  /^adb_(input|type|open|close|gamepad|select|connect|pair|qr_start|disconnect|apps|cameras|fix|install_app|fs)$/;
const PHONE_EXTRA = new Set(["phone_input", "phone_fs", "phone_switch"]);
const CLIPBOARD = new Set(["clipboard_get", "clipboard_set", "clippy_paste", "handoff"]);

/** The policy keys that cover one message type; empty means it is not a remote sense. */
export function policyKeysFor(type) {
  const keys = [];
  if (REMOTE_CONTROL.has(type)) keys.push("AllowRemoteControl");
  if (WEBCAM.has(type)) keys.push("AllowWebcam");
  if (PHONE_CONTROL.test(type) || PHONE_EXTRA.has(type)) keys.push("AllowPhoneControl");
  if (CLIPBOARD.has(type) || /^adb_clipboard_/.test(type)) keys.push("AllowClipboard");
  return keys;
}

/**
 * The refusal for one message, or null. The first disabled key wins, so a message covered by two
 * keys (an adb clipboard write) is refused by either, and the message names both the key and the store.
 */
export function refusalFor(type, state = currentPolicy()) {
  for (const key of policyKeysFor(type)) {
    const s = state[key];
    if (!s.allowed) {
      return {
        type,
        key,
        code: "disabled_by_policy",
        message: `disabled_by_policy: ${key} is 0 in ${s.source}; ${type} is refused`,
      };
    }
  }
  return null;
}

/** One line per key for `pocketdesk policy` and `--status`. */
export function describe(state = currentPolicy({ fresh: true })) {
  return POLICY_KEYS.map((name) => {
    const s = state[name];
    if (s.allowed) return `${name}: on${s.value === 1 ? " (set to 1)" : " (not set)"}`;
    return `${name}: OFF (set to 0 in ${s.source})`;
  });
}
