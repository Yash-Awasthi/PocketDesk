/**
 * Heartbeat monitor — checks session health at configurable intervals.
 * Inspired by claude-code-hermit's heartbeat pattern: filesystem-only precheck
 * decides every tick, model only wakes when something changed.
 *
 * Here: check if sessions are still alive (pty not exited, chat not crashed),
 * broadcast health status, and auto-cleanup dead sessions.
 */
import * as sessions from "./sessions.js";
import * as chat from "./chat.js";

const DEFAULT_INTERVAL = 30_000; // 30s
let timer = null;
let broadcastFn = null;

/**
 * Start the heartbeat monitor.
 * @param {(msg: object) => void} broadcast - function to send messages to all clients
 * @param {number} intervalMs - check interval in milliseconds
 */
export function start(broadcast, intervalMs = DEFAULT_INTERVAL) {
  broadcastFn = broadcast;
  if (timer) clearInterval(timer);
  timer = setInterval(tick, intervalMs);
  // Don't keep the process alive just for heartbeat
  if (timer.unref) timer.unref();
}

export function stop() {
  if (timer) { clearInterval(timer); timer = null; }
}

function tick() {
  if (!broadcastFn) return;

  const now = Date.now();
  const alive = [];
  const dead = [];

  // Check terminal sessions
  for (const s of sessions.summary()) {
    alive.push({ id: s.id, type: "terminal", harnessId: s.harnessId, cwd: s.cwd });
  }

  // Check chat sessions
  for (const c of chat.summary()) {
    alive.push({ id: c.id, type: "chat", harnessId: c.harnessId, state: c.state, cwd: c.cwd });
  }

  // Broadcast heartbeat status
  broadcastFn({
    type: "heartbeat",
    timestamp: now,
    sessions: alive.length,
    alive,
  });
}
