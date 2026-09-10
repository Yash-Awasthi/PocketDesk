/**
 * Live Digest — plain-text digest attach mode.
 *
 * Absorbed from mcp-interactive-terminal (read-only plain-text render to save
 * tokens): a subscriber that receives ANSI-stripped plain rows of the terminal
 * instead of raw escape-sequence bytes. The phone can attach in digest mode to
 * read long-running output cheaply, or downgrade to full raw mode later.
 *
 * Builds on TerminalRenderer (restty digest render, already wired).
 */

import { TerminalRenderer } from "./terminal_renderer.js";

const FLUSH_INTERVAL_MS = 400;
const MIN_DELTA_ROWS = 1;

const digesters = new Map(); // sessionId -> { renderer, lastRows, subs:Set, dirty }
let timer = null;

function stripAnsi(s) {
  return s.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").replace(/\x1b\][^\x07]*\x07/g, "");
}

function snapshot(d) {
  const rows = d.renderer.getScreen().map((row) => stripAnsi(row).replace(/\s+$/, ""));
  while (rows.length > 0 && rows[rows.length - 1] === "") rows.pop();
  return rows;
}

export function attach(sessionId, ws, { cols = 80, rows = 24 } = {}) {
  let d = digesters.get(sessionId);
  if (!d) {
    d = { renderer: new TerminalRenderer({ cols, rows }), lastRows: [], subs: new Set(), dirty: false };
    digesters.set(sessionId, d);
  }
  d.subs.add(ws);
  if (!ws._subs) ws._subs = new Set();
  ws._subs.add("digest:" + sessionId);
  // Initial full snapshot
  const snap = snapshot(d);
  sendRows(ws, sessionId, snap, snap.length, true);
  startSweeper();
  return true;
}

export function detach(ws, sessionId) {
  if (sessionId) {
    const d = digesters.get(sessionId);
    if (d) d.subs.delete(ws);
    ws._subs?.delete("digest:" + sessionId);
    return;
  }
  for (const key of ws._subs ?? []) {
    if (key.startsWith("digest:")) {
      const sid = key.slice(7);
      const d = digesters.get(sid);
      if (d) d.subs.delete(ws);
      ws._subs.delete(key);
    }
  }
}

export function hasSubscribers(sessionId) {
  const d = digesters.get(sessionId);
  return Boolean(d && d.subs.size);
}

/** Called from the server's PTY output tap. */
export function feed(sessionId, rawText) {
  const d = digesters.get(sessionId);
  if (!d || !d.subs.size) return;
  d.renderer.feed(rawText);
  d.dirty = true;
}

function sendRows(ws, sessionId, rows, width, full) {
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: "digest_rows", sessionId, rows, width, full }));
}

function sweep() {
  for (const [sid, d] of digesters) {
    if (!d.dirty || !d.subs.size) {
      if (!d.subs.size) digesters.delete(sid);
      continue;
    }
    const snap = snapshot(d);
    // Diff against last sent: send only changed rows (index + text).
    const changed = [];
    const prev = d.lastRows;
    const maxLen = Math.max(prev.length, snap.length);
    for (let i = 0; i < maxLen; i++) {
      if (prev[i] !== snap[i]) changed.push({ row: i, text: snap[i] ?? "" });
    }
    if (changed.length >= MIN_DELTA_ROWS) {
      for (const ws of d.subs) {
        if (ws.readyState === 1) ws.send(JSON.stringify({ type: "digest_rows", sessionId: sid, rows: snap, changed, width: d.renderer.cols, full: false }));
      }
      d.lastRows = snap;
    }
    d.dirty = false;
  }
}

function startSweeper() {
  if (timer) return;
  timer = setInterval(sweep, FLUSH_INTERVAL_MS);
  timer.unref?.();
}

export function stop() {
  if (timer) clearInterval(timer);
  timer = null;
  digesters.clear();
}
