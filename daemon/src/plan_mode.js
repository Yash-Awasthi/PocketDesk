/**
 * Plan Mode — structured plan extraction + approval (absorbed from 1code:
 * "Plan Mode — structured plans with markdown preview").
 *
 * Extracts the newest markdown checklist (`- [ ]` / `- [x]`) from a chat's
 * assistant messages as the agent's plan, tracks whether the user approved
 * it, and lets the phone render a plan preview before telling the agent to
 * proceed (plan approval is conveyed back to the agent as a normal message,
 * so it works with any CLI without protocol support).
 */

import { get } from "./chat.js";

function findPlan(c) {
  for (let i = c.transcript.length - 1; i >= 0; i--) {
    const it = c.transcript[i];
    if (it.role !== "assistant") continue;
    const items = [];
    for (const line of String(it.text).split(/\r?\n/)) {
      const m = line.match(/^\s*[-*]\s+\[([ xX])\]\s+(.*)$/);
      if (m) items.push({ text: m[2].trim(), done: m[1] !== " " });
    }
    if (items.length) {
      const markdown = it.text;
      const doneCount = items.filter((x) => x.done).length;
      return { items, markdown, progress: items.length ? Math.round((doneCount / items.length) * 100) : 0 };
    }
  }
  return null;
}

export function getPlan(id) {
  const c = get(id);
  if (!c) return { ok: false, error: `no such chat: ${id}` };
  const plan = findPlan(c);
  return {
    ok: true,
    id,
    plan,
    approved: Boolean(c.planApproved),
  };
}

export function approve(id, approved) {
  const c = get(id);
  if (!c) return { ok: false, error: `no such chat: ${id}` };
  c.planApproved = Boolean(approved);
  return { ok: true, id, approved: c.planApproved };
}
