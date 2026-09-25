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
import * as sessionStore from "./session-store.js";
import * as cliServer from "./cli-server.js";
import { PowerManager, normalizeAwakeMode } from "./power_manager.js";
import { createActivityMonitor } from "./activity.js";
import { StreamJsonParser } from "./stream_json_parser.js";
import { DesktopController } from "./desktop_capture.js";
import { DesktopPresence } from "./desktop_presence.js";
import { wakeTargets } from "./wake.js";
import { DesktopVideo } from "./desktop_video.js";
import { AdvancedSSHServerManager } from "./advanced_ssh_server.js";
import { SSHBastion } from "./ssh_bastion.js";
import { MultiProtocolClient } from "./ssh_vnc_client.js";
import * as promptQueue from "./prompt_queue.js";
import * as agentTodos from "./agent_todos.js";
import * as scheduler from "./scheduler.js";
import * as approvalGuard from "./approval_guard.js";
import * as statsUsage from "./stats_usage.js";
import * as devices from "./devices.js";
import agentsHandlers from "./handlers/agents.js";
import filesHandlers from "./handlers/files.js";
import remoteHandlers from "./handlers/remote.js";
import sshHandlers from "./handlers/ssh.js";
import systemHandlers from "./handlers/system.js";
import { startIroh } from "./iroh_link.js";
import { configDir } from "./config.js";

const HELLO_TIMEOUT = 10_000;
const MAX_AUTH_ATTEMPTS = 5;
const authAttempts = new Map();
const pluginDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "plugins");

  function allSessions() {
  // Attention-first ordering (c9watch): permission-waiting and running
  // sessions surface to the top so an agent stuck on approval is unmissable.
  const rank = { waiting: 0, running: 1, error: 2 };
  const all = [...sessions.summary(), ...chat.summary()];
  return all.sort((a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9));
}

