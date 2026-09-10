import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { spawn, execSync } from "node:child_process";

const IS_WIN = process.platform === "win32";
import { StringDecoder } from "node:string_decoder";
import { EventEmitter } from "node:events";
import { expand as expandMentions } from "./mentions.js";

// Chat lifecycle events (state transitions) — consumed by the activity monitor.
export const chatEvents = new EventEmitter();
chatEvents.setMaxListeners(50);

const DATA_DIR = process.env.POCKETDESK_DATA || ".pocketdesk";
const HISTORY_DIR = path.join(os.homedir(), DATA_DIR, "chat-history");

function ensureHistoryDir() {
  if (!fs.existsSync(HISTORY_DIR)) fs.mkdirSync(HISTORY_DIR, { recursive: true });
}

function saveHistory(c) {
  try {
    ensureHistoryDir();
    const file = path.join(HISTORY_DIR, `${c.id}.json`);
    fs.writeFileSync(file, JSON.stringify({ id: c.id, harnessId: c.harnessId, cwd: c.cwd, transcript: c.transcript, created: c.created }, null, 2));
  } catch {}
}

export function listHistory() {
  try {
    ensureHistoryDir();
    return fs.readdirSync(HISTORY_DIR).filter(f => f.endsWith(".json")).map(f => {
      try { return JSON.parse(fs.readFileSync(path.join(HISTORY_DIR, f), "utf8")); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

const chats = new Map(); // id -> chat record
let nextId = 1;

export function supported(manifest) {
  return Boolean(manifest?.chat?.args);
}

export function get(id) {
  return chats.get(id);
}

export function summary() {
  return [...chats.values()].map((c) => ({
    id: c.id,
    harnessId: c.harnessId,
    cwd: c.cwd,
    kind: "chat",
    state: c.state,
    preview: c.transcript.length ? lastAssistantPreview(c) : "",
  }));
}

function lastAssistantPreview(c) {
  for (let i = c.transcript.length - 1; i >= 0; i--) {
    const it = c.transcript[i];
    if (it.role === "assistant") return it.text.slice(0, 80);
  }
  return "";
}

export function create({ manifest, cwd, resumeFirst = false }) {
  const id = "c" + nextId++;
  const dir = cwd && String(cwd).trim()
    ? path.resolve(String(cwd).replace(/^~(?=$|\/|\\)/, os.homedir()))
    : os.homedir();
  const c = {
    id,
    harnessId: manifest.id,
    bin: manifest.bin,
    cwd: dir,
    format: manifest.chat.format || "text",
    args: manifest.chat.args || [],
    resumeArgs: manifest.chat.resumeArgs || null,
    // Model selection (manifest `chat.models` map): per-chat override that
    // appends model args/env at run time — phone picks the model, daemon runs it.
    models: manifest.chat.models || {},
    model: null,
    // resumeFirst: next turn uses resumeArgs (chat resurrection — re-open a
    // conversation the daemon forgot via the CLI's own --continue history).
    turn: resumeFirst ? 1 : 0,
    state: "idle",
    transcript: [],
    created: Date.now(),
    proc: null,
    subs: new Set(),
  };
  chats.set(id, c);
  return { id, harnessId: c.harnessId, cwd: c.cwd, kind: "chat" };
}

/**
 * Chat forking (1code: fork a sub-chat from any message). Clones the chat's
 * config and transcript up to `atMessageIndex` (default: full copy) into a
 * new chat with a fresh id. Optional cwd/env overrides let the fork run
 * isolated (pair with worktrees for branch-safe experimentation). An explicit
 * env object layers OVER the parent's attached env profile instead of
 * replacing it — a fork keeps its parent's BYOK keys unless overridden.
 */
export function forkChat(id, atMessageIndex = -1, { cwd, env } = {}) {
  const c = chats.get(id);
  if (!c) return { ok: false, error: `no such chat: ${id}` };
  const cut = atMessageIndex >= 0 ? Math.min(Math.floor(atMessageIndex), c.transcript.length) : c.transcript.length;
  const dir = cwd && String(cwd).trim()
    ? path.resolve(String(cwd).replace(/^~(?=$|\/|\\)/, os.homedir()))
    : c.cwd;
  const nc = {
    ...c,
    id: "c" + nextId++,
    cwd: dir,
    env: env && typeof env === "object" ? { ...(c.env ?? {}), ...env } : c.env ? { ...c.env } : null,
    state: "idle",
    transcript: c.transcript.slice(0, cut).map((it) => ({ ...it })),
    created: Date.now(),
    proc: null,
    subs: new Set(),
    forkedFrom: { id: c.id, at: cut },
  };
  chats.set(nc.id, nc);
  chatEvents.emit("state", { id: nc.id, state: "idle", harnessId: nc.harnessId });
  return { ok: true, chat: { id: nc.id, harnessId: nc.harnessId, cwd: nc.cwd, kind: "chat", forkedFrom: nc.forkedFrom } };
}

export function attach(id, ws) {
  const c = chats.get(id);
  if (!c) return false;
  c.subs.add(ws);
  ws._subs.add("chat:" + id);
  if (ws.readyState === 1) ws.send(JSON.stringify({ type: "chatreplay", id, items: c.transcript }));
  return true;
}

export function detach(ws, id) {
  if (id) {
    const c = chats.get(id);
    if (c) c.subs.delete(ws);
    ws._subs.delete("chat:" + id);
    return;
  }
  for (const key of ws._subs) {
    if (key.startsWith("chat:")) {
      const c = chats.get(key.slice(5));
      if (c) c.subs.delete(ws);
      ws._subs.delete(key);
    }
  }
}

export function sendUserMessage(c, rawText) {
  // @file mentions (hermes-android/mobvibe): inline PC-side files before the
  // prompt reaches the agent, anchored at the chat's cwd.
  let text = String(rawText ?? "");
  let mentionReport = null;
  try {
    const ex = expandMentions(text, c.cwd);
    text = ex.text;
    mentionReport = ex.mentions;
  } catch {}
  if (!text.trim()) return false;
  c.transcript.push({ role: "user", text });
  push(c, { type: "chatuser", id: c.id, text });
  if (mentionReport?.length) push(c, { type: "chatmentions", id: c.id, mentions: mentionReport });
  runTurn(c, text);
  return true;
}

function runTurn(c, prompt) {
  if (c.proc && c.state === "running") return false;
  const continuing = c.turn > 0 && c.resumeArgs && c.resumeArgs.length > 0;
  const modelCfg = c.model && c.models && c.models[c.model] ? c.models[c.model] : null;
  const argv = [...(continuing ? c.resumeArgs : c.args), ...(modelCfg?.args || [])];
  c.turn++;
  c.state = "running";
  pushState(c);

  let outBuf = "";
  const decoder = new StringDecoder("utf8");
  // Env profiles (1code BYOK / Vibe Companion envs): per-chat overrides
  // layered over the daemon's environment; a selected model's env wins.
  const env = { ...process.env, ...(c.env || {}), ...(modelCfg?.env || {}) };

  const proc = IS_WIN
    ? spawn("cmd.exe", ["/c", c.bin, ...argv], { windowsHide: true, cwd: c.cwd, env, stdio: ["pipe", "pipe", "pipe"] })
    : spawn(c.bin, argv, { cwd: c.cwd, env, stdio: ["pipe", "pipe", "pipe"] });
  c.proc = proc;

  try {
    proc.stdin.write(prompt + "\n");
  } catch (e) {
    // Child died instantly (bad bin/args) — surface instead of crashing.
    c.state = "error";
    appendSystem(c, `[spawn failed] ${e.message}`);
    push(c, { type: "chatdelta", id: c.id, text: `\n[spawn failed] ${e.message}` });
    pushState(c);
    return true;
  }
  proc.stdin.end();

  const emitText = (t) => {
    if (!t) return;
    appendAssistant(c, t);
    push(c, { type: "chatdelta", id: c.id, text: t });
  };

  const onChunk = (d) => {
    const s = decoder.write(d);
    if (c.format === "claude-stream-json" || c.format === "codex-json") {
      outBuf += s;
      const lines = outBuf.split(/\r?\n/);
      outBuf = lines.pop();
      for (const line of lines) handleLine(c, line, emitText);
    } else {
      emitText(s);
      checkWaiting(c, s);
    }
  };

  proc.stdout.on("data", onChunk);
  proc.stderr.on("data", onChunk);
  proc.on("error", (e) => {
    c.state = "error";
    appendSystem(c, e.message);
    push(c, { type: "chatdelta", id: c.id, text: "\n[spawn failed] " + e.message });
    pushState(c);
  });

  proc.on("close", (code) => {
    if (outBuf.trim()) handleLine(c, outBuf, emitText);
    outBuf = "";
    decoder.end();
    c.proc = null;
    if (c.state !== "error") {
      c.state = code === 0 ? "idle" : "error";
      if (code !== 0) {
        appendSystem(c, `process exited with code ${code}`);
        push(c, { type: "chatdelta", id: c.id, text: `\n[exit ${code}]` });
      }
    }
    pushState(c);
  });
  return true;
}

function handleLine(c, line, emitText) {
  const t = line.trim();
  if (!t) return;
  if ((t.startsWith("{") && t.endsWith("}")) === false) {
    emitText(t + "\n");
    return;
  }
  let obj;
  try {
    obj = JSON.parse(t);
  } catch {
    emitText(line + "\n");
    return;
  }
  if (c.format === "claude-stream-json") parseClaude(c, obj, emitText);
  else if (c.format === "codex-json") parseCodex(c, obj, emitText);
  else emitText(line + "\n");
}

function parseClaude(c, obj, emitText) {
  switch (obj.type) {
    case "assistant": {
      const content = obj.message?.content ?? [];
      for (const part of content) {
        if (part.type === "text") emitText(part.text);
        else if (part.type === "tool_use") toolUse(c, part.name, JSON.stringify(part.input ?? {}));
        else if (part.type === "tool_result") {
          // arrives inside user messages in stream-json; ignore
        }
      }
      break;
    }
    case "user": {
      const content = obj.message?.content ?? [];
      if (Array.isArray(content)) {
        for (const part of content) {
          if (part.type === "tool_result") {
            const txt = typeof part.content === "string"
              ? part.content
              : JSON.stringify(part.content ?? "");
            toolResult(c, txt.slice(0, 200));
          }
        }
      }
      break;
    }
    case "result":
      emitUsage(c, obj.usage, obj.total_cost_usd);
      finishTurn(c, obj.is_error ? "error" : "idle", obj.result || "");
      break;
    default:
      break;
  }
}

function parseCodex(c, obj, emitText) {
  const msg = obj.msg ?? obj;
  switch (msg.type) {
    case "agent_message":
      emitText(msg.message ?? "");
      break;
    case "exec_command_begin":
      toolUse(c, "exec", (msg.command ?? []).join(" ").slice(0, 160));
      break;
    case "patch_apply_begin":
      toolUse(c, "patch", (msg.changes ? Object.keys(msg.changes).join(", ") : "").slice(0, 160));
      break;
    case "task_complete":
      finishTurn(c, "idle", msg.last_agent_message ?? "");
      break;
    case "token_count":
      emitUsage(c, msg.info?.total_token_usage ?? msg.info ?? null, 0);
      break;
    case "error":
    case "turn_aborted":
      finishTurn(c, "error", msg.message ?? "aborted");
      break;
    default:
      break;
  }
}

// Usage fields from stream events (c9watch/flue/orca cost dashboards).
function emitUsage(c, usage, costUsd) {
  if (!usage && !costUsd) return;
  chatEvents.emit("usage", { id: c.id, usage: usage ?? {}, cost: Number(costUsd) || 0 });
}

function toolUse(c, name, detail) {
  c.transcript.push({ role: "tool", name, detail: String(detail).slice(0, 300) });
  push(c, { type: "chartool", id: c.id, name, detail: String(detail).slice(0, 300) });
}

function toolResult(c, text) {
  c.transcript.push({ role: "toolresult", text: String(text).slice(0, 300) });
  push(c, { type: "chattoolresult", id: c.id, text: String(text).slice(0, 300) });
}

function appendAssistant(c, text) {
  const last = c.transcript[c.transcript.length - 1];
  if (last && last.role === "assistant") last.text += text;
  else c.transcript.push({ role: "assistant", text });
}

function appendSystem(c, text) {
  c.transcript.push({ role: "system", text });
}

function finishTurn(c, state, finalText) {
  if (finalText) {
    // The final message usually arrives both as streamed deltas and again as
    // `last_agent_message` on task_complete — append only the missing tail so
    // the transcript/UI never double the assistant text.
    const last = c.transcript[c.transcript.length - 1];
    const lastText = last && last.role === "assistant" ? last.text : "";
    if (lastText && lastText.endsWith(finalText)) {
      // already fully streamed via deltas — no-op
    } else if (lastText && finalText.startsWith(lastText) && lastText.length < finalText.length) {
      const remainder = finalText.slice(lastText.length);
      appendAssistant(c, remainder);
      push(c, { type: "chatdelta", id: c.id, text: remainder });
    } else {
      appendAssistant(c, finalText);
      push(c, { type: "chatdelta", id: c.id, text: finalText });
    }
  }
  c.state = state;
  saveHistory(c);
  pushState(c);
}

const WAITING_MARKERS = [
  "Enter to select",
  "Do you want to proceed",
  "No, and tell Claude what to do",
  "Permission required",
  "Approve?",
];

function checkWaiting(c, text) {
  for (const marker of WAITING_MARKERS) {
    if (text.includes(marker)) {
      c.state = "waiting";
      push(c, { type: "sdk_permission", id: c.id, reason: marker });
      pushState(c);
      return true;
    }
  }
  return false;
}

/**
 * Model selection (phone → daemon): pick which model the harness runs with.
 * The manifest's `chat.models` map drives what is offered; the chosen model's
 * args/env are merged into the next turn's spawn.
 */
export function listModels(id) {
  const c = chats.get(id);
  if (!c) return { ok: false, error: `no such chat: ${id}` };
  return { ok: true, id, models: Object.keys(c.models), current: c.model };
}

export function setModel(id, model) {
  const c = chats.get(id);
  if (!c) return { ok: false, error: `no such chat: ${id}` };
  if (model != null && !c.models[model]) {
    return { ok: false, error: `unknown model: ${model} (available: ${Object.keys(c.models).join(", ") || "none"})` };
  }
  c.model = model || null;
  return { ok: true, id, models: Object.keys(c.models), current: c.model };
}

export function cancel(c) {
  if (c.proc) {
    try {
      const pid = c.proc.pid;
      if (IS_WIN && pid) {
        // cmd.exe /c wrapper: kill the whole process tree so the agent child
        // doesn't keep running orphaned.
        try { execSync(`taskkill /PID ${pid} /T /F`, { stdio: "ignore", timeout: 5000 }); } catch {}
      }
      c.proc.kill();
    } catch {}
    c.proc = null;
  }
  if (c.state === "running") {
    c.state = "idle";
    appendSystem(c, "[cancelled]");
    push(c, { type: "chatdelta", id: c.id, text: "\n[cancelled]" });
    pushState(c);
  }
  return true;
}

function pushState(c) {
  push(c, { type: "chatstate", id: c.id, state: c.state });
  chatEvents.emit("state", { id: c.id, state: c.state, harnessId: c.harnessId });
}

function push(c, obj) {
  for (const ws of c.subs) {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  }
}
