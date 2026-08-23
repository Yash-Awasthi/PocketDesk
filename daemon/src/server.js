import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import * as registry from "./registry.js";
import * as sessions from "./sessions.js";

const HELLO_TIMEOUT = 10_000;

export function start({ port, token }) {
  const pagePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "index.html");
  const page = fs.readFileSync(pagePath);

  const server = http.createServer((req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page);
      return;
    }
    res.writeHead(405).end();
  });

  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    ws._subs = new Set();
    ws._authed = false;
    const timer = setTimeout(() => ws.close(4001, "auth timeout"), HELLO_TIMEOUT);
    ws.on("close", () => {
      clearTimeout(timer);
      sessions.detach(ws);
    });
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!ws._authed) {
        if (msg.type === "hello" && msg.token === token) {
          ws._authed = true;
          clearTimeout(timer);
          send(ws, { type: "welcome", version: 1, sessions: sessions.summary(), manifests: registry.list() });
        } else {
          ws.close(4003, "bad token");
        }
        return;
      }
      handle(ws, msg);
    });
  });

  function broadcast(obj) {
    for (const ws of wss.clients) if (ws._authed) send(ws, obj);
  }

  async function handle(ws, msg) {
    switch (msg.type) {
      case "detect":
        await registry.scanAll(broadcast);
        break;
      case "install":
        registry.install(msg.id, broadcast);
        break;
      case "create": {
        const m = registry.get(msg.harness);
        if (!m || m.adapter !== "terminal") return send(ws, { type: "error", message: `unknown harness: ${msg.harness}` });
        if (!registry.isInstalled(m.id)) return send(ws, { type: "error", message: `${m.name} is not installed` });
        const s = sessions.create({ harnessId: m.id, bin: m.bin, cwd: msg.cwd, args: msg.args }, broadcast);
        broadcast({ type: "sessions", items: sessions.summary() });
        send(ws, { type: "created", ...s });
        break;
      }
      case "attach":
        if (!sessions.attach(msg.id, ws)) send(ws, { type: "error", message: `no live session: ${msg.id}` });
        break;
      case "detach":
        sessions.detach(ws, msg.id);
        break;
      case "in":
        sessions.write(msg.id, Buffer.from(msg.data, "base64").toString("utf8"));
        break;
      case "resize":
        sessions.resize(msg.id, msg.cols, msg.rows);
        break;
      case "kill":
        sessions.kill(msg.id);
        break;
      case "fs":
        send(ws, listDir(msg.path));
        break;
      default:
        send(ws, { type: "error", message: `unknown type: ${msg.type}` });
    }
  }

  function listDir(p) {
    const dir = p && p.trim() ? path.resolve(String(p).replace(/^~(?=$|\/|\\)/, os.homedir())) : os.homedir();
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return { type: "fs", error: e.message };
    }
    const items = entries
      .filter((e) => e.isDirectory() && !e.name.startsWith("."))
      .slice(0, 500)
      .map((e) => e.name)
      .sort((a, b) => a.localeCompare(b));
    return { type: "fs", path: dir, parent: path.dirname(dir), items };
  }

  function send(ws, obj) {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  server.listen(port, async () => {
    console.log("");
    console.log("  PocketDesk daemon");
    console.log(`  local     http://localhost:${port}`);
    console.log(`  websocket ws://<this-pc>:${port}/ws`);
    console.log(`  token     ${token}`);
    console.log("  config    %USERPROFILE%\\.pocketdesk\\config.json");
    console.log("");
    await registry.scanAll(broadcast);
    console.log("  registry scanned");
  });
}