export function start({ port, token, tls, iroh: irohCfg }, { onTokenRotated } = {}) {
  const publicDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public");
  const page = fs.readFileSync(path.join(publicDir, "index.html"));
  const pairTemplate = fs.readFileSync(path.join(publicDir, "pair.html"), "utf8");

  function lanAddress() {
    const all = Object.values(os.networkInterfaces()).flat()
      .filter((ni) => ni?.family === "IPv4" && !ni.internal).map((ni) => ni.address);
    // Home networks use private ranges; 100.64/10 is VPN or carrier NAT (Tailscale lives there).
    return all.find((a) => /^(192\.168\.|10\.|172\.(1[6-9]|2\d|3[01])\.)/.test(a))
      ?? all.find((a) => !a.startsWith("169.254.")) ?? "localhost";
  }

  let pairPage = "";
  let pairFp = "";
  let irohTicket = "";
  let irohEp = null;
  // Rebuilt on token rotation, so the QR never shows a dead token.
  function buildPairPage(useTls, fingerprint = pairFp) {
    pairFp = fingerprint;
    const url = `${useTls ? "wss" : "ws"}://${lanAddress()}:${port}/ws`;
    const payload = Buffer.from(
      JSON.stringify({ u: url, t: token, f: fingerprint || "", i: irohTicket || undefined }),
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
    // Windows dual-stack sockets present IPv4 clients as ::ffff:127.0.0.1.
    const remoteAddr = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
    const loopback = remoteAddr === "127.0.0.1" || remoteAddr === "::1" || remoteAddr === "[::1]";
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ status: "healthy", service: "pocketdesk", sessions: allSessions().length }));
      return;
    }
    if (req.url === "/pair" && loopback) {
      // The ticket carries current addresses and relay, which change with the network.
      const t = irohEp?.ticket();
      if (t && t !== irohTicket) { irohTicket = t; buildPairPage(useTls); }
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

  // WebSocket upgrade with origin check (ttyd/gotty pattern): browsers always
  // send Origin — cross-origin upgrades are rejected at the HTTP level (403)
  // before any socket is established. Native app clients send no Origin.
  const wss = new WebSocketServer({ noServer: true });
  server.on("upgrade", (req, socket, head) => {
    const samePath = req.url === "/ws";
    let originOk = true;
    if (req.headers.origin) {
      try {
        const oh = new URL(req.headers.origin).host;
        // Exact same-origin, or any loopback origin (embedded webviews and
        // port-forwarding proxies change the Host header; the token gate
        // still authenticates the socket itself).
        originOk = oh === req.headers.host ||
          /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/.test(oh);
      } catch {
        originOk = false;
      }
    }
    if (!samePath || !originOk) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => wss.emit("connection", ws, req));
  });

  wss.on("connection", (ws, req) => {
    // Read off `req`: the ws instance exposes the socket as `_socket`, so the
    // old `ws.socket?.remoteAddress` was always undefined and every client
    // shared one counter — five bad tokens locked out the whole LAN.
    const clientIp = (req.socket?.remoteAddress || "unknown").replace(/^::ffff:/, "");
    ws._subs = new Set();
    ws._authed = false;
    plugins.callHook("onConnect", ws);
    const timer = setTimeout(() => ws.close(4001, "auth timeout"), HELLO_TIMEOUT);
    ws.on("close", () => {
      clearTimeout(timer);
      detachClient(ws);
      plugins.callHook("onDisconnect", ws);
    });
    ws.on("message", (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      // Plugin hook: onMessage (may block or modify)
      plugins.callHook("onMessage", ws, msg).then(({ blocked }) => {
        if (blocked) return;
        if (!ws._authed) {
          // Rate limit auth attempts (10-minute decay window so a few typos
          // never lock an IP out forever).
          const rec = authAttempts.get(clientIp);
          const attempts = rec && Date.now() - rec.at < 10 * 60_000 ? rec.n : 0;
          if (attempts >= MAX_AUTH_ATTEMPTS) {
            ws.close(4029, "too many auth attempts");
            return;
          }
          for (const [ip, r] of authAttempts) if (Date.now() - r.at > 10 * 60_000) authAttempts.delete(ip);
          authAttempts.set(clientIp, { n: attempts + 1, at: Date.now() });

          const auth = authenticate(msg);
          if (auth) {
            // Checked before welcome(), which would re-issue a pairing device's token.
            if (ws._irohId && !devices.claimEndpoint(auth.id, ws._irohId)) {
              ws.close(4003, "device key mismatch");
              return;
            }
            const hi = welcome(auth, msg, clientIp);
            if (ws._irohId) devices.claimEndpoint(auth.id, ws._irohId);
            ws._authed = true;
            authAttempts.delete(clientIp);
            clearTimeout(timer);
            ws._clientId = auth.id;
            send(ws, hi);
          } else {
            ws.close(4003, "bad token");
          }
          return;
        }
        // F1: any throw inside a handler becomes an unhandled rejection and
        // kills the daemon on modern Node — surface it to the client instead.
        handle(ws, msg).catch((e) => {
          try {
            send(ws, { type: "error", message: `handler error: ${e?.message || e}` });
          } catch {}
        });
      }).catch(() => {});
    });
  });

  function broadcast(obj) {
    for (const ws of wss.clients) if (ws._authed) send(ws, obj);
  }

  function detachClient(ws) {
    sessions.detach(ws);
    chat.detach(ws);
  }

  // Sent on every welcome so the phone can wake this PC later, when it cannot reach it at all.
  let wake;
  wakeTargets().then((w) => { wake = w; }, () => {});
  function welcome(auth, hello, ip) {
    devices.register(auth.id, { name: hello.name, platform: hello.platform, ip });
    const deviceToken = auth.pairing ? devices.issueToken(auth.id) : undefined;
    return { type: "welcome", version: 1, clientId: auth.id, deviceToken, sessions: allSessions(), manifests: registry.list(), wake };
  }

  function disconnectDevice(clientId) {
    for (const client of wss.clients) if (client._clientId === clientId) client.close(4003, "device revoked");
  }

  // Master token pairs a new device and gets it its own token; a device token
  // identifies that device. The id is never taken from a client claim alone.
  function authenticate(msg) {
    if (msg.type !== "hello" || typeof msg.token !== "string") return null;
    const t = msg.token;
    if (t.length === token.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token))) {
      const id = String(msg.clientId || crypto.randomUUID());
      if (devices.isRevoked(id)) return null;
      return { id, pairing: true };
    }
    const d = devices.byToken(t);
    return d ? { id: d.id } : null;
  }

  function rotateToken() {
    token = crypto.randomBytes(24).toString("hex");
    pluginCtx.config.token = token;
    onTokenRotated?.(token);
    buildPairPage(useTls);
    return token;
  }

  async function handle(ws, msg) {
    const h = Object.hasOwn(handlers, msg.type) ? handlers[msg.type] : null;
    if (!h) return send(ws, { type: "error", message: `unknown type: ${msg.type}` });
    await h(ws, msg);
  }

  function send(ws, obj) {
    if (ws.readyState === 1) ws.send(JSON.stringify(obj));
  }

  // ─── Plugin system ───────────────────────────────────────────────────────
  const pluginCtx = { sessions, chat, registry, proposals, broadcast: null, config: { port, token, dataDir: process.env.POCKETDESK_DATA || ".pocketdesk" } };
  const plugins = createPluginManager(pluginCtx);
  pluginCtx.broadcast = broadcast; // wire after broadcast is defined

  // ── Absorbed feature managers ──────────────────────────────────────────────
  const power = new PowerManager({ mode: normalizeAwakeMode(process.env.RH_AWAKE || "auto") });
  const activity = createActivityMonitor({
    quietMs: (Number(process.env.RH_QUIET_MS) || 20_000),
    onEvent({ id, state }) {
      broadcast({ type: "activity", id, state });
    },
  });
  activity.start();
  power.refresh();

  // ── Stream JSON parser (format-claude-stream: agent JSONL → structured) ──
  const streamParser = new StreamJsonParser();

  // ── Real desktop capture + input (the frame SOURCE for rd_/desktop UIs) ──
  // Frames are client-scoped (a watching ws gets them directly — they are
  // ~200-300 KB each, too heavy for the broadcast fan-out) and the capture
  // loop runs only while at least one watcher is attached.
  const desktop = new DesktopController();
  const presence = new DesktopPresence();
  const desktopWatchers = new Set();
  desktop.on("frame", (frame) => {
    for (const w of desktopWatchers) {
      try {
        send(w, { type: "desktop_frame", ...frame });
      } catch { /* watcher vanished mid-send */ }
    }
  });

  // Viewers draw the pointer themselves, in the pixels of the picture they receive.
  desktop.on("cursor", (c) => {
    for (const w of new Set([...videoWatchers, ...desktopWatchers])) {
      const video_ = videoWatchers.has(w);
      const s = video_ ? video.scale : desktop.scale;
      const m = video_ ? video.monitor : null;
      try {
        send(w, { type: "desktop_cursor", x: Math.round((c.x - (m?.x || 0)) * s), y: Math.round((c.y - (m?.y || 0)) * s), shape: c.shape, visible: c.visible });
      } catch { /* watcher vanished mid-send */ }
    }
  });

  desktop.on("clipboard", (c) => {
    const { id, ok, seq, ...content } = c;
    // View-only viewers do not get the PC clipboard.
    for (const w of new Set([...videoWatchers, ...desktopWatchers])) {
      if (w._viewOnly) continue;
      try { send(w, { type: "clipboard_changed", ...content }); } catch { /* watcher vanished mid-send */ }
    }
  });

  // H.264 viewers get binary [kind, ...annexB] messages. A viewer whose socket
  // backs up skips frames until a fresh keyframe, which only a restart produces.
  const video = new DesktopVideo();
  const videoWatchers = new Set();
  let resyncTimer = null;
  const resync = () => {
    if (resyncTimer) return;
    resyncTimer = setTimeout(() => { resyncTimer = null; if (videoWatchers.size) video.restart(); }, 250);
  };
  video.on("packet", ({ kind, data }) => {
    const msg = Buffer.concat([Buffer.from([kind]), data]);
    for (const w of videoWatchers) {
      if (w.readyState !== 1) continue;
      // iroh viewers get a QUIC stream per GOP and drop a stale GOP themselves;
      // a dropped GOP means the link is below the bitrate, so the stream steps down.
      if (w.sendVideo) { if (!w.sendVideo(kind, data)) congested(); continue; }
      if (kind === 0) w._needKey = false;
      if (w._needKey) continue;
      if (w.bufferedAmount > 1_500_000) { w._needKey = true; resync(); continue; }
      w.send(msg);
    }
  });
  video.on("ended", () => { if (videoWatchers.size) resync(); });
  let lastDrop = 0;
  function congested() {
    const now = Date.now();
    if (now - lastDrop < 3000) return; // one step per burst of drops
    lastDrop = now;
    if (video.stepDown()) { console.log(`  video     link too slow, preset -> ${video.preset}`); video.restart(); }
  }
  setInterval(() => {
    if (video.running && Date.now() - lastDrop > 30_000 && video.stepUp()) { console.log(`  video     link recovered, preset -> ${video.preset}`); video.restart(); }
  }, 10_000).unref();

  // ── SSH bastion (sshportal/bifroest/cardea: jump-host access control) ───
  const bastion = new SSHBastion();
  for (const evt of ["user:registered", "host:registered", "access:created", "session:started", "session:ended"]) {
    bastion.on(evt, ({ client, credentials, ...payload }) => broadcast({ type: "bastion_event", bastionEvent: evt.split(":")[1], ...payload }));
  }

  // ── Advanced SSH server (bifroest/sshwifty: auth + command control) ─────
  const sshSrv = new AdvancedSSHServerManager();
  for (const evt of ["user:registered", "session:created", "command:executed", "session:ended"]) {
    sshSrv.on(evt, ({ client, pty, ...payload }) => broadcast({ type: "sshserver_event", sshEvent: evt.split(":")[1], ...payload }));
  }

  // ── Multi-protocol client (haven-ssh-client: profiles, host-key TOFU, keys)
  const mpc = new MultiProtocolClient();
  for (const evt of ["ssh:connected", "ssh:disconnected", "terminal:opened", "vnc:connected", "vnc:disconnected", "sftp:connected", "sftp:readdir", "sftp:upload", "sftp:download", "hostkey:new", "hostkey:changed"]) {
    mpc.on(evt, (payload) => broadcast({ type: "mproto_event", mprotoEvent: evt.split(":")[1], ...payload }));
  }

  // ── Run scheduler (codeman/codex-bee/kagora: auto-continue loops) ────────
  scheduler.init(async ({ job }) => {
    const c = job.chatId === "newest" ? chat.get(chat.summary().at(-1)?.id) : chat.get(job.chatId);
    if (c && String(job.text || "").trim()) chat.sendUserMessage(c, String(job.text));
    else broadcast({ type: "schedule_fired", jobId: job.id, note: c ? null : "no live chat for job" });
  });
  // ── Approval auto-deny (cc-pocket: unattended agents never stall) ────────
  approvalGuard.onAutoDenyCallback(({ chatId }) => {
    const c = chat.get(chatId);
    if (c) chat.cancel(c);
    broadcast({ type: "approval_auto_denied", chatId });
  });
  // Release held resources on shutdown: keep-awake helper and
  // activity sweep. Runs on graceful shutdown AND process.exit paths.
  process.on("exit", () => {
    power.dispose();
    activity.stop();
    video.stop();
    scheduler.stop();
    desktop.dispose();
    presence.dispose();
    mpc.dispose();
    sshSrv.stop();
    bastion.stop();
    devices.persist();
  });

  sessions.sessionEvents.on("output", ({ id, text }) => {
    activity.feed(id, text);
  });
  sessions.sessionEvents.on("exit", ({ id }) => activity.markChat(id, "idle")); // terminal exit = done
  sessions.sessionEvents.on("gone", ({ id }) => activity.forget(id));
  chat.chatEvents.on("state", ({ id, state }) => activity.markChat(id, state));
  // Sessions refresh on every chat-state transition (c9watch attention-first
  // list must reorder the moment an agent gets stuck, not only on create/close).
  chat.chatEvents.on("state", () => broadcast({ type: "sessions", items: allSessions() }));
  // Approval auto-deny countdown (cc-pocket): waiting starts the clock.
  chat.chatEvents.on("state", ({ id, state }) => {
    if (state === "waiting") approvalGuard.markWaiting(id);
    else approvalGuard.clearWaiting(id);
  });
  // Derived todos (c9watch/claude-threads): scan the finished turn's last
  // assistant message for markdown checkboxes and push the board.
  chat.chatEvents.on("state", ({ id, state }) => {
    if (state !== "idle" && state !== "error") return;
    const c = chat.get(id);
    if (!c) return;
    const items = agentTodos.observeTurnEnd(id, c.transcript);
    if (items) broadcast({ type: "todos_updated", id, items, derived: true });
  });
  // Queued follow-ups (1code/ccpocket/oc-remote): when the turn finishes,
  // send the next queued prompt so the phone can enqueue and walk away.
  // Broadcast the queue after every change — a silent drain leaves every
  // client showing a stale queue strip.
  chat.chatEvents.on("state", ({ id, state }) => {
    if (state !== "idle") return;
    const next = promptQueue.dequeue(id);
    if (!next) return;
    const c = chat.get(id);
    if (c) chat.sendUserMessage(c, next.text);
    broadcast({ type: "prompt_queue", id, items: promptQueue.list(id) });
  });
  // Usage stats (c9watch/flue/orca: cost + token dashboard).
  chat.chatEvents.on("usage", ({ id, usage: u, cost }) => {
    statsUsage.record(id, { ...u, total_cost_usd: cost });
    broadcast({ type: "usage_updated", id, totals: statsUsage.get(id) });
  });

  const ctx = {
    send, broadcast, allSessions, plugins, power,
    desktop, desktopWatchers, video, videoWatchers, presence, bastion, sshSrv, mpc, streamParser,
    activity, tls, rotateToken, disconnectDevice,
  };
  const handlers = {
    ...agentsHandlers(ctx), ...filesHandlers(ctx), ...remoteHandlers(ctx), ...sshHandlers(ctx), ...systemHandlers(ctx),
  };


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
    // The token is a pairing credential for the user's own devices: the full
    // token prints in dev only (never in production). /pair is loopback-gated.
    if (process.env.NODE_ENV !== 'production') {
      console.log(`  token     ${token}`);
    }
    if (useTls) {
      console.log(`  tls       enabled, cert fingerprint ${fp}`);
    }
    console.log(`  pairing   http${useTls ? "s" : ""}://localhost:${port}/pair  (open on THIS PC, scan the QR from the app)`);
    console.log("  config    %USERPROFILE%\\.pocketdesk\\config.json");
    console.log("");
    // iroh sockets join wss.clients so broadcast and revoke reach them like /ws sockets.
    if (irohCfg?.enabled) {
      startIroh({
        dir: configDir,
        relays: irohCfg.relays,
        onConnection(sock, remoteId) {
          sock._irohId = remoteId;
          // Hole punching settles within seconds; report where it landed.
          setTimeout(() => {
            const p = sock.readyState === 1 && sock.conn.paths().find((x) => x.isSelected);
            if (p) console.log(`  iroh      ${remoteId.slice(0, 8)} ${p.isRelay ? "relayed" : "direct"}, rtt ${p.rttMs} ms`);
          }, 8000).unref();
          wss.clients.add(sock);
          sock.once("close", () => wss.clients.delete(sock));
          wss.emit("connection", sock, { socket: { remoteAddress: `iroh:${remoteId}` } });
        },
      }).then((ep) => {
        if (!ep) return console.log("  iroh      unavailable (optional @number0/iroh not installed)");
        irohEp = ep;
        irohTicket = ep.ticket();
        buildPairPage(useTls);
        console.log(`  iroh      ${ep.id}`);
      }).catch((e) => console.log(`  iroh      failed to start: ${e?.message || e}`));
    }
    sessionStore.init();
    cliServer.start();
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
