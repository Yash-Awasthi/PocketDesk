// Monitor names and display order chosen on the PC, kept in monitors.json beside config.json so they
// survive restarts and are per machine. Capture indices never move; only the labels and the order the
// hub draws.
import fs from "node:fs";
import path from "node:path";
import { configDir } from "./config.js";
import { writeFileAtomic } from "./atomic_write.js";

/** Where the names and the order live: beside config.json, in the same private folder. */
export const prefsPath = (dir = configDir) => path.join(dir, "monitors.json");

/** A monitor's identity across replugs: its adapter and output, never its capture index. */
export function keyOf(m) {
  return m.adapter != null && m.output != null ? `${m.adapter}:${m.output}` : String(m.id ?? m.index ?? "");
}

/**
 * Saved names and order, or the empty defaults when the file is missing or unreadable.
 * Order entries are stable keys; an integer index is still honoured for files written before them.
 */
export function loadPrefs(dir = configDir) {
  const empty = { names: {}, order: [] };
  let raw;
  try {
    raw = JSON.parse(fs.readFileSync(prefsPath(dir), "utf8"));
  } catch {
    return empty;
  }
  if (!raw || typeof raw !== "object") return empty;
  const names = {};
  const saved = raw.names && typeof raw.names === "object" ? raw.names : {};
  for (const [k, v] of Object.entries(saved)) {
    if (typeof v !== "string") continue;
    const name = v.trim();
    if (name.length >= 1 && name.length <= 40) names[k] = name;
  }
  const order = Array.isArray(raw.order)
    ? raw.order.filter((i) => Number.isInteger(i) || (typeof i === "string" && i.length > 0))
    : [];
  return { names, order };
}

export function savePrefs(prefs, dir = configDir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const data = { names: prefs?.names || {}, order: prefs?.order || [] };
  writeFileAtomic(prefsPath(dir), JSON.stringify(data, null, 2), { mode: 0o600 });
}

/**
 * Each monitor gains the title the hub shows (saved name, else hardware name, else "Display N"), and
 * `order` lists the real capture indices in the chosen order, with new screens appended at the end.
 */
export function label(monitors, prefs) {
  const names = prefs?.names || {};
  const listed = monitors.map((m) => ({
    ...m,
    title: names[keyOf(m)] || m.name || `Display ${m.index + 1}`,
  }));
  const indexByKey = new Map(listed.map((m) => [keyOf(m), m.index]));
  const real = new Set(listed.map((m) => m.index));
  const order = [];
  for (const entry of prefs?.order || []) {
    const i = Number.isInteger(entry) ? entry : indexByKey.get(entry);
    if (real.has(i) && !order.includes(i)) order.push(i);
  }
  for (const i of [...real].sort((a, b) => a - b)) if (!order.includes(i)) order.push(i);
  return { monitors: listed, order };
}
