/**
 * Quiet Hours — focus mode / do-not-disturb for notifications.
 *
 * Absorbed from marchat (quiet hours) and shooter (priority tiers): outside
 * scheduled windows nothing is pushed; decision-first events (permission
 * requests) can still break through when "priority only" mode is on.
 *
 * Windows are "HH:MM-HH:MM" (24h, local time). Persisted to
 * POCKETDESK_DATA/quiet-hours.json so the schedule survives restarts.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR = process.env.POCKETDESK_DATA || ".pocketdesk";
const STORE = path.join(os.homedir(), DATA_DIR, "quiet-hours.json");

const state = {
  mode: "off", // off | priority | silent
  windows: [], // ["22:00-07:30", ...]
};

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE, "utf8"));
    if (parsed && typeof parsed === "object") {
      state.mode = ["off", "priority", "silent"].includes(parsed.mode) ? parsed.mode : "off";
      state.windows = Array.isArray(parsed.windows) ? parsed.windows.filter((w) => /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(w)).slice(0, 12) : [];
    }
  } catch {}
}

function save() {
  try {
    fs.mkdirSync(path.dirname(STORE), { recursive: true });
    fs.writeFileSync(STORE, JSON.stringify(state, null, 2));
  } catch {}
}

load();

function toMinutes(hhmm) {
  const [h, m] = hhmm.split(":").map(Number);
  return h * 60 + m;
}

export function inQuietWindow(now = new Date()) {
  const cur = now.getHours() * 60 + now.getMinutes();
  for (const w of state.windows) {
    const [a, b] = w.split("-");
    const start = toMinutes(a);
    const end = toMinutes(b);
    const within = start <= end ? cur >= start && cur < end : cur >= start || cur < end;
    if (within) return { active: true, window: w };
  }
  return { active: false, window: null };
}

/**
 * Decide whether a notification should be delivered right now.
 * eventType "permission_request"/"ask_user" counts as decision-first.
 */
export function shouldDeliver(eventType) {
  if (state.mode === "off") return { deliver: true, reason: null };
  const { active } = inQuietWindow();
  if (!active) return { deliver: true, reason: null };
  if (state.mode === "priority" && (eventType === "permission_request" || eventType === "ask_user")) {
    return { deliver: true, reason: "priority_bypass" };
  }
  return { deliver: false, reason: state.mode === "silent" ? "quiet_hours_silent" : "quiet_hours" };
}

export function setMode(mode) {
  if (!["off", "priority", "silent"].includes(mode)) return { ok: false, error: "mode must be off|priority|silent" };
  state.mode = mode;
  save();
  return { ok: true, ...getState() };
}

export function setWindows(windows) {
  const list = (Array.isArray(windows) ? windows : []).filter((w) => typeof w === "string" && /^\d{1,2}:\d{2}-\d{1,2}:\d{2}$/.test(w)).slice(0, 12);
  state.windows = list;
  save();
  return { ok: true, ...getState() };
}

export function getState() {
  return { ...state, ...inQuietWindow() };
}
