// Optional second factor for pairing a new device with the master token (RFC 6238, SHA-1, 30 s).
// Devices already paired log in with their own token and are never asked.
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { configDir } from "./config.js";
import { writeFileAtomic } from "./atomic_write.js";

const FILE = path.join(configDir, "totp.json");
const B32 = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";
const RECOVERY_CODES = 8;
let pending = null;
let lastRecovery = null;
const used = new Map();

function base32(buf) {
  let bits = "";
  for (const b of buf) bits += b.toString(2).padStart(8, "0");
  return bits
    .match(/.{1,5}/g)
    .map((c) => B32[parseInt(c.padEnd(5, "0"), 2)])
    .join("");
}

function unbase32(s) {
  const bits = [...s.toUpperCase().replace(/=+$/, "")]
    .map((c) => B32.indexOf(c).toString(2).padStart(5, "0"))
    .join("");
  return Buffer.from(bits.match(/.{8}/g).map((b) => parseInt(b, 2)));
}

export function code(secret, step) {
  const msg = Buffer.alloc(8);
  msg.writeBigUInt64BE(BigInt(step));
  const h = crypto.createHmac("sha1", unbase32(secret)).update(msg).digest();
  const o = h[19] & 15;
  return String((h.readUInt32BE(o) & 0x7fffffff) % 1e6).padStart(6, "0");
}

/** Accepts the current code or one step either side, each step at most once. */
export function check(secret, given, now = Date.now()) {
  const step = Math.floor(now / 30000);
  for (const s of [step - 1, step, step + 1]) {
    const c = code(secret, s);
    if (
      String(given || "").length === 6 &&
      crypto.timingSafeEqual(Buffer.from(c), Buffer.from(String(given)))
    ) {
      if (used.get(secret) >= s) return false;
      used.set(secret, s);
      return true;
    }
  }
  return false;
}

function loadFile() {
  try {
    return JSON.parse(fs.readFileSync(FILE, "utf8"));
  } catch {
    return null;
  }
}

function saved() {
  return loadFile()?.secret || null;
}

const hash = (s) => crypto.createHash("sha256").update(String(s)).digest("hex");
const normCode = (s) =>
  String(s || "")
    .replace(/[^0-9a-f]/gi, "")
    .toUpperCase();

export function enabled() {
  return Boolean(saved());
}

/** True when a pairing hello may proceed. */
export function allowsPairing(given) {
  const secret = saved();
  return !secret || check(secret, given);
}

/** A fresh secret to put in an authenticator app; nothing changes until enable() confirms a code. */
export function setup(label) {
  pending = base32(crypto.randomBytes(20));
  const name = encodeURIComponent(`PocketDesk:${label}`);
  return { secret: pending, uri: `otpauth://totp/${name}?secret=${pending}&issuer=PocketDesk` };
}

export function enable(given) {
  if (!pending || !check(pending, given)) return false;
  // Recovery codes are shown once by takeRecovery(); only their hashes are kept.
  const codes = Array.from({ length: RECOVERY_CODES }, () =>
    crypto.randomBytes(5).toString("hex").toUpperCase(),
  );
  fs.mkdirSync(configDir, { recursive: true });
  writeFileAtomic(FILE, JSON.stringify({ secret: pending, recovery: codes.map(hash) }), { mode: 0o600 });
  pending = null;
  lastRecovery = codes;
  return true;
}

/** The recovery codes enable() just made, once. */
export function takeRecovery() {
  const codes = lastRecovery;
  lastRecovery = null;
  return codes;
}

/**
 * Disables two-factor with an unused recovery code, for a lost authenticator.
 * One code per call; the file is gone afterwards, so the owner enrolls again.
 */
export function recover(given) {
  const f = loadFile();
  if (!f?.secret || !Array.isArray(f.recovery) || !f.recovery.length) return false;
  const h = Buffer.from(hash(normCode(given)));
  const hit = f.recovery.some(
    (x) => typeof x === "string" && x.length === h.length && crypto.timingSafeEqual(Buffer.from(x), h),
  );
  if (!hit) return false;
  fs.rmSync(FILE, { force: true });
  used.delete(f.secret);
  return true;
}

export function disable(given) {
  const secret = saved();
  if (!secret || !check(secret, given)) return false;
  fs.rmSync(FILE, { force: true });
  return true;
}
