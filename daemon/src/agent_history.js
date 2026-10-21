/**
 * Agent history: past conversations every coding agent on this PC saved to disk, listed per agent
 * and per app (CLI, VS Code, Cursor, ...) and read back as plain user/assistant turns.
 *
 *   claude       ~/.claude/projects/<project>/<session>.jsonl (CLI and the VS Code extension)
 *   codex        ~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl (CLI and the VS Code extension)
 *   copilot      <editor>/User/workspaceStorage/<hash>/chatSessions/*.jsonl, a mutation log
 *   cline / roo  <editor>/User/globalStorage/<extension>/tasks/<id>/ui_messages.json
 *   cursor       Cursor/User/globalStorage/state.vscdb, composerData:* and bubbleId:* rows
 *   antigravity  ~/.gemini/antigravity/conversation_summaries.db
 *
 * Only titles and text reach the phone; file paths stay in `refs`. AH_HOME and AH_USERDATA
 * relocate the roots (tests).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const home = () => process.env.AH_HOME || os.homedir();

/** Parent of every VS Code-family "<Name>/User" folder. */
function userDataRoot() {
  if (process.env.AH_USERDATA) return process.env.AH_USERDATA;
  if (process.platform === "win32") return process.env.APPDATA || path.join(home(), "AppData", "Roaming");
  if (process.platform === "darwin") return path.join(home(), "Library", "Application Support");
  return process.env.XDG_CONFIG_HOME || path.join(home(), ".config");
}

/** VS Code and its forks: folder name under the user-data root, label, and the gui manifest that opens it. */
const EDITORS = [
  ["Code", "VS Code", "vscode"],
  ["Code - Insiders", "VS Code Insiders", null],
  ["Cursor", "Cursor", "cursor"],
  ["Windsurf", "Windsurf", "windsurf"],
  ["Antigravity", "Antigravity", "antigravity"],
  ["VSCodium", "VSCodium", null],
  ["Trae", "Trae", null],
  ["Kiro", "Kiro", null],
];

const MAX_ITEMS = 400;
const MAX_TEXT = 20_000;
/** key "agent:id" -> what get() needs to read it back. Rebuilt by every list(). */
const refs = new Map();

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const mtime = (f) => { try { return fs.statSync(f).mtimeMs; } catch { return 0; } };
const lines = (f) => { try { return fs.readFileSync(f, "utf8").split("\n"); } catch { return []; } };
const parseLine = (l) => { try { return l.trim() ? JSON.parse(l) : null; } catch { return null; } };
const dirs = (d) => { try { return fs.readdirSync(d, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(d, e.name)); } catch { return []; } };
const files = (d, ext) => { try { return fs.readdirSync(d).filter((n) => n.endsWith(ext)).map((n) => path.join(d, n)); } catch { return []; } };
const clip = (s, n = 120) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);
const uriPath = (u) => { try { return u?.startsWith("file:") ? fileURLToPath(u) : u || ""; } catch { return ""; } };

/** First and last bytes of a file: enough for a session's header and its latest title. */
function headTail(f, n = 64 << 10) {
  try {
    const fd = fs.openSync(f, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const read = (at, len) => { const b = Buffer.alloc(len); fs.readSync(fd, b, 0, len, at); return b.toString("utf8"); };
      if (size <= 2 * n) return read(0, size).split("\n");
      // The cut lines at the seams are dropped: a half JSON line parses to nothing anyway.
      return [...read(0, n).split("\n").slice(0, -1), ...read(size - n, n).split("\n").slice(1)];
    } finally { fs.closeSync(fd); }
  } catch { return []; }
}

// A prompt the agent's harness injected, not one the user typed.
const SYNTHETIC = /^\s*<(local-command|command-|system-reminder|environment_context|user_instructions|ide_|bash-)/;

function textOf(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.filter((p) => p?.type === "text" || p?.type === "input_text" || p?.type === "output_text").map((p) => p.text).join("\n");
}

