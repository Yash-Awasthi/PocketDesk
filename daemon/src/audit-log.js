/**
 * Audit Log — Record all actions for accountability.
 * Inspired by control-room's audit feature.
 */
import fs from "node:fs";
import path from "node:path";
import os from "node:os";

const DATA_DIR = process.env.POCKETDESK_DATA || ".pocketdesk";
const LOG_FILE = path.join(os.homedir(), DATA_DIR, "audit.log");

let enabled = true;

function ensureDir() {
  const dir = path.dirname(LOG_FILE);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

export function log(action, data) {
  if (!enabled) return;
  try {
    ensureDir();
    const entry = {
      timestamp: new Date().toISOString(),
      action,
      ...data,
    };
    fs.appendFileSync(LOG_FILE, JSON.stringify(entry) + "\n");
  } catch {}
}

export function getLog(limit = 100) {
  try {
    if (!fs.existsSync(LOG_FILE)) return [];
    const lines = fs.readFileSync(LOG_FILE, "utf8").split("\n").filter(Boolean);
    return lines.slice(-limit).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

export function clearLog() {
  try {
    if (fs.existsSync(LOG_FILE)) fs.writeFileSync(LOG_FILE, "");
  } catch {}
}
