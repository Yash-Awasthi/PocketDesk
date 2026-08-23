import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import * as registry from "./registry.js";
import * as sessions from "./sessions.js";

const HELLO_TIMEOUT = 10_000;

export function start({ port, token, tls }) {
  const pagePath = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "index.html");
  const page = fs.readFileSync(pagePath);

  const requestHandler = (req, res) => {
    if (req.method === "GET") {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page);
      return;
    }
    res.writeHead(405).end();
  };

  const useTls = Boolean(tls?.enabled && fs.existsSync(tls.cert) && fs.existsSync(tls.key));
  const server = useTls
    ? https.createServer({ cert: fs.readFileSync(tls.cert), key: fs.readFileSync(tls.key) }, requestHandler)
    : http.createServer(requestHandler);

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
      case "fread":
        send(ws, readFileChunk(msg.path, msg.offset));
        break;
      case "fwrite":
        send(ws, writeFileChunk(msg));
        break;
      default:
        send(ws, { type: "error", message: `unknown type: ${msg.type}` });
    }
  }

  const CHUNK = 256 * 1024;

  function resolvePath(p) {
    return p && String(p).trim() ? path.resolve(String(p).replace(/^~(?=$|\/|\\)/, os.homedir())) : os.homedir();
  }

  function listDir(p) {
    const dir = resolvePath(p);
    let entries;
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch (e) {
      return { type: "fs", error: e.message };
    }
    const items = entries
      .filter((e) => !e.name.startsWith("."))
      .slice(0, 500)
      .map((e) => {
        let size = null;
        if (!e.isDirectory()) {
          try {
            size = fs.statSync(path.join(dir, e.name)).size;
          } catch {}
        }
        return { name: e.name, dir: e.isDirectory(), size };
      })
      .sort((a, b) => (b.dir - a.dir) || a.name.localeCompare(b.name));
    return { type: "fs", path: dir, parent: path.dirname(dir), items };
  }

  function readFileChunk(p, offset) {
    const file = resolvePath(p);
    try {
      const st = fs.statSync(file);
      if (!st.isFile()) return { type: "fchunk", path: file, error: "not a file" };
      const start = Math.max(0, Number(offset) || 0);
      if (start >= st.size) return { type: "fchunk", path: file, size: st.size, data: "", eof: true };
      const len = Math.min(CHUNK, st.size - start);
      const buf = Buffer.alloc(len);
      const fd = fs.openSync(file, "r");
      try {
        fs.readSync(fd, buf, 0, len, start);
      } finally {
        fs.closeSync(fd);
      }
      return {
        type: "fchunk",
        path: file,
        offset: start,
        size: st.size,
        data: buf.toString("base64"),
        eof: start + len >= st.size,
      };
    } catch (e) {
      return { type: "fchunk", path: file, error: e.message };
    }
  }

  function writeFileChunk(msg) {
    const file = resolvePath(msg.path);
    const append = Boolean(msg.append);
    try {
      let base = 0;
      if (append && fs.existsSync(file)) base = fs.statSync(file).size;
      const buf = Buffer.from(String(msg.data || ""), "base64");
      fs.appendFileSync(file, buf);
      return { type: "fwritten", path: file, size: append ? base + buf.length : buf.length };
    } catch (e) {
      return { type: "fwritten", path: file, error: e.message };
    }
  }

  function send(ws, obj) {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  server.listen(port, async () => {
    const scheme = useTls ? "wss" : "ws";
    console.log("");
    console.log("  PocketDesk daemon");
    console.log(`  local     http${useTls ? "s" : ""}://localhost:${port}`);
    console.log(`  websocket ${scheme}://<this-pc>:${port}/ws`);
    console.log(`  token     ${token}`);
    if (useTls) {
      const fp = new crypto.X509Certificate(fs.readFileSync(tls.cert)).fingerprint256;
      console.log(`  tls       enabled, cert fingerprint ${fp}`);
    }
    console.log("  config    %USERPROFILE%\\.pocketdesk\\config.json");
    console.log("");
    await registry.scanAll(broadcast);
    console.log("  registry scanned");
  });
}