// ── Claude Code ─────────────────────────────────────────────────────────────
function claudeList() {
  const out = [];
  for (const proj of dirs(path.join(home(), ".claude", "projects"))) {
    for (const f of files(proj, ".jsonl")) {
      let cwd = "", entry = "", first = "", title = "";
      for (const o of headTail(f).map(parseLine)) {
        if (!o) continue;
        cwd ||= o.cwd || "";
        entry ||= o.entrypoint || "";
        if (o.type === "ai-title" && o.aiTitle) title = o.aiTitle;
        if (o.type === "summary" && o.summary) title ||= o.summary;
        if (!first && o.type === "user" && !o.isMeta) {
          const t = textOf(o.message?.content);
          if (t && !SYNTHETIC.test(t)) first = t;
        }
      }
      // A file with no typed prompt is a session that was opened and left.
      if (!first && !title) continue;
      const id = path.basename(f, ".jsonl");
      out.push({ agent: "claude", app: /vscode/i.test(entry) ? "VS Code" : "CLI", id, title: clip(title || first), cwd, updated: mtime(f), resumable: true, ref: f });
    }
  }
  return out;
}

function claudeGet(f) {
  const items = [];
  for (const o of lines(f).map(parseLine)) {
    if (!o || o.isMeta || o.isSidechain) continue;
    const content = o.message?.content;
    if (o.type === "user") {
      const t = textOf(content);
      if (t && !SYNTHETIC.test(t)) items.push({ role: "user", text: t });
    } else if (o.type === "assistant" && Array.isArray(content)) {
      for (const p of content) {
        if (p.type === "text" && p.text?.trim()) items.push({ role: "assistant", text: p.text });
        else if (p.type === "tool_use") items.push({ role: "tool", name: p.name, detail: clip(JSON.stringify(p.input ?? {}), 300) });
      }
    }
  }
  return items;
}

// ── Codex ───────────────────────────────────────────────────────────────────
function walk(d, ext, out = []) {
  for (const e of (() => { try { return fs.readdirSync(d, { withFileTypes: true }); } catch { return []; } })()) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p, ext, out);
    else if (e.name.endsWith(ext)) out.push(p);
  }
  return out;
}

function codexList() {
  const out = [];
  for (const f of walk(path.join(home(), ".codex", "sessions"), ".jsonl")) {
    let meta = null, first = "";
    for (const o of headTail(f).map(parseLine)) {
      if (o?.type === "session_meta") meta ||= o.payload;
      const p = o?.payload;
      if (!first && o?.type === "response_item" && p?.type === "message" && p.role === "user") {
        const t = textOf(p.content);
        if (t && !SYNTHETIC.test(t)) first = t;
      }
    }
    if (!meta?.id || !first) continue;
    out.push({ agent: "codex", app: /vscode/i.test(meta.originator || "") ? "VS Code" : "CLI", id: meta.id, title: clip(first), cwd: meta.cwd || "", updated: mtime(f), resumable: true, ref: f });
  }
  return out;
}

function codexGet(f) {
  const items = [];
  for (const o of lines(f).map(parseLine)) {
    const p = o?.payload;
    if (o?.type !== "response_item" || !p) continue;
    if (p.type === "message" && (p.role === "user" || p.role === "assistant")) {
      const t = textOf(p.content);
      if (t && !SYNTHETIC.test(t)) items.push({ role: p.role, text: t });
    } else if (p.type === "function_call" || p.type === "local_shell_call") {
      items.push({ role: "tool", name: p.name || "shell", detail: clip(p.arguments ?? JSON.stringify(p.action ?? {}), 300) });
    }
  }
  return items;
}

// ── VS Code family: Copilot Chat, Cline, Roo Code; Cursor's own chat ────────
function editors() {
  return EDITORS.map(([dir, label, gui]) => ({ user: path.join(userDataRoot(), dir, "User"), label, gui })).filter((e) => fs.existsSync(e.user));
}

/** Copilot keeps each chat as a log: kind 0 sets the whole state, 1 sets a path, 2 appends at a path (from index i), 3 deletes. */
export function replayChatLog(text) {
  let state = null;
  const at = (k) => k.slice(0, -1).reduce((o, key) => (o[key] ??= typeof key === "number" ? [] : {}), state);
  for (const op of text.split("\n").map(parseLine)) {
    if (!op) continue;
    if (op.kind === 0) { state = op.v; continue; }
    if (!state || !Array.isArray(op.k) || !op.k.length) continue;
    const parent = at(op.k);
    const last = op.k.at(-1);
    if (op.kind === 1) parent[last] = op.v;
    else if (op.kind === 2) {
      const arr = Array.isArray(parent[last]) ? parent[last] : (parent[last] = []);
      if (Number.isInteger(op.i)) arr.splice(op.i);
      arr.push(...(Array.isArray(op.v) ? op.v : [op.v]));
    } else if (op.kind === 3) delete parent[last];
  }
  return state;
}

