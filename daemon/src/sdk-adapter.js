import { spawn } from "node:child_process";
import { WebSocketServer } from "ws";

const sessions = new Map();
let nextId = 1;
let wss = null;

export function init(server) {
  wss = new WebSocketServer({ server, path: "/sdk" });

  wss.on("connection", (ws, req) => {
    const auth = req.headers["authorization"];
    const token = auth?.replace("Bearer ", "");
    if (!token || token !== process.env.RH_TOKEN) {
      ws.close(4003, "bad token");
      return;
    }

    ws.on("message", (raw) => {
      let msg;
      try { msg = JSON.parse(raw.toString()); } catch { return; }

      const session = sessions.get(msg.session_id);
      if (!session) return;

      session.state = "connected";
      session.ws = ws;

      if (msg.type === "assistant") {
        const content = msg.message?.content ?? [];
        for (const part of content) {
          if (part.type === "text") {
            push(session, { type: "sdk_delta", id: session.id, text: part.text });
          } else if (part.type === "tool_use") {
            push(session, { type: "sdk_tool", id: session.id, name: part.name, input: part.input });
          }
        }
      } else if (msg.type === "control" && msg.subtype === "permission_request") {
        push(session, { type: "sdk_permission", id: session.id, tool: msg.tool_name, input: msg.input });
      } else if (msg.type === "result") {
        push(session, { type: "sdk_result", id: session.id, result: msg.result, is_error: msg.is_error });
        session.state = "idle";
        pushState(session);
      } else if (msg.type === "stream_event") {
        push(session, { type: "sdk_stream", id: session.id, event: msg });
      }
    });

    ws.on("close", () => {
      for (const s of sessions.values()) {
        if (s.ws === ws) {
          s.ws = null;
          s.state = "disconnected";
          pushState(s);
        }
      }
    });
  });
}

export function launch({ bin, cwd, args, model, permissionMode }) {
  const id = "sdk" + nextId++;
  const session = {
    id,
    bin,
    cwd,
    state: "starting",
    ws: null,
    subs: new Set(),
  };
  sessions.set(id, session);

  const wsUrl = `ws://localhost:${process.env.RH_PORT || 4678}/sdk`;
  const cliArgs = [
    "--sdk-url", wsUrl,
    "--print",
    "--output-format", "stream-json",
    "--input-format", "stream-json",
    "--verbose",
    ...(model ? ["--model", model] : []),
    ...(permissionMode ? ["--permission-mode", permissionMode] : []),
    ...(args || []),
    "-p", "placeholder",
  ];

  const proc = spawn(bin, cliArgs, {
    cwd,
    env: { ...process.env, RH_TOKEN: process.env.RH_TOKEN || "" },
    windowsHide: true,
    stdio: ["pipe", "pipe", "pipe"],
  });

  session.proc = proc;

  proc.on("close", (code) => {
    session.state = "exited";
    session.exitCode = code;
    push(session, { type: "sdk_exit", id, code });
    pushState(session);
  });

  proc.on("error", (e) => {
    session.state = "error";
    push(session, { type: "sdk_delta", id, text: `\n[spawn error: ${e.message}]` });
    pushState(session);
  });

  return { id, cwd };
}

export function sendPrompt(sessionId, text) {
  const s = sessions.get(sessionId);
  if (!s || !s.ws || s.ws.readyState !== 1) return false;
  s.ws.send(JSON.stringify({ type: "user", content: text }));
  s.state = "running";
  pushState(s);
  return true;
}

export function approve(sessionId, requestId, approved) {
  const s = sessions.get(sessionId);
  if (!s || !s.ws || s.ws.readyState !== 1) return false;
  s.ws.send(JSON.stringify({
    type: "control",
    subtype: "permission_response",
    request_id: requestId,
    approved,
  }));
  return true;
}

export function interrupt(sessionId) {
  const s = sessions.get(sessionId);
  if (!s || !s.ws || s.ws.readyState !== 1) return false;
  s.ws.send(JSON.stringify({ type: "control", subtype: "interrupt" }));
  return true;
}

export function summary() {
  return [...sessions.values()].map((s) => ({
    id: s.id,
    bin: s.bin,
    cwd: s.cwd,
    state: s.state,
    kind: "sdk",
  }));
}

export function get(id) {
  return sessions.get(id);
}

export function subscribe(id, ws) {
  const s = sessions.get(id);
  if (!s) return false;
  s.subs.add(ws);
  ws._subs.add("sdk:" + id);
  return true;
}

function pushState(s) {
  push(s, { type: "sdk_state", id: s.id, state: s.state });
}

function push(s, obj) {
  for (const ws of s.subs) {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  }
}
