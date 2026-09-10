/**
 * Activity Monitor — per-session activity state machine with busy→quiet detection.
 *
 * Absorbed from webmux/purplemux (busy→quiet push), control-room/codeman
 * (activity-state classifier), tmux (monitor-activity/monitor-silence).
 *
 * States: "working" (output flowing), "quiet" (output stopped after activity),
 * "asking" (agent needs input), "done" (turn finished), "error".
 * Transitions are emitted so the server can broadcast and push-notify.
 */

const SWEEP_INTERVAL_MS = 5_000;

export function createActivityMonitor({ quietMs = 20_000, onEvent = () => {} } = {}) {
  const tracked = new Map(); // id -> { state, lastOutputAt, lastChangeAt, kind }
  let sweep = null;

  function emit(id, entry, state, extra = {}) {
    entry.state = state;
    entry.lastChangeAt = Date.now();
    onEvent({ id, state, kind: entry.kind, ...extra });
  }

  function ensure(id, kind) {
    let entry = tracked.get(id);
    if (!entry) {
      entry = { state: "idle", lastOutputAt: 0, lastChangeAt: Date.now(), kind };
      tracked.set(id, entry);
    }
    entry.kind = kind;
    return entry;
  }

  // PTY output — called on every terminal chunk.
  function feed(id, text) {
    if (!text) return;
    const entry = ensure(id, "terminal");
    entry.lastOutputAt = Date.now();
    if (entry.state !== "working") emit(id, entry, "working");
  }

  // Chat lifecycle — chatstate transitions arrive here.
  function markChat(id, state) {
    const entry = ensure(id, "chat");
    if (state === "running") {
      entry.lastOutputAt = Date.now();
      emit(id, entry, "working");
    } else if (state === "waiting") {
      emit(id, entry, "asking");
    } else if (state === "idle") {
      emit(id, entry, "done");
    } else if (state === "error") {
      emit(id, entry, "error");
    }
  }

  function forget(id) {
    tracked.delete(id);
  }

  function start() {
    if (sweep) return;
    sweep = setInterval(() => {
      const now = Date.now();
      for (const [id, entry] of tracked) {
        if (entry.state === "working" && now - entry.lastOutputAt > quietMs) {
          emit(id, entry, "quiet", { waitedMs: now - entry.lastOutputAt });
        }
      }
    }, SWEEP_INTERVAL_MS);
    sweep.unref?.();
  }

  function stop() {
    if (sweep) clearInterval(sweep);
    sweep = null;
  }

  function summary() {
    return [...tracked.entries()].map(([id, e]) => ({
      id, kind: e.kind, state: e.state,
      idleMs: e.lastOutputAt ? Date.now() - e.lastOutputAt : null,
    }));
  }

  function get(id) {
    const e = tracked.get(id);
    return e ? { id, kind: e.kind, state: e.state, idleMs: e.lastOutputAt ? Date.now() - e.lastOutputAt : null } : null;
  }

  return { feed, markChat, forget, start, stop, summary, get };
}
