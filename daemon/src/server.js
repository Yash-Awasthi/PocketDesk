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
import { createNotificationManager, NotificationEvents } from "./notifications.js";
import * as sessionStore from "./session-store.js";
import * as sdkAdapter from "./sdk-adapter.js";
import * as cliServer from "./cli-server.js";
import { SessionRecorder } from "./session_recorder.js";
import { TunnelManager } from "./tunnel_manager.js";
import { PowerManager, normalizeAwakeMode } from "./power_manager.js";
import { createActivityMonitor } from "./activity.js";
import { createShareManager } from "./shares.js";
import { startTelegramControl } from "./telegram_control.js";
import * as resurrect from "./resurrect.js";
import { PeerDiscovery } from "./lan_file_transfer.js";
import { StreamJsonParser } from "./stream_json_parser.js";
import { ShooterNotifications } from "./shooter_notifications.js";
import { RemoteDesktopBridgeManager } from "./remote_desktop_bridge.js";
import { WhatsAppBridgeManager } from "./whatsapp_bridge.js";
import { VNCBridge } from "./vnc_bridge.js";
import { DesktopController } from "./desktop_capture.js";
import { DesktopVideo } from "./desktop_video.js";
import { AdvancedSSHServerManager } from "./advanced_ssh_server.js";
import { SSHBastion } from "./ssh_bastion.js";
import { MultiProtocolClient } from "./ssh_vnc_client.js";
import * as promptQueue from "./prompt_queue.js";
import * as agentTodos from "./agent_todos.js";
import * as scheduler from "./scheduler.js";
import * as approvalGuard from "./approval_guard.js";
import * as mcpServer from "./mcp_server.js";
import * as liveDigest from "./live_digest.js";
import * as statsUsage from "./stats_usage.js";
import * as quietHours from "./quiet_hours.js";
import * as devices from "./devices.js";
import { createRelayBridge } from "./relay_bridge.js";
import agentsHandlers from "./handlers/agents.js";
import filesHandlers from "./handlers/files.js";
import remoteHandlers from "./handlers/remote.js";
import sshHandlers from "./handlers/ssh.js";
import systemHandlers from "./handlers/system.js";
import { startIroh } from "./iroh_link.js";
import { configDir } from "./config.js";

const HELLO_TIMEOUT = 10_000;
const MAX_AUTH_ATTEMPTS = 5;
// A read-only spectator may only do these. Allowlist, not per-case guards:
// there are ~190 handlers and every new one would default to writable,
// so a "read-only" share could still write files, install, or open tunnels.
const SPECTATOR_TYPES = new Set([
  "attach", "detach", "sessions", "sessions_get", "chat_text", "share_join",
]);
const SHARE_READ_TYPES = new Set(["attach", "detach", "chat_text"]);
const SHARE_WRITE_TYPES = new Set(["in", "resize", "chatmsg"]);
const authAttempts = new Map();
const pluginDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "plugins");

  function allSessions() {
  // Attention-first ordering (c9watch): permission-waiting and running
  // sessions surface to the top so an agent stuck on approval is unmissable.
  const rank = { waiting: 0, running: 1, error: 2 };
  const all = [...sessions.summary(), ...chat.summary()];
  return all.sort((a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9));
}

