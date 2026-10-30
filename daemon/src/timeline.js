// SPDX-License-Identifier: GPL-3.0-or-later
// A searchable record of what moved between the phone and this PC: notifications, calls, texts,
// clipboard, files and screenshots. Kept in ~/.pocketdesk/timeline.jsonl for 7 days, at most
// 3000 entries, and cleared from the PC page. Idea from NectarLink's Timeline.
import fs from "node:fs";
import path from "node:path";
import { configDir } from "./config.js";

const FILE = path.join(configDir, "timeline.jsonl");
const KEEP_MS = 7 * 24 * 3600_000;
const MAX = 3000;
let items = null;
let listeners = new Set();

function load() {
  if (items) return items;
  items = [];
  try {
    for (const l of fs.readFileSync(FILE, "utf8").split("\n")) if (l) try { items.push(JSON.parse(l)); } catch {}
  } catch {}
  prune();
  return items;
}

function prune() {
  const cut = Date.now() - KEEP_MS;
  items = items.filter((e) => e.at >= cut).slice(-MAX);
}

let saveTimer = null;
function save() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      fs.mkdirSync(configDir, { recursive: true });
      fs.writeFileSync(FILE, items.map((e) => JSON.stringify(e)).join("\n") + "\n", { mode: 0o600 });
    } catch {}
  }, 1000);
  saveTimer.unref?.();
}

/** kind: notif | call | sms | clip | file | shot | pcnotif; text is what a search matches. */
export function add(kind, title, text = "", extra = {}) {
  load();
  const e = { at: Date.now(), kind, title: String(title || "").slice(0, 200), text: String(text || "").slice(0, 1000), ...extra };
  items.push(e);
  if (items.length > MAX + 100) prune();
  save();
  for (const fn of listeners) try { fn(e); } catch {}
  return e;
}

export function list({ q = "", kind = "", limit = 300 } = {}) {
  load();
  const words = String(q).toLowerCase().split(/\s+/).filter(Boolean);
  const out = [];
  for (let i = items.length - 1; i >= 0 && out.length < limit; i--) {
    const e = items[i];
    if (kind && e.kind !== kind) continue;
    const hay = `${e.title} ${e.text} ${e.app || ""}`.toLowerCase();
    if (words.every((w) => hay.includes(w))) out.push(e);
  }
  return out;
}

export function clear() {
  items = [];
  try { fs.rmSync(FILE, { force: true }); } catch {}
}

export function onAdd(fn) { listeners.add(fn); return () => listeners.delete(fn); }
