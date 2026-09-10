import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DATA_DIR = process.env.POCKETDESK_DATA || ".pocketdesk";
const STORE_FILE = path.join(os.homedir(), DATA_DIR, "sessions.json");

let store = { sessions: [], version: 1 };

function load() {
  try {
    if (fs.existsSync(STORE_FILE)) {
      store = JSON.parse(fs.readFileSync(STORE_FILE, "utf8"));
    }
  } catch {}
}

function save() {
  try {
    const dir = path.dirname(STORE_FILE);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(STORE_FILE, JSON.stringify(store, null, 2));
  } catch {}
}

export function init() {
  load();
}

export function upsert(id, data) {
  const existing = store.sessions.find((s) => s.id === id);
  if (existing) {
    Object.assign(existing, data, { updated_at: Date.now() });
  } else {
    store.sessions.push({ id, created_at: Date.now(), updated_at: Date.now(), ...data });
  }
  save();
}

export function remove(id) {
  store.sessions = store.sessions.filter((s) => s.id !== id);
  save();
}

export function get(id) {
  return store.sessions.find((s) => s.id === id) || null;
}

export function list() {
  return store.sessions;
}

export function setStatus(id, status, reason) {
  const s = store.sessions.find((s) => s.id === id);
  if (s) {
    s.status = status;
    s.status_reason = reason || null;
    s.last_status_change = Date.now();
    s.updated_at = Date.now();
    save();
  }
}
