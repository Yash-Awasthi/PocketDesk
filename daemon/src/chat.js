import path from "node:path";
import os from "node:os";
import fs from "node:fs";
import { spawn, execFile, execFileSync } from "node:child_process";

const IS_WIN = process.platform === "win32";
import { StringDecoder } from "node:string_decoder";
import { EventEmitter } from "node:events";
import { expand as expandMentions } from "./mentions.js";
import * as toolApproval from "./tool_approval.js";

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
    const file = path.join(HISTORY_DIR, `${c.created}-${c.id}.json`);
    fs.writeFileSync(file, JSON.stringify({ id: c.id, harnessId: c.harnessId, cwd: c.cwd, transcript: c.transcript, created: c.created }, null, 2));
  } catch {}
}

const ATTACH_DIR = path.join(os.homedir(), DATA_DIR, "attachments");
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGES = 4;
const IMAGE_EXT = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };

/**
 * Decode phone/browser-attached images to disk so the CLI agent's own file-read
 * tool can view them (agents here take a text prompt, not image blocks).
 * Returns the absolute paths written; silently skips anything invalid/oversized.
 */
export function saveAttachments(chatId, images) {
  if (!Array.isArray(images) || !images.length) return [];
  fs.mkdirSync(path.join(ATTACH_DIR, chatId), { recursive: true });
  const paths = [];
  for (const img of images.slice(0, MAX_IMAGES)) {
    const ext = IMAGE_EXT[img?.mime];
    if (!ext || typeof img.data !== "string") continue;
    let buf;
    try { buf = Buffer.from(img.data, "base64"); } catch { continue; }
    if (!buf.length || buf.length > MAX_IMAGE_BYTES) continue;
    const file = path.join(ATTACH_DIR, chatId, `${Date.now()}-${paths.length}.${ext}`);
    fs.writeFileSync(file, buf);
    paths.push(file);
  }
  return paths;
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

export function create({ manifest, cwd, resumeFirst = false, cliSession = null }) {
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
    // Resume by the CLI's own session id: --continue picks the newest conversation in cwd, not this one.
    resumeIdArgs: manifest.chat.resumeIdArgs || null,
    cliSession,
    promptArg: Boolean(manifest.chat.promptArg),
    inlineHistory: Boolean(manifest.chat.inlineHistory),
    // Model selection (manifest `chat.models` map): per-chat override that
    // appends model args/env at run time — phone picks the model, daemon runs it.
    models: manifest.chat.models || {},
    modelArg: manifest.chat.modelArg || null,
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
  if (!text.trim() || (c.proc && c.state === "running")) return false;
  c.transcript.push({ role: "user", text });
  push(c, { type: "chatuser", id: c.id, text });
  if (mentionReport?.length) push(c, { type: "chatmentions", id: c.id, mentions: mentionReport });
  runTurn(c, text);
  return true;
}

// Phone and browser names for Claude Code permission modes; unset keeps the user's own setting.
const CLAUDE_MODES = { default: "default", ask: "default", autopilot: "acceptEdits", acceptEdits: "acceptEdits", readonly: "plan", plan: "plan", yolo: "bypassPermissions", bypassPermissions: "bypassPermissions" };

function runTurn(c, prompt) {
  if (c.proc && c.state === "running") return false;
  const continuing = c.turn > 0 && c.resumeArgs && c.resumeArgs.length > 0;
  const modelCfg = !c.model ? null : c.models?.[c.model] ?? (c.modelArg ? { args: [...c.modelArg, c.model] } : null);
  const byId = c.turn > 0 && c.cliSession && c.resumeIdArgs;
  const base = byId ? c.resumeIdArgs.map((a) => a.replaceAll("{id}", c.cliSession)) : continuing ? c.resumeArgs : c.args;
  if (c.inlineHistory && c.turn > 0) prompt = withHistory(c, prompt);
  const claude = c.format === "claude-stream-json";
  const mode = claude && Object.hasOwn(CLAUDE_MODES, c.permissionMode) && CLAUDE_MODES[c.permissionMode];
  const approvals = claude ? [...toolApproval.claudeArgs(), ...(mode ? ["--permission-mode", mode] : [])] : [];
  const argv = [...base, ...approvals, ...(modelCfg?.args || []), ...(c.promptArg ? [prompt] : [])];
  c.turn++;
  c.state = "running";
  pushState(c);

  let outBuf = "";
  const decoder = new StringDecoder("utf8");
  // Env profiles (1code BYOK / Vibe Companion envs): per-chat overrides
  // layered over the daemon's environment; a selected model's env wins.
  const env = { ...process.env, ...(c.env || {}), ...(modelCfg?.env || {}), ...(approvals.length ? toolApproval.env(c.id) : {}) };

  const opts = { windowsHide: true, cwd: c.cwd, env, stdio: ["pipe", "pipe", "pipe"] };
  // cmd.exe re-parses its command line, so a prompt passed as an argument must bypass it.
  const script = IS_WIN && c.promptArg ? npmShimScript(c.bin) : null;
  if (IS_WIN && c.promptArg && !script) {
    c.state = "error";
    appendSystem(c, `cannot find the npm launcher for ${c.bin}`);
    push(c, { type: "chatdelta", id: c.id, text: `\n[spawn failed] cannot find the npm launcher for ${c.bin}` });
    pushState(c);
    return true;
  }
  const proc = script
    ? spawn(process.execPath, [script, ...argv], opts)
    : IS_WIN
      ? spawn("cmd.exe", ["/c", c.bin, ...argv], opts)
      : spawn(c.bin, argv, opts);
  c.proc = proc;

  try {
    if (!c.promptArg) proc.stdin.write(prompt + "\n");
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
    if (PARSERS[c.format]) {
      outBuf += s;
      const lines = outBuf.split(/\r?\n/);
      outBuf = lines.pop();
      for (const line of lines) handleLine(c, line, emitText);
    } else {
      emitText(s);
      checkWaiting(c, s);
    }
  };

  let errBuf = "";
  proc.stdout.on("data", onChunk);
  // JSON agents print warnings on stderr every run; it only matters when the turn fails.
  proc.stderr.on("data", PARSERS[c.format] ? (d) => { errBuf = (errBuf + d).slice(-4000); } : onChunk);
  proc.on("error", (e) => {
    if (c.proc !== proc) return;
    c.state = "error";
    appendSystem(c, e.message);
    push(c, { type: "chatdelta", id: c.id, text: "\n[spawn failed] " + e.message });
    pushState(c);
  });

  proc.on("close", (code) => {
    if (outBuf.trim()) handleLine(c, outBuf, emitText);
    outBuf = "";
    decoder.end();
    if (code !== 0 && errBuf.trim()) emitText("\n" + errBuf.trim());
    // A finished turn lets the next one start before this process exits; it must not clobber that turn.
    if (c.proc !== proc) return;
    c.proc = null;
    if (c.state === "idle" && code === 0) return;
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
  const parse = PARSERS[c.format];
  if (parse) parse(c, obj, emitText);
  else emitText(line + "\n");
}

/** Resolves an npm `.cmd` shim on PATH to the node script it launches. */
function npmShimScript(bin) {
  for (const dir of (process.env.PATH || "").split(path.delimiter)) {
    if (!dir) continue;
    try {
      const m = fs.readFileSync(path.join(dir, `${bin}.cmd`), "utf8").match(/"%dp0%\\([^"]+)"\s+%\*/);
      if (m) return path.join(dir, m[1]);
    } catch {}
  }
  return null;
}

function parseClaude(c, obj, emitText) {
  if (typeof obj.session_id === "string" && obj.session_id) c.cliSession = obj.session_id;
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

// `codex exec --json`. Top-level "error" events are retry notices; only turn.failed ends a turn.
function parseCodex(c, obj, emitText) {
  const item = obj.item ?? {};
  switch (obj.type) {
    case "thread.started":
      c.cliSession = obj.thread_id ?? c.cliSession;
      break;
    case "item.started":
      if (item.type === "command_execution") toolUse(c, "exec", String(item.command ?? "").slice(0, 160));
      break;
    case "item.completed":
      if (item.type === "agent_message") emitText(item.text ?? "");
      else if (item.type === "command_execution") toolResult(c, String(item.aggregated_output ?? "").slice(0, 200));
      else if (item.type === "file_change") toolUse(c, "patch", (item.changes ?? []).map((ch) => ch.path).join(", ").slice(0, 160));
      break;
    case "turn.completed":
      emitUsage(c, obj.usage, 0);
      finishTurn(c, "idle", "");
      break;
    case "turn.failed":
      finishTurn(c, "error", obj.error?.message ?? "turn failed");
      break;
    default:
      break;
  }
}

// `opencode run --format json`: a turn is several steps; the one with reason "stop" is the last.
function parseOpencode(c, obj, emitText) {
  if (obj.sessionID) c.cliSession = obj.sessionID;
  const part = obj.part ?? {};
  switch (obj.type) {
    case "text":
      emitText(part.text ?? "");
      break;
    case "tool_use":
      toolUse(c, part.tool ?? "tool", JSON.stringify(part.state?.input ?? {}));
      break;
    case "step_finish":
      emitUsage(c, part.tokens, part.cost);
      if (part.reason === "stop") finishTurn(c, "idle", "");
      break;
    case "error":
      finishTurn(c, "error", obj.error?.data?.message ?? obj.error?.name ?? "error");
      break;
    default:
      break;
  }
}

// `gemini -o stream-json`.
function parseGemini(c, obj, emitText) {
  switch (obj.type) {
    case "init":
      c.cliSession = obj.session_id ?? c.cliSession;
      break;
    case "message":
      if (obj.role === "assistant") emitText(obj.content ?? "");
      break;
    case "tool_use":
      toolUse(c, obj.tool_name ?? "tool", JSON.stringify(obj.parameters ?? {}));
      break;
    case "tool_result":
      toolResult(c, String(obj.output ?? obj.status ?? "").slice(0, 200));
      break;
    case "result":
      emitUsage(c, obj.stats, 0);
      finishTurn(c, obj.status === "success" ? "idle" : "error", obj.status === "success" ? "" : obj.error?.message ?? "");
      break;
    default:
      break;
  }
}

// `copilot --output-format json`: deltas stream the text and assistant.message repeats it whole.
function parseCopilot(c, obj, emitText) {
  const d = obj.data ?? {};
  switch (obj.type) {
    case "assistant.message_delta":
      emitText(d.deltaContent ?? "");
      break;
    case "tool.execution_start":
      toolUse(c, d.toolName ?? "tool", JSON.stringify(d.arguments ?? {}));
      break;
    case "tool.execution_complete":
      toolResult(c, String(d.result?.content ?? "").slice(0, 200));
      break;
    case "result":
      c.cliSession = obj.sessionId ?? c.cliSession;
      emitUsage(c, obj.usage, 0);
      finishTurn(c, obj.exitCode === 0 ? "idle" : "error", "");
      break;
    default:
      break;
  }
}

// `cline --json`.
function parseCline(c, obj, emitText) {
  const ev = obj.event ?? {};
  if (obj.type === "agent_event") {
    if (ev.type === "content_end" && ev.contentType === "text") emitText(ev.text ?? "");
    else if (ev.type === "content_start" && ev.contentType === "tool") toolUse(c, ev.toolName ?? "tool", JSON.stringify(ev.input ?? {}));
    else if (ev.type === "content_end" && ev.contentType === "tool") toolResult(c, JSON.stringify(ev.output ?? "").slice(0, 200));
  } else if (obj.type === "run_result") {
    emitUsage(c, obj.usage, obj.usage?.totalCost);
    finishTurn(c, obj.finishReason === "completed" ? "idle" : "error", "");
  } else if (obj.type === "error") {
    finishTurn(c, "error", obj.message ?? "error");
  }
}

// Cline cannot resume a session without a TTY, so earlier turns ride along in the prompt.
function withHistory(c, prompt) {
  const past = c.transcript.slice(0, -1)
    .filter((t) => t.role === "user" || t.role === "assistant")
    .map((t) => `${t.role === "user" ? "User" : "Assistant"}: ${t.text}`)
    .join("\n\n")
    .slice(-8000);
  return `Conversation so far:\n\n${past}\n\nUser: ${prompt}`;
}

const PARSERS = {
  "claude-stream-json": parseClaude,
  "codex-json": parseCodex,
  "opencode-json": parseOpencode,
  "gemini-json": parseGemini,
  "copilot-json": parseCopilot,
  "cline-json": parseCline,
};

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
  return { ok: true, id, models: Object.keys(c.models), current: c.model, custom: Boolean(c.modelArg) };
}

// Model names reach a cmd.exe command line on Windows, so only plain identifiers pass.
const MODEL_NAME = /^[\w.:/-]{1,80}$/;

export function setModel(id, model) {
  const c = chats.get(id);
  if (!c) return { ok: false, error: `no such chat: ${id}` };
  if (model != null && !c.models[model] && !(c.modelArg && MODEL_NAME.test(model))) {
    return { ok: false, error: `unknown model: ${model} (available: ${Object.keys(c.models).join(", ") || "none"})` };
  }
  c.model = model || null;
  return { ok: true, id, models: Object.keys(c.models), current: c.model, custom: Boolean(c.modelArg) };
}

export function cancel(c) {
  if (c.proc) {
    const proc = c.proc;
    const killProc = () => { try { proc.kill(); } catch {} };
    // cmd.exe /c wrapper: kill the whole tree so the agent child doesn't keep running orphaned.
    if (IS_WIN && proc.pid) execFile("taskkill", ["/PID", String(proc.pid), "/T", "/F"], { timeout: 5000, windowsHide: true }, killProc);
    else killProc();
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

/** Shutdown: tree-kill every running agent before the daemon exits. */
export function killAll() {
  for (const c of chats.values()) {
    if (!c.proc) continue;
    if (IS_WIN && c.proc.pid) try { execFileSync("taskkill", ["/PID", String(c.proc.pid), "/T", "/F"], { stdio: "ignore", timeout: 5000, windowsHide: true }); } catch {}
    try { c.proc.kill(); } catch {}
    c.proc = null;
  }
}

function pushState(c) {
  push(c, { type: "chatstate", id: c.id, state: c.state });
  chatEvents.emit("state", { id: c.id, state: c.state, harnessId: c.harnessId, cliSession: c.cliSession });
}

function push(c, obj) {
  for (const ws of c.subs) {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  }
}
