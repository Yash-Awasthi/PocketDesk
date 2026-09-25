/**
 * Devices — client device registry with last-seen and revocation.
 *
 * Absorbed from openchamber / netbird (device list + revoke): every
 * authenticating client (phone, browser, share viewer) registers under a
 * stable client id; the phone can list all devices that ever connected, see
 * which are live, and revoke one — revoked ids are refused at hello with 4003.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = process.env.POCKETDESK_DATA || ".pocketdesk";
const STORE = path.join(os.homedir(), DATA_DIR, "devices.json");

const devices = new Map(); // clientId -> { id, name, platform, firstSeen, lastSeen, lastIp, revoked }
let dirty = 0;

function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(STORE, "utf8"));
    for (const d of Array.isArray(arr) ? arr : []) devices.set(d.id, d);
  } catch {}
}

function save() {
  try {
    fs.mkdirSync(path.dirname(STORE), { recursive: true });
    fs.writeFileSync(STORE, JSON.stringify([...devices.values()], null, 2));
  } catch {}
}

load();

/** Stable fingerprint for a client: token-hash + declared name/platform. */
export function fingerprint(token, name, platform) {
  return crypto.createHash("sha256").update(`${token}|${name}|${platform}`).digest("hex").slice(0, 16);
}

export function register(clientId, { name, platform, ip }) {
  const id = String(clientId || fingerprint("anon", name, platform));
  const now = Date.now();
  const existing = devices.get(id);
  if (existing) {
    existing.lastSeen = now;
    if (ip) existing.lastIp = ip;
    if (name) existing.name = name;
    if (platform) existing.platform = platform;
  } else {
    devices.set(id, {
      id,
      name: name || "unknown device",
      platform: platform || "unknown",
      firstSeen: now,
      lastSeen: now,
      lastIp: ip || null,
      revoked: false,
    });
  }
  if (++dirty % 5 === 0) save(); // periodic flush; also saved on revoke
  return devices.get(id);
}

const hash = (t) => crypto.createHash("sha256").update(String(t)).digest("hex");

/** Issue this device its own credential; only the hash is stored. */
export function issueToken(clientId) {
  const d = devices.get(String(clientId));
  if (!d) return null;
  const t = crypto.randomBytes(24).toString("base64url");
  d.tokenHash = hash(t);
  save();
  return t;
}

/** The live, unrevoked device a device token belongs to, or null. */
export function byToken(t) {
  if (typeof t !== "string" || !t) return null;
  const h = Buffer.from(hash(t));
  for (const d of devices.values()) {
    if (!d.revoked && d.tokenHash && crypto.timingSafeEqual(Buffer.from(d.tokenHash), h)) return d;
  }
  return null;
}

/**
 * Relay hellos carry a proof instead of the token: channel members can read
 * the frame, and binding the relay-assigned connId stops them replaying it.
 */
export function relayProof(tokenHash, nonce, from) {
  return crypto.createHmac("sha256", tokenHash).update(`${nonce}:${from}`).digest("hex");
}

export function proofMatches(proof, tokenHash, nonce, from) {
  if (typeof proof !== "string") return false;
  const want = Buffer.from(relayProof(tokenHash, nonce, from));
  const got = Buffer.from(proof);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}

export function byRelayProof(proof, nonce, from) {
  for (const d of devices.values()) {
    if (!d.revoked && d.tokenHash && proofMatches(proof, d.tokenHash, nonce, from)) return d;
  }
  return null;
}

export const hashToken = (t) => hash(t);

export function isRevoked(clientId) {
  const d = devices.get(String(clientId));
  return Boolean(d?.revoked);
}

export function revoke(clientId) {
  const d = devices.get(String(clientId));
  if (!d) return { ok: false, error: `unknown device: ${clientId}` };
  d.revoked = true;
  delete d.tokenHash;
  delete d.endpointId;
  save();
  return { ok: true, device: d };
}

/**
 * Binds a device to the iroh endpoint it first authenticated from. False when the
 * device is already bound to another key: its token is being used elsewhere.
 */
export function claimEndpoint(clientId, endpointId) {
  const d = devices.get(String(clientId));
  if (!d) return true;
  if (d.endpointId && d.endpointId !== endpointId) return false;
  if (!d.endpointId) { d.endpointId = endpointId; save(); }
  return true;
}

export function allow(clientId) {
  const d = devices.get(String(clientId));
  if (!d) return { ok: false, error: `unknown device: ${clientId}` };
  d.revoked = false;
  save();
  return { ok: true, device: d };
}

export function list() {
  const now = Date.now();
  return [...devices.values()].map(({ tokenHash, ...d }) => ({ ...d, online: now - d.lastSeen < 5 * 60_000 }));
}

export function touch(clientId) {
  const d = devices.get(String(clientId));
  if (d) d.lastSeen = Date.now();
}

export function persist() {
  save();
}
