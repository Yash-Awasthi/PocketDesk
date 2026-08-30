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
import * as chat from "./chat.js";
import { createPluginManager } from "./plugins.js";
import * as proposals from "./proposals.js";
import { createNotificationManager, NotificationEvents } from "./notifications.js";  const HELLO_TIMEOUT = 10_000;
  const MAX_AUTH_ATTEMPTS = 5;
  const authAttempts = new Map();
  const pluginDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "plugins");

  function allSessions() {
  return [...sessions.summary(), ...chat.summary()];
}

export function start({ port, token, tls }) {
  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
  const page = fs.readFileSync(path.join(publicDir, "index.html"));
  const pairTemplate = fs.readFileSync(path.join(publicDir, "pair.html"), "utf8");

  function lanAddress() {
    for (const list of Object.values(os.networkInterfaces())) {
      for (const ni of list ?? []) {
        if (ni.family === "IPv4" && !ni.internal) return ni.address;
      }
    }
    return "localhost";
  }

  let pairPage = "";
  function buildPairPage(useTls, fingerprint) {
    const url = `${useTls ? "wss" : "ws"}://${lanAddress()}:${port}/ws`;
    const payload = Buffer.from(
      JSON.stringify({ u: url, t: token, f: fingerprint || "" }),
      "utf8",
    ).toString("base64url");
    pairPage = pairTemplate
      .replaceAll("__RH_PAYLOAD__", `pocketdesk://pair#${payload}`)
      .replaceAll("__RH_URL__", url)
      .replaceAll("__RH_TOKEN__", token)
      .replaceAll("__RH_FP__", fingerprint || "n/a");
  }

  const requestHandler = (req, res) => {
    if (req.method !== "GET") {
      res.writeHead(405).end();
      return;
    }
    if (req.url.startsWith("/vendor/") && !req.url.includes("..")) {
      const file = path.join(publicDir, req.url);
      if (fs.existsSync(file)) {
        res.writeHead(200, { "content-type": req.url.endsWith(".js") ? "text/javascript" : "text/plain" });
        res.end(fs.readFileSync(file));
        return;
      }
    }
    // /pair carries the pairing token and is only ever served to the local machine.
    const loopback = req.socket.remoteAddress === "127.0.0.1" || req.socket.remoteAddress === "::1";
    if (req.url === "/pair" && loopback) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(pairPage);
      return;
    }
    if (req.url.startsWith("/pair")) {
      res.writeHead(403).end();
      return;
    }
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(page);
  };

  const useTls = Boolean(tls?.enabled && fs.existsSync(tls.cert) && fs.existsSync(tls.key));
  const server = useTls
    ? https.createServer({ cert: fs.readFileSync(tls.cert), key: fs.readFileSync(tls.key) }, requestHandler)
    : http.createServer(requestHandler);

  const wss = new WebSocketServer({ server, path: "/ws" });

  wss.on("connection", (ws) => {
    ws._subs = new Set();
    ws._authed = false;
    plugins.callHook("onConnect", ws);
    const timer = setTimeout(() => ws.close(4001, "auth timeout"), HELLO_TIMEOUT);
    ws.on("close", () => {
      clearTimeout(timer);
      sessions.detach(ws);
      chat.detach(ws);
      plugins.callHook("onDisconnect", ws);
    });
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      // Plugin hook: onMessage (may block or modify)
      plugins.callHook("onMessage", ws, msg).then(({ blocked }) => {
        if (blocked) return;
        if (!ws._authed) {
          // Rate limit auth attempts
          const clientIp = ws.socket?.remoteAddress || 'unknown';
          const attempts = authAttempts.get(clientIp) || 0;
          if (attempts >= MAX_AUTH_ATTEMPTS) {
            ws.close(4029, "too many auth attempts");
            return;
          }
          authAttempts.set(clientIp, attempts + 1);
          
          const tokenOk = msg.type === "hello" && typeof msg.token === "string" && msg.token.length === token.length && crypto.timingSafeEqual(Buffer.from(msg.token), Buffer.from(token));
          if (tokenOk) {
            ws._authed = true;
            authAttempts.delete(clientIp);
            clearTimeout(timer);
            send(ws, { type: "welcome", version: 1, sessions: allSessions(), manifests: registry.list() });
          } else {
            ws.close(4003, "bad token");
          }
          return;
        }
        handle(ws, msg);
      });
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
        notifications.send(NotificationEvents.SESSION_CONNECTED, { harness: m.name, cwd: msg.cwd });
        plugins.callHook("onSessionCreated", s);
        broadcast({ type: "sessions", items: allSessions() });
        send(ws, { type: "created", ...s });
        break;
      }
      case "chatsession": {
        const m = registry.get(msg.harness);
        if (!m) return send(ws, { type: "error", message: `unknown harness: ${msg.harness}` });
        if (!chat.supported(m)) return send(ws, { type: "error", message: `${m.name} has no chat adapter` });
        if (!registry.isInstalled(m.id)) return send(ws, { type: "error", message: `${m.name} is not installed` });
        const s = chat.create({ manifest: m, cwd: msg.cwd });
        notifications.send(NotificationEvents.SESSION_CONNECTED, { harness: m.name, cwd: msg.cwd });
        plugins.callHook("onChatCreated", s);
        chat.attach(s.id, ws);
        send(ws, { type: "created", ...s });
        if (String(msg.prompt || "").trim()) {
          chat.sendUserMessage(chat.get(s.id), String(msg.prompt));
        }
        broadcast({ type: "sessions", items: allSessions() });
        break;
      }
      case "chatmsg": {
        const c = chat.get(msg.id);
        if (!c) return send(ws, { type: "error", message: `no such chat: ${msg.id}` });
        if (c.state === "running") return send(ws, { type: "error", message: "still working on the previous prompt" });
        chat.attach(msg.id, ws);
        chat.sendUserMessage(c, String(msg.text || ""));
        broadcast({ type: "sessions", items: allSessions() });
        break;
      }
      case "chatcancel": {
        const c = chat.get(msg.id);
        if (c) {
          chat.cancel(c);
          broadcast({ type: "sessions", items: allSessions() });
        }
        break;
      }
      case "attach":
        if (!chat.attach(msg.id, ws) && !sessions.attach(msg.id, ws)) {
          send(ws, { type: "error", message: `no live session: ${msg.id}` });
        }
        break;
      case "detach":
        sessions.detach(ws, msg.id);
        chat.detach(ws, msg.id);
        break;
      case "in":
        sessions.write(msg.id, Buffer.from(msg.data, "base64").toString("utf8"));
        break;
      case "resize":
        sessions.resize(msg.id, msg.cols, msg.rows);
        break;
      case "kill":
        if (chat.get(msg.id)) {
          chat.cancel(chat.get(msg.id));
        } else {
          sessions.kill(msg.id);
        }
        broadcast({ type: "sessions", items: allSessions() });
        break;
      case "propose": {
        const p = proposals.create({
          type: msg.proposalType || "command_execute",
          summary: msg.summary || "Unnamed action",
          detail: msg.detail || {},
          sessionId: msg.sessionId || "unknown",
        });
        plugins.callHook("onProposal", ws, p);
        notifications.send(NotificationEvents.PROPOSAL_CREATED, { id: p.id, type: p.type, summary: p.summary });
        send(ws, { type: "proposal_created", proposal: { id: p.id, type: p.type, summary: p.summary, status: p.status } });
        break;
      }
      case "approve": {
        const p = proposals.approve(msg.id);
        if (p) {
          plugins.callHook("onProposalApproved", ws, p);
          notifications.send(NotificationEvents.PROPOSAL_APPROVED, { id: p.id, summary: p.summary });
          send(ws, { type: "proposal_approved", proposal: { id: p.id, status: p.status } });
        } else {
          send(ws, { type: "error", message: `proposal ${msg.id} not found or already decided` });
        }
        break;
      }
      case "reject": {
        const p = proposals.reject(msg.id);
        if (p) {
          plugins.callHook("onProposalRejected", ws, p);
          notifications.send(NotificationEvents.PROPOSAL_REJECTED, { id: p.id, summary: p.summary });
          send(ws, { type: "proposal_rejected", proposal: { id: p.id, status: p.status } });
        } else {
          send(ws, { type: "error", message: `proposal ${msg.id} not found or already decided` });
        }
        break;
      }
      case "proposal_list":
        send(ws, { type: "proposal_list", items: proposals.listPending() });
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
    const resolved = p && String(p).trim() ? path.resolve(String(p).replace(/^~(?=$|\/|\\)/, os.homedir())) : os.homedir();
    // Security: prevent path traversal outside home directory
    const home = os.homedir();
    if (!resolved.startsWith(home)) {
      throw new Error('Path traversal not allowed');
    }
    return resolved;
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
      if (!append) {
        fs.writeFileSync(file, Buffer.alloc(0));
      } else if (fs.existsSync(file)) {
        base = fs.statSync(file).size;
      }
      const buf = Buffer.from(String(msg.data || ""), "base64");
      if (buf.length > 0) fs.appendFileSync(file, buf);
      return { type: "fwritten", path: file, size: base + buf.length };
    } catch (e) {
      return { type: "fwritten", path: file, error: e.message };
    }
  }

  function send(ws, obj) {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  // ─── Plugin system ───────────────────────────────────────────────────────
  const notifConfig = {
    TELEGRAM_BOT_TOKEN: process.env.TELEGRAM_BOT_TOKEN,
    TELEGRAM_CHAT_ID: process.env.TELEGRAM_CHAT_ID,
    DISCORD_WEBHOOK_URL: process.env.DISCORD_WEBHOOK_URL,
    SMTP_HOST: process.env.SMTP_HOST,
    SMTP_PORT: process.env.SMTP_PORT ? Number(process.env.SMTP_PORT) : undefined,
    SMTP_USER: process.env.SMTP_USER,
    SMTP_PASS: process.env.SMTP_PASS,
    SMTP_FROM: process.env.SMTP_FROM,
    NOTIFY_EMAIL: process.env.NOTIFY_EMAIL,
  };
  const notifications = createNotificationManager({ config: notifConfig });
  const pluginCtx = { sessions, chat, registry, proposals, broadcast: null, notifications, config: { port, token, dataDir: process.env.POCKETDESK_DATA || ".pocketdesk" } };
  const plugins = createPluginManager(pluginCtx);
  pluginCtx.broadcast = broadcast; // wire after broadcast is defined

  server.listen(port, async () => {
    const scheme = useTls ? "wss" : "ws";
    let fp = "";
    if (useTls) {
      fp = new crypto.X509Certificate(fs.readFileSync(tls.cert)).fingerprint256;
    }
    buildPairPage(useTls, fp);
    console.log("");
    console.log("  PocketDesk daemon");
    console.log(`  local     http${useTls ? "s" : ""}://localhost:${port}`);
    console.log(`  websocket ${scheme}://<this-pc>:${port}/ws`);
    // Security: Don't log token in production
    if (process.env.NODE_ENV !== 'production') {
      console.log(`  token     ${token.slice(0, 8)}...${token.slice(-4)}`);
    }
    if (useTls) {
      console.log(`  tls       enabled, cert fingerprint ${fp}`);
      console.log(`  pairing   http${useTls ? "s" : ""}://localhost:${port}/pair  (scan the QR from the app)`);
    }
    console.log("  config    %USERPROFILE%\\.pocketdesk\\config.json");
    console.log("");
    proposals.init(broadcast);
    await registry.scanAll(broadcast);
    console.log("  registry scanned");
    // Load plugins
    await plugins.discover(pluginDir);
    await plugins.startAll();
    const loaded = plugins.list();
    if (loaded.length) console.log(`  plugins: ${loaded.map(p => p.name).join(", ")}`);
  });
}
