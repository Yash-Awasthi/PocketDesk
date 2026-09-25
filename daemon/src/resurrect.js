/**
 * Chat Resurrection — survive daemon restarts by remembering chat sessions.
 *
 * Absorbed from zellij resurrection / tmux-resurrect (restore after crash)
 * and polpo (session auto-discovery). PTY processes can't survive a restart,
 * but chat sessions can: the record (harness, cwd) is persisted, and `resume`
 * re-opens the conversation via the manifest's resumeArgs (--continue /
 * exec resume --last), which the agent CLIs resolve from their own history.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const DATA_DIR = process.env.POCKETDESK_DATA || ".pocketdesk";
const STORE = path.join(os.homedir(), DATA_DIR, "resurrect.json");

function load() {
  try {
    return JSON.parse(fs.readFileSync(STORE, "utf8"));
  } catch {
    return [];
  }
}

function save(records) {
  try {
    fs.mkdirSync(path.dirname(STORE), { recursive: true });
    fs.writeFileSync(STORE, JSON.stringify(records.slice(-200), null, 2));
  } catch {}
}

export function upsert({ id, harnessId, cwd, name, cliSession }) {
  const records = load().filter((r) => r.id !== id);
  records.push({ id, harnessId, cwd, name: name || "", cliSession: cliSession || null, lastActive: Date.now() });
  save(records);
}

export function touch(id, cliSession) {
  const records = load();
  const rec = records.find((r) => r.id === id);
  if (rec) {
    rec.lastActive = Date.now();
    if (cliSession) rec.cliSession = cliSession;
    save(records);
  }
}

export function remove(id) {
  save(load().filter((r) => r.id !== id));
}

export function list() {
  return load().sort((a, b) => b.lastActive - a.lastActive);
}

export function get(id) {
  return load().find((r) => r.id === id) || null;
}
