/**
 * Approval Guard — run-level approval timeouts that auto-deny.
 *
 * Absorbed from cc-pocket (approval timeout → auto-deny so an unattended
 * agent never stalls forever): the proposal system already expires pending
 * proposals; this module adds the *run* dimension — when an agent enters the
 * "waiting" (needs-permission) state, a countdown starts and if no approval
 * arrives within the window the waiting chat is cancelled and marked, so the
 * next queued prompt (prompt_queue) can flow.
 *
 * Env: RH_APPROVAL_TIMEOUT_MS (default 120000; 0 disables).
 */

const DEFAULT_TIMEOUT_MS = Number(process.env.RH_APPROVAL_TIMEOUT_MS) || 120_000;

const waiting = new Map(); // chatId -> { since, timer }
let timeoutMs = DEFAULT_TIMEOUT_MS;
let onAutoDeny = null; // async ({ chatId, waitedMs }) — injected by server

export function setTimeoutMs(ms) {
  timeoutMs = Math.max(0, Number(ms) || 0);
}

export function getTimeoutMs() {
  return timeoutMs;
}

/** Called by the server when a chat enters the waiting state. */
export function markWaiting(chatId) {
  if (timeoutMs <= 0 || waiting.has(chatId)) return;
  const timer = setTimeout(() => {
    waiting.delete(chatId);
    const cb = onAutoDeny;
    if (cb) Promise.resolve().then(() => cb({ chatId, waitedMs: timeoutMs })).catch(() => {});
  }, timeoutMs);
  timer.unref?.();
  waiting.set(chatId, { since: Date.now(), timer });
}

/** Called when the chat leaves waiting (approved, resumed, idle, error). */
export function clearWaiting(chatId) {
  const entry = waiting.get(chatId);
  if (!entry) return;
  clearTimeout(entry.timer);
  waiting.delete(chatId);
}

/** Live snapshot for UI: which chats are on the auto-deny countdown. */
export function listWaiting() {
  const now = Date.now();
  return [...waiting.entries()].map(([chatId, e]) => ({
    chatId,
    since: e.since,
    denyAt: e.since + timeoutMs,
    remainingMs: Math.max(0, e.since + timeoutMs - now),
  }));
}

export function onAutoDenyCallback(cb) {
  onAutoDeny = cb;
}
