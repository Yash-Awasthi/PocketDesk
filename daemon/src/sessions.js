import os from "node:os";
import path from "node:path";
import { StringDecoder } from "node:string_decoder";
import pty from "node-pty";

const SCROLLBACK = 100_000;
const sessions = new Map(); // id -> { id, harnessId, cwd, pty, decoder, scrollback, subs:Set, exitCode }
let nextId = 1;

export function create({ harnessId, bin, cwd, args = [] }, broadcast) {
  const id = "s" + nextId++;
  const dir = cwd && cwd.trim() ? path.resolve(cwd.replace(/^~(?=$|\/|\\)/, os.homedir())) : os.homedir();
  const proc = pty.spawn("cmd.exe", ["/c", bin, ...args], {
    name: "xterm-256color",
    cols: 100,
    rows: 30,
    cwd: dir,
    env: process.env,
  });
  const s = { id, harnessId, cwd: dir, pty: proc, decoder: new StringDecoder("utf8"), scrollback: "", subs: new Set(), exitCode: null };
  sessions.set(id, s);
  proc.onData((data) => {
    const text = s.decoder.write(Buffer.from(data));
    s.scrollback = (s.scrollback + text).slice(-SCROLLBACK);
    for (const ws of s.subs) send(ws, { type: "out", id, data: b64(text) });
  });
  proc.onExit(({ exitCode }) => {
    s.exitCode = exitCode;
    s.decoder.end();
    broadcast({ type: "exit", id, code: exitCode });
    s.subs.clear();
  });
  return { id, harnessId, cwd: dir };
}

export function get(id) {
  return sessions.get(id);
}

export function summary() {
  return [...sessions.values()]
    .filter((s) => s.exitCode === null)
    .map(({ id, harnessId, cwd }) => ({ id, harnessId, cwd }));
}

export function attach(id, ws) {
  const s = sessions.get(id);
  if (!s || s.exitCode !== null) return false;
  s.subs.add(ws);
  ws._subs.add(id);
  send(ws, { type: "replay", id, data: b64(s.scrollback) });
  return true;
}

export function detach(ws, id) {
  if (id) {
    const s = sessions.get(id);
    if (s) s.subs.delete(ws);
    ws._subs.delete(id);
    return;
  }
  for (const sid of ws._subs) {
    const s = sessions.get(sid);
    if (s) s.subs.delete(ws);
  }
  ws._subs.clear();
}

export function write(id, text) {
  const s = sessions.get(id);
  if (!s || s.exitCode !== null) return false;
  s.pty.write(text);
  return true;
}

export function resize(id, cols, rows) {
  const s = sessions.get(id);
  if (!s || s.exitCode !== null) return false;
  const c = Math.max(2, Math.min(500, cols | 0));
  const r = Math.max(2, Math.min(200, rows | 0));
  try {
    s.pty.resize(c, r);
  } catch {}
  return true;
}

export function kill(id) {
  const s = sessions.get(id);
  if (!s || s.exitCode !== null) return false;
  s.pty.kill();
  return true;
}

function b64(text) {
  return Buffer.from(text, "utf8").toString("base64");
}

function send(ws, obj) {
  if (ws.readyState === 1) ws.send(JSON.stringify(obj));
}