function copilotSessions(ed) {
  const out = [];
  const add = (f, cwd) => out.push({ f, cwd });
  for (const ws of dirs(path.join(ed.user, "workspaceStorage"))) {
    const cwd = uriPath(readJson(path.join(ws, "workspace.json"))?.folder);
    for (const f of files(path.join(ws, "chatSessions"), ".jsonl")) add(f, cwd);
    for (const f of files(path.join(ws, "chatSessions"), ".json")) add(f, cwd);
  }
  for (const f of files(path.join(ed.user, "globalStorage", "emptyWindowChatSessions"), ".jsonl")) add(f, "");
  return out;
}

function copilotState(f) {
  if (f.endsWith(".json")) return readJson(f);
  try { return replayChatLog(fs.readFileSync(f, "utf8")); } catch { return null; }
}

function copilotList(ed) {
  const out = [];
  for (const { f, cwd } of copilotSessions(ed)) {
    const s = copilotState(f);
    const reqs = Array.isArray(s?.requests) ? s.requests : [];
    const first = reqs.map((r) => r?.message?.text).find(Boolean);
    if (!first) continue;
    out.push({ agent: "copilot", app: ed.label, gui: ed.gui, id: s.sessionId || path.basename(f).replace(/\.jsonl?$/, ""), title: clip(s.customTitle || first), cwd, updated: s.lastMessageDate || mtime(f), resumable: false, ref: f });
  }
  return out;
}

function copilotGet(f) {
  const items = [];
  for (const r of copilotState(f)?.requests ?? []) {
    if (r?.message?.text) items.push({ role: "user", text: r.message.text });
    const parts = Array.isArray(r?.response) ? r.response : [];
    const text = parts.map((p) => (typeof p?.value === "string" ? p.value : typeof p?.value?.value === "string" ? p.value.value : "")).join("");
    if (text.trim()) items.push({ role: "assistant", text });
  }
  return items;
}

const CLINE_LIKE = [["saoudrizwan.claude-dev", "cline"], ["rooveterinaryinc.roo-cline", "roo"]];

function clineList(ed) {
  const out = [];
  for (const [ext, agent] of CLINE_LIKE) {
    for (const t of dirs(path.join(ed.user, "globalStorage", ext, "tasks"))) {
      const f = path.join(t, "ui_messages.json");
      const msgs = readJson(f);
      const task = Array.isArray(msgs) ? msgs.find((m) => m.say === "task")?.text : null;
      if (!task) continue;
      out.push({ agent, app: ed.label, gui: ed.gui, id: path.basename(t), title: clip(task), cwd: "", updated: mtime(f), resumable: false, ref: f });
    }
  }
  return out;
}

function clineGet(f) {
  const items = [];
  for (const m of readJson(f) ?? []) {
    if (m?.type !== "say" || !m.text) continue;
    if (m.say === "task" || m.say === "user_feedback") items.push({ role: "user", text: m.text });
    else if (m.say === "text" || m.say === "completion_result") items.push({ role: "assistant", text: m.text });
  }
  return items;
}

/** node:sqlite (built into Node 24) opened read-only; null on older Node or a locked/missing file. */
async function sqlite(f) {
  if (!fs.existsSync(f)) return null;
  try {
    const { DatabaseSync } = await import("node:sqlite");
    return new DatabaseSync(f, { readOnly: true });
  } catch { return null; }
}

async function cursorList(ed) {
  if (ed.label !== "Cursor") return [];
  const f = path.join(ed.user, "globalStorage", "state.vscdb");
  const db = await sqlite(f);
  if (!db) return [];
  try {
    const out = [];
    for (const row of db.prepare("SELECT key, value FROM cursorDiskKV WHERE key LIKE 'composerData:%'").all()) {
      const c = (() => { try { return JSON.parse(String(row.value)); } catch { return null; } })();
      if (!c?.composerId) continue;
      const heads = c.fullConversationHeadersOnly ?? c.conversation ?? [];
      if (!heads.length) continue;
      out.push({ agent: "cursor", app: "Cursor", gui: "cursor", id: c.composerId, title: clip(c.name || heads.find((h) => h.type === 1)?.text || "Cursor chat"), cwd: "", updated: c.lastUpdatedAt || c.createdAt || 0, resumable: false, ref: f });
    }
    return out;
  } catch { return []; } finally { db.close(); }
}

