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
import { writeFileAtomic } from "./atomic_write.js";

const DATA_DIR = process.env.POCKETDESK_DATA || ".pocketdesk";
const STORE = path.resolve(os.homedir(), DATA_DIR, "devices.json");

const devices = new Map(); // clientId -> { id, name, platform, firstSeen, lastSeen, lastIp, revoked }
let dirty = 0;
// A device token never expires while the device keeps connecting (every hello touches lastSeen),
// so an active pairing is never disrupted — only a token nobody has used in this long goes dead,
// which caps how long a stolen-but-unused token stays a standing credential.
const IDLE_EXPIRE_MS = 90 * 24 * 3600_000;

function load() {
  try {
    const arr = JSON.parse(fs.readFileSync(STORE, "utf8"));
    for (const d of Array.isArray(arr) ? arr : []) devices.set(d.id, d);
  } catch {}
}

function save() {
  try {
    fs.mkdirSync(path.dirname(STORE), { recursive: true, mode: 0o700 });
    writeFileAtomic(STORE, JSON.stringify([...devices.values()], null, 2), { mode: 0o600 });
  } catch {}
}

load();

/** Stable fingerprint for a client: token-hash + declared name/platform. */
export function fingerprint(token, name, platform) {
  return crypto.createHash("sha256").update(`${token}|${name}|${platform}`).digest("hex").slice(0, 16);
}

export function register(clientId, { name, platform, ip, transport }) {
  const id = String(clientId || fingerprint("anon", name, platform));
  const now = Date.now();
  const existing = devices.get(id);
  if (existing) {
    existing.lastSeen = now;
    if (ip) existing.lastIp = ip;
    if (name) existing.name = name;
    if (platform) existing.platform = platform;
    if (transport) existing.transport = transport;
  } else {
    devices.set(id, {
      id,
      name: name || "unknown device",
      platform: platform || "unknown",
      firstSeen: now,
      lastSeen: now,
      lastIp: ip || null,
      transport: transport || null,
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
  d.cred = (d.cred || 0) + 1;
  save();
  return t;
}

/** Generation of this device's credential: bumps on every issue and every revoke. */
export function credVersion(clientId) {
  return devices.get(String(clientId))?.cred || 0;
}

/** The live, unrevoked device a device token belongs to, or null. */
export function byToken(t) {
  if (typeof t !== "string" || !t) return null;
  const h = Buffer.from(hash(t));
  for (const d of devices.values()) {
    if (!d.revoked && d.tokenHash && crypto.timingSafeEqual(Buffer.from(d.tokenHash), h)) {
      if (Date.now() - d.lastSeen > IDLE_EXPIRE_MS) {
        d.revoked = true;
        delete d.tokenHash;
        save();
        return null;
      }
      return d;
    }
  }
  return null;
}

export function hasToken(clientId) {
  return Boolean(devices.get(String(clientId))?.tokenHash);
}

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
  d.cred = (d.cred || 0) + 1;
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
  if (!d.endpointId) {
    d.endpointId = endpointId;
    save();
  }
  return true;
}

// Free text the owner attaches to a device; stored beside the device so it follows a re-pair.
export function setNote(clientId, note) {
  const d = devices.get(String(clientId));
  if (!d) return { ok: false, error: `unknown device: ${clientId}` };
  const text = String(note ?? "")
    .trim()
    .slice(0, 200);
  if (text) d.note = text;
  else delete d.note;
  save();
  const { tokenHash: _tokenHash, cred: _cred, ...pub } = d;
  return { ok: true, device: pub };
}

export function allow(clientId) {
  const d = devices.get(String(clientId));
  if (!d) return { ok: false, error: `unknown device: ${clientId}` };
  d.revoked = false;
  save();
  return { ok: true, device: d };
}

// Revoked-only: deleting a live device's record would drop the token hash that keeps it paired.
export function remove(clientId) {
  const d = devices.get(String(clientId));
  if (!d) return { ok: false, error: `unknown device: ${clientId}` };
  if (!d.revoked) return { ok: false, error: "revoke the device before removing it" };
  devices.delete(String(clientId));
  save();
  return { ok: true };
}

export function list() {
  const now = Date.now();
  return [...devices.values()].map(({ tokenHash, cred, ...d }) => ({
    ...d,
    online: now - d.lastSeen < 5 * 60_000,
  }));
}

/** The timestamped events this store actually holds: first pairing and last connection. */
export function audit() {
  const out = [];
  for (const d of devices.values()) {
    const name = d.name || "unknown device";
    if (d.firstSeen)
      out.push({ at: d.firstSeen, kind: "pairing", text: `${name} paired (${d.platform || "unknown"})` });
    if (d.lastSeen && d.lastSeen !== d.firstSeen)
      out.push({
        at: d.lastSeen,
        kind: "device",
        text: `${name} connected${d.transport ? ` over ${d.transport}` : ""}`,
      });
  }
  return out.sort((a, b) => b.at - a.at);
}

export function touch(clientId) {
  const d = devices.get(String(clientId));
  if (d) d.lastSeen = Date.now();
}

export function persist() {
  save();
}
