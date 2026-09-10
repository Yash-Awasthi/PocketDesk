/**
 * Agent Todos — live task lists of a running session.
 *
 * Absorbed from c9watch / claude-threads / codeman (watch the agent's plan:
 * pending/in_progress/completed items pushed live as the agent works).
 *
 * The daemon also derives a todo list automatically: whenever a chat turn
 * finishes, the assistant transcript tail is scanned for markdown task items
 * ("- [ ]"/"- [x]") so agents that plan in plain markdown show up in the UI
 * without any client-side parsing.
 */

const MAX_ITEMS = 200;

const boards = new Map(); // sessionId -> [{ id, content, status }]

function normalizeStatus(s) {
  const v = String(s || "pending").toLowerCase();
  if (v === "in_progress" || v === "inprogress" || v === "active") return "in_progress";
  if (v === "completed" || v === "done" || v === "x") return "completed";
  return "pending";
}

export function setTodos(sessionId, items) {
  const list = (Array.isArray(items) ? items : [])
    .slice(0, MAX_ITEMS)
    .map((it, i) => ({
      id: String(it?.id ?? "t" + (i + 1)),
      content: String(it?.content ?? "").slice(0, 500),
      status: normalizeStatus(it?.status),
    }));
  boards.set(String(sessionId), list);
  return list;
}

export function getTodos(sessionId) {
  return [...(boards.get(String(sessionId)) ?? [])];
}

export function updateStatus(sessionId, todoId, status) {
  const list = boards.get(String(sessionId));
  if (!list) return null;
  const item = list.find((t) => t.id === todoId);
  if (!item) return null;
  item.status = normalizeStatus(status);
  return item;
}

// ── Derived todos: markdown task items from the last assistant message ──────

const TODO_RE = /^\s*[-*+]\s+\[( |x|X)\]\s+(.+)$/;

/** Extract markdown checkboxes from assistant text; returns [] when none. */
export function fromMarkdown(text) {
  const items = [];
  for (const line of String(text || "").split(/\r?\n/)) {
    const m = line.match(TODO_RE);
    if (m) items.push({ content: m[2].trim().slice(0, 500), status: m[1].toLowerCase() === "x" ? "completed" : "pending" });
  }
  return items;
}

/**
 * Called by the server when a chat turn finishes: replaces the derived board
 * if the final assistant message carries markdown checkboxes. Returns the
 * (possibly empty) board so the caller can broadcast.
 */
export function observeTurnEnd(sessionId, transcript) {
  for (let i = transcript.length - 1; i >= 0; i--) {
    const it = transcript[i];
    if (it.role === "assistant") {
      const items = fromMarkdown(it.text);
      if (items.length) {
        const existing = boards.get(String(sessionId));
        if (JSON.stringify(existing ?? []) !== JSON.stringify(items.map((x, i) => ({ id: "t" + (i + 1), content: x.content, status: x.status })))) {
          return setTodos(sessionId, items.map((x, i) => ({ id: "t" + (i + 1), content: x.content, status: x.status })));
        }
        return getTodos(sessionId);
      }
      return getTodos(sessionId);
    }
  }
  return getTodos(sessionId);
}

export function summary() {
  const out = [];
  for (const [sid, list] of boards) {
    if (list.length) out.push({ sessionId: sid, total: list.length, completed: list.filter((t) => t.status === "completed").length });
  }
  return out;
}
