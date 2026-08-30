import path from "node:path";
import os from "node:os";
import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";

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

export function create({ manifest, cwd }) {
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
    state: "idle",
    transcript: [],
    proc: null,
    turn: 0,
    subs: new Set(),
  };
  chats.set(id, c);
  return { id, harnessId: c.harnessId, cwd: c.cwd, kind: "chat" };
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

export function sendUserMessage(c, text) {
  if (!text.trim()) return false;
  c.transcript.push({ role: "user", text });
  push(c, { type: "chatuser", id: c.id, text });
  runTurn(c, text);
  return true;
}

function runTurn(c, prompt) {
  if (c.proc && c.state === "running") return false;
  const continuing = c.turn > 0 && c.resumeArgs && c.resumeArgs.length > 0;
  const argv = continuing ? c.resumeArgs : c.args;
  c.turn++;
  c.state = "running";
  pushState(c);

  let outBuf = "";
  const decoder = new StringDecoder("utf8");

  const proc = spawn("cmd.exe", ["/c", c.bin, ...argv], {
    windowsHide: true,
    cwd: c.cwd,
    env: process.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  c.proc = proc;

  proc.stdin.write(prompt + "\n");
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
    case "error":
    case "turn_aborted":
      finishTurn(c, "error", msg.message ?? "aborted");
      break;
    default:
      break;
  }
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
    appendAssistant(c, finalText);
    push(c, { type: "chatdelta", id: c.id, text: finalText });
  }
  c.state = state;
  pushState(c);
}

export function cancel(c) {
  if (c.proc) {
    try {
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
}

function push(c, obj) {
  for (const ws of c.subs) {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  }
}
