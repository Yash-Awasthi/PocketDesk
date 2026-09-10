/**
 * Env Profiles — per-chat environment overrides ("BYOK").
 *
 * Absorbed from 1code (custom models & providers — bring your own API keys)
 * and Claude-websocket / The Vibe Companion (environment profiles stored per
 * project in ~/.companion/envs/): named sets of env vars (API keys, model
 * endpoints, provider config) that can be attached to any chat. The chat's
 * agent process then runs with those vars layered over the daemon's env.
 *
 * Persisted to POCKETDESK_DATA/env-profiles.json.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import * as chat from "./chat.js";

const DATA_DIR = process.env.POCKETDESK_DATA || ".pocketdesk";
const FILE = path.join(os.homedir(), DATA_DIR, "env-profiles.json");

const profiles = new Map(); // name -> { name, vars }

function load() {
  if (profiles.size) return;
  try {
    for (const p of JSON.parse(fs.readFileSync(FILE, "utf8"))) profiles.set(p.name, p);
  } catch {}
}

function save() {
  try {
    fs.mkdirSync(path.dirname(FILE), { recursive: true });
    fs.writeFileSync(FILE, JSON.stringify([...profiles.values()], null, 2));
  } catch {}
}

export function list() {
  load();
  return [...profiles.values()].map((p) => ({ name: p.name, keys: Object.keys(p.vars ?? {}) }));
}

export function set(name, vars) {
  if (!name || typeof name !== "string") return { ok: false, error: "name required" };
  if (!vars || typeof vars !== "object") return { ok: false, error: "vars object required" };
  load();
  profiles.set(name, { name, vars: { ...vars } });
  save();
  return { ok: true };
}

export function remove(name) {
  load();
  if (!profiles.has(name)) return { ok: false, error: `no such profile: ${name}` };
  profiles.delete(name);
  save();
  return { ok: true };
}

/** Attach profile `name` to chat `id` — its next turn runs with these vars. */
export function attach(id, name) {
  load();
  const p = profiles.get(name);
  if (!p) return { ok: false, error: `no such profile: ${name}` };
  const c = chat.get(id);
  if (!c) return { ok: false, error: `no such chat: ${id}` };
  c.env = { ...p.vars };
  c.envProfile = name;
  return { ok: true, id, profile: name, keys: Object.keys(p.vars) };
}

export function detach(id) {
  const c = chat.get(id);
  if (!c) return { ok: false, error: `no such chat: ${id}` };
  c.env = null;
  c.envProfile = null;
  return { ok: true, id };
}
