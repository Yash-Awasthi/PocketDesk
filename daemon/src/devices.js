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

export function isRevoked(clientId) {
  const d = devices.get(String(clientId));
  return Boolean(d?.revoked);
}

export function revoke(clientId) {
  const d = devices.get(String(clientId));
  if (!d) return { ok: false, error: `unknown device: ${clientId}` };
  d.revoked = true;
  save();
  return { ok: true, device: d };
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
  return [...devices.values()].map((d) => ({ ...d, online: now - d.lastSeen < 5 * 60_000 }));
}

export function touch(clientId) {
  const d = devices.get(String(clientId));
  if (d) d.lastSeen = Date.now();
}

export function persist() {
  save();
}