export function start({ port, token, tls, relay: relayCfg, iroh: irohCfg }, { onTokenRotated } = {}) {
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
  let pairFp = "";
  let irohTicket = "";
  let irohEp = null;
  // Rebuilt on token rotation, so the QR never shows a dead token.
  function buildPairPage(useTls, fingerprint = pairFp) {
    pairFp = fingerprint;
    const url = `${useTls ? "wss" : "ws"}://${lanAddress()}:${port}/ws`;
    // A hosting-only daemon is reachable at its own relay port; the phone needs
    // the concrete channel, not an empty "use the default".
    const relayUrl = relayCfg?.url || (relayCfg?.hostPort ? `relay://${lanAddress()}:${relayCfg.hostPort}` : "");
    const payload = Buffer.from(
      JSON.stringify({ u: url, t: token, f: fingerprint || "", r: relayUrl || undefined, c: relayUrl ? relayCfg?.channel || relay.defaultChannel() : undefined, i: irohTicket || undefined }),
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

          if (msg.type === "hello" && typeof msg.share === "string") {
            const joined = shares.join(msg.share);
            const sid = joined.ok && joined.share.sessionId;
            if (!joined.ok || !(chat.attach(sid, ws) || sessions.attach(sid, ws))) {
              if (joined.ok) shares.leave(msg.share);
              ws.close(4003, "bad share");
              return;
            }
            ws._authed = true;
            authAttempts.delete(clientIp);
            clearTimeout(timer);
            ws._shareToken = msg.share;
            ws._shareMode = joined.share.mode;
            ws._shareSession = sid;
            send(ws, { type: "share_joined", sessionId: sid, mode: joined.share.mode });
            return;
          }
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

  // A share-token socket sees only events about its own session, never the
  // session list or other sessions' state.
  function broadcast(obj) {
    for (const ws of wss.clients) {
      if (ws._authed && (!ws._shareSession || String(obj.id) === ws._shareSession)) send(ws, obj);
    }
    bridge.pushAuthed({ rh: true, type: "rhpush", data: obj });
  }

  function detachClient(ws) {
    if (ws._shareToken) shares.leave(ws._shareToken);
    sessions.detach(ws);
    chat.detach(ws);
    liveDigest.detach(ws);
    sdkAdapter.unsubscribe(ws);
  }

  function welcome(auth, hello, ip) {
    devices.register(auth.id, { name: hello.name, platform: hello.platform, ip });
    const deviceToken = auth.pairing ? devices.issueToken(auth.id) : undefined;
    return { type: "welcome", version: 1, clientId: auth.id, deviceToken, sessions: allSessions(), manifests: registry.list() };
  }

  function disconnectDevice(clientId) {
    for (const client of wss.clients) if (client._clientId === clientId) client.close(4003, "device revoked");
    bridge.dropDevice(clientId);
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

  function authenticateRelay(msg, nonce, from) {
    if (msg.type !== "hello" || !nonce) return null;
    if (devices.proofMatches(msg.proof, devices.hashToken(token), nonce, from)) {
      const id = String(msg.clientId || crypto.randomUUID());
      return devices.isRevoked(id) ? null : { id, pairing: true };
    }
    const d = devices.byRelayProof(msg.proof, nonce, from);
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
    if (ws._shareSession) {
      const rw = ws._shareMode === "readwrite" && SHARE_WRITE_TYPES.has(msg.type);
      if (!(SHARE_READ_TYPES.has(msg.type) || rw) || String(msg.id) !== ws._shareSession) {
        return send(ws, { type: "error", message: `not allowed for a shared session: ${msg.type}` });
      }
    }
    if (ws._shareMode === "readonly" && !SPECTATOR_TYPES.has(msg.type)) {
      return send(ws, { type: "error", message: `read-only (spectator): ${msg.type}` });
    }
    const h = Object.hasOwn(handlers, msg.type) ? handlers[msg.type] : null;
    if (!h) return send(ws, { type: "error", message: `unknown type: ${msg.type}` });
    await h(ws, msg);
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
    LINE_CHANNEL_ACCESS_TOKEN: process.env.LINE_CHANNEL_ACCESS_TOKEN,
    LINE_USER_ID: process.env.LINE_USER_ID,
    LINE_GROUP_ID: process.env.LINE_GROUP_ID,
    SLACK_WEBHOOK_URL: process.env.SLACK_WEBHOOK_URL,
  };
  const notifications = createNotificationManager({ config: notifConfig });
  const pluginCtx = { sessions, chat, registry, proposals, broadcast: null, notifications, config: { port, token, dataDir: process.env.POCKETDESK_DATA || ".pocketdesk" } };
  const plugins = createPluginManager(pluginCtx);
  pluginCtx.broadcast = broadcast; // wire after broadcast is defined

  // ── Absorbed feature managers ──────────────────────────────────────────────
  const recorder = new SessionRecorder();
  const tunnels = new TunnelManager();
  const power = new PowerManager({ mode: normalizeAwakeMode(process.env.RH_AWAKE || "auto") });
  const shares = createShareManager();
  const activity = createActivityMonitor({
    quietMs: (Number(process.env.RH_QUIET_MS) || 20_000),
    onEvent({ id, state }) {
      broadcast({ type: "activity", id, state });
      if (state === "quiet") notifications.send(NotificationEvents.SESSION_QUIET, { id });
      if (state === "asking") notifications.send(NotificationEvents.SESSION_ASKING, { id });
    },
  });
  activity.start();
  power.refresh();

  const bridge = createRelayBridge({ authenticate: authenticateRelay, welcome, handle, detachClient, broadcast });
  const relay = bridge.relay;
  if (relayCfg?.url) {
    relay.connect(relayCfg.url, relayCfg.channel || undefined);
  }
  if (relayCfg?.hostPort) {
    relay.host(Number(relayCfg.hostPort));
    // Hosting alone isn't enough: the bridge needs channel membership on the
    // hosted relay, so also dial ourselves over loopback. Remote peers then
    // reach the daemon through our relay with no extra config.
    if (!relayCfg.url) relay.connect(`relay://127.0.0.1:${relayCfg.hostPort}`, relayCfg.channel || undefined);
  }

  // ── Stream JSON parser (format-claude-stream: agent JSONL → structured) ──
  const streamParser = new StreamJsonParser();

  // ── WhatsApp bridge (channel surface; real baileys transport is roadmap) ──
  const wa = new WhatsAppBridgeManager();
  for (const evt of ["auth:qr", "auth:completed", "channel:ready", "message:received", "command:received", "message:sent", "channel:disconnected"]) {
    wa.on(evt, (payload) => broadcast({ type: "wa_event", waEvent: evt.replace(":", "_"), ...payload }));
  }
  // Commands from allowlisted phones drive terminal sessions.
  wa.on("command:received", ({ channelId, from, command }) => {
    const ch = wa.getChannels().find((c) => c.id === channelId);
    if (ch) sessions.write(ch.sessionId, command + "\n");
  });

  // ── Real desktop capture + input (the frame SOURCE for rd_/desktop UIs) ──
  // Frames are client-scoped (a watching ws gets them directly — they are
  // ~200-300 KB each, too heavy for the broadcast fan-out) and the capture
  // loop runs only while at least one watcher is attached.
  const desktop = new DesktopController();
  const desktopWatchers = new Set();
  desktop.on("frame", (frame) => {
    for (const w of desktopWatchers) {
      try {
        send(w, { type: "desktop_frame", ...frame });
      } catch { /* watcher vanished mid-send */ }
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
      // iroh viewers get a QUIC stream per GOP and drop a stale GOP themselves.
      if (w.sendVideo) { if (!w.sendVideo(kind, data)) resync(); continue; }
      if (kind === 0) w._needKey = false;
      if (w._needKey) continue;
      if (w.bufferedAmount > 1_500_000) { w._needKey = true; resync(); continue; }
      w.send(msg);
    }
  });
  video.on("ended", () => { if (videoWatchers.size) resync(); });

  // ── Remote desktop bridge (rustdesk/remodex: session-scoped screen+input) ──
  const rd = new RemoteDesktopBridgeManager(desktop);
  for (const evt of ["session:connected", "session:disconnected", "frame:received", "input:forwarded", "quality:updated"]) {
    rd.on(evt, (payload) => broadcast({ type: "rd_event", rdEvent: evt.split(":")[1], ...payload }));
  }

  // ── VNC bridge (noVNC/guacamole: TCP frame server fed by real capture) ──
  const vnc = new VNCBridge(5900, desktop);
  for (const evt of ["bridge:started", "bridge:stopped", "client:connected", "frame:received"]) {
    vnc.on(evt, (payload) => broadcast({ type: "vnc_event", vncEvent: evt.split(":")[1], ...payload }));
  }

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

  // ── Smart notifications (shooter: decision-first + coalescing/dedupe) ─────
  // The brain decides; the existing channel registry (notifications.js) delivers.
  const shooter = new ShooterNotifications({ channels: ["web"] });
  shooter.on("notification", (event) => {
    notifications.send("shooter:" + event.type, { projectId: event.projectId, text: event.text });
    broadcast({ type: "notify_event", event });
  });

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
  // ── MCP server (quil/paseo: expose agents as MCP tools over localhost) ──
  if (process.env.RH_MCP_PORT) mcpServer.start(process.env.RH_MCP_PORT);

  // ── LAN file transfer (lanlink: LocalSend v2 + UDP peer discovery) ────────
  const lanDiscovery = new PeerDiscovery({ alias: process.env.RH_LAN_ALIAS || "PocketDesk" });
  let lanDiscoveryStarted = false;
  function ensureLanDiscovery() {
    if (lanDiscoveryStarted) return;
    lanDiscoveryStarted = true;
    lanDiscovery.start().catch(() => {});
  }

  // Release held resources on shutdown: keep-awake helper, tunnel listeners,
  // activity sweep. Runs on graceful shutdown AND process.exit paths.
  process.on("exit", () => {
    power.dispose();
    tunnels.closeAll();
    activity.stop();
    relay.dispose();
    video.stop();
    if (lanDiscoveryStarted) { try { lanDiscovery.stop(); } catch {} }
    scheduler.stop();
    liveDigest.stop();
    mcpServer.stop();
    desktop.dispose();
    mpc.dispose();
    sshSrv.stop();
    bastion.stop();
    for (const ch of wa.getChannels()) wa.disconnect(ch.id);
    devices.persist();
  });

  sessions.sessionEvents.on("output", ({ id, text }) => {
    activity.feed(id, text);
    try { recorder.recordOutput(id, text); } catch {}
    liveDigest.feed(id, text);
  });
  sessions.sessionEvents.on("exit", ({ id }) => activity.markChat(id, "idle")); // terminal exit = done
  sessions.sessionEvents.on("gone", ({ id }) => activity.forget(id));
  chat.chatEvents.on("state", ({ id, state }) => activity.markChat(id, state));
  // Sessions refresh on every chat-state transition (c9watch attention-first
  // list must reorder the moment an agent gets stuck, not only on create/close).
  chat.chatEvents.on("state", () => broadcast({ type: "sessions", items: allSessions() }));
  chat.chatEvents.on("state", ({ id, state, cliSession }) => {
    if (state === "idle" || state === "error") resurrect.touch(id, cliSession);
  });
  // Approval auto-deny countdown (cc-pocket): waiting starts the clock.
  chat.chatEvents.on("state", ({ id, state }) => {
    if (state === "waiting") approvalGuard.markWaiting(id);
    else approvalGuard.clearWaiting(id);
  });
  // Quiet hours (marchat/shooter): notifications respect the schedule —
  // decision-first events bypass in "priority" mode.
  const _notifySendQuiet = notifications.send.bind(notifications);
  notifications.send = (event, payload) => {
    const decision = quietHours.shouldDeliver(event);
    if (!decision.deliver) return false;
    return _notifySendQuiet(event, payload);
  };
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
    send, broadcast, allSessions, notifications, plugins, power, shares, recorder, tunnels, relay, wa, rd, vnc,
    desktop, desktopWatchers, video, videoWatchers, bastion, sshSrv, mpc, shooter, streamParser, lanDiscovery, ensureLanDiscovery,
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
    if (relayCfg?.url) console.log(`  relay     out → ${relayCfg.url}  channel ${relayCfg.channel || relay.defaultChannel()}`);
    if (relayCfg?.hostPort) console.log(`  relay     hosting :${relayCfg.hostPort}  (phone URL: relay://<this-pc>:${relayCfg.hostPort}/${relayCfg.channel || relay.defaultChannel()})`);
    console.log("  config    %USERPROFILE%\\.pocketdesk\\config.json");
    console.log("");
    // iroh sockets join wss.clients so broadcast and revoke reach them like /ws sockets.
    if (irohCfg?.enabled) {
      startIroh({
        dir: configDir,
        relays: irohCfg.relays,
        onConnection(sock, remoteId) {
          sock._irohId = remoteId;
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
    // Two-way Telegram control — inbound leg (channels/* are outbound only).
    if (process.env.TELEGRAM_BOT_TOKEN && process.env.TELEGRAM_ALLOW_CHAT_IDS) {
      startTelegramControl({
        token: process.env.TELEGRAM_BOT_TOKEN,
        allowChatIds: process.env.TELEGRAM_ALLOW_CHAT_IDS.split(",").map((s) => s.trim()).filter(Boolean),
        handlers: {
          listSessions: () => allSessions(),
          say: (id, text) => {
            const c = chat.get(id);
            return c ? chat.sendUserMessage(c, String(text || "")) : false;
          },
          listProposals: () => proposals.listPending(),
          decide: (pid, approve) => (approve ? proposals.approve(pid) : proposals.reject(pid)),
          newestChat: () => {
            const cs = chat.summary();
            return cs.length ? cs[cs.length - 1].id : null;
          },
        },
      });
    }
  });
}