async function cursorGet(f, id) {
  const db = await sqlite(f);
  if (!db) return [];
  try {
    const value = (key) => { const r = db.prepare("SELECT value FROM cursorDiskKV WHERE key = ?").get(key); try { return r ? JSON.parse(String(r.value)) : null; } catch { return null; } };
    const c = value(`composerData:${id}`);
    const bubbles = c?.conversation?.length ? c.conversation : (c?.fullConversationHeadersOnly ?? []).map((h) => value(`bubbleId:${id}:${h.bubbleId}`) ?? h);
    return bubbles.filter((b) => b?.text?.trim()).map((b) => ({ role: b.type === 1 ? "user" : "assistant", text: b.text }));
  } catch { return []; } finally { db.close(); }
}

// ── Antigravity ─────────────────────────────────────────────────────────────
const agyDb = () => path.join(home(), ".gemini", "antigravity", "conversation_summaries.db");

async function antigravityList() {
  const db = await sqlite(agyDb());
  if (!db) return [];
  try {
    return db.prepare("SELECT conversation_id, title, preview, workspace_uris, last_modified_time FROM conversation_summaries").all().map((r) => {
      let cwd = "";
      try { cwd = uriPath(JSON.parse(r.workspace_uris)?.[0]); } catch {}
      return { agent: "antigravity", app: "Antigravity", gui: "antigravity", id: r.conversation_id, title: clip(r.title || r.preview || "Antigravity conversation"), cwd, updated: Date.parse(String(r.last_modified_time).replace(" ", "T").replace(/(\.\d{3})\d+/, "$1")) || 0, resumable: false, ref: agyDb() };
    });
  } catch { return []; } finally { db.close(); }
}

/** The search index keeps each conversation as chunks of user and agent text; one turn pair per chunk. */
async function antigravityGet(f, id) {
  const db = await sqlite(f);
  if (!db) return [];
  try {
    const items = [];
    for (const r of db.prepare("SELECT user_body, agent_body FROM conversations_fts WHERE conversation_id = ? ORDER BY CAST(chunk_index AS INTEGER)").all(id)) {
      if (String(r.user_body ?? "").trim()) items.push({ role: "user", text: String(r.user_body) });
      if (String(r.agent_body ?? "").trim()) items.push({ role: "assistant", text: String(r.agent_body) });
    }
    return items;
  } catch { return []; } finally { db.close(); }
}

// ── Public ──────────────────────────────────────────────────────────────────
const GETTERS = { claude: claudeGet, codex: codexGet, copilot: copilotGet, cline: clineGet, roo: clineGet, cursor: cursorGet, antigravity: antigravityGet };

/** Every saved conversation, newest first; `agent` narrows it to one agent. */
export async function list(agent = null) {
  const found = [];
  const want = (a) => !agent || agent === a;
  if (want("claude")) found.push(...claudeList());
  if (want("codex")) found.push(...codexList());
  if (want("antigravity")) found.push(...(await antigravityList()));
  for (const ed of editors()) {
    if (want("copilot")) found.push(...copilotList(ed));
    if (want("cline") || want("roo")) found.push(...clineList(ed));
    if (want("cursor")) found.push(...(await cursorList(ed)));
  }
  found.sort((a, b) => b.updated - a.updated);
  const items = found.slice(0, MAX_ITEMS);
  if (!agent) refs.clear();
  for (const it of items) refs.set(`${it.agent}:${it.id}`, it);
  return items.map(({ ref, ...it }) => it);
}

/** The summary and turns of one conversation, or null when it is not on this PC (any more). */
export async function get(agent, id) {
  const key = `${agent}:${id}`;
  if (!refs.has(key)) await list(agent);
  const it = refs.get(key);
  const read = GETTERS[agent];
  if (!it || !read) return null;
  const items = (await read(it.ref, id)).map((x) => (x.text?.length > MAX_TEXT ? { ...x, text: x.text.slice(0, MAX_TEXT) + "…" } : x));
  const { ref, ...summary } = it;
  return { ...summary, items: items.slice(-MAX_ITEMS) };
}
