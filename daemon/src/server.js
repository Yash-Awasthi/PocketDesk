import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { exec } from "node:child_process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { WebSocketServer } from "ws";
import * as registry from "./registry.js";
import * as appDiscovery from "./app_discovery.js";
import * as sessions from "./sessions.js";
import * as chat from "./chat.js";
import { createPluginManager } from "./plugins.js";
import * as proposals from "./proposals.js";
import { createNotificationManager, NotificationEvents } from "./notifications.js";
import * as voice from "./voice.js";
import * as sessionStore from "./session-store.js";
import * as sdkAdapter from "./sdk-adapter.js";
import * as portForward from "./port-forward.js";
import * as cliServer from "./cli-server.js";
import * as slashCommands from "./slash-commands.js";
import * as auditLog from "./audit-log.js";
import { SessionRecorder } from "./session_recorder.js";
import { TunnelManager } from "./tunnel_manager.js";
import { PowerManager, normalizeAwakeMode } from "./power_manager.js";
import { createActivityMonitor } from "./activity.js";
import { createShareManager } from "./shares.js";
import { hostStats } from "./stats.js";
import { gitStatus, gitDiff, gitLog, gitBranches } from "./gitpanel.js";
import { startTelegramControl } from "./telegram_control.js";
import * as resurrect from "./resurrect.js";
import { createRelayLink } from "./relay.js";
import { TerminalRenderer } from "./terminal_renderer.js";
import { PeerDiscovery, sendFiles, getLocalIPs } from "./lan_file_transfer.js";
import { StreamJsonParser } from "./stream_json_parser.js";
import { ShooterNotifications } from "./shooter_notifications.js";
import { RemoteDesktopBridgeManager } from "./remote_desktop_bridge.js";
import { WhatsAppBridgeManager } from "./whatsapp_bridge.js";
import { VNCBridge } from "./vnc_bridge.js";
import { DesktopController } from "./desktop_capture.js";
import { AdvancedSSHServerManager } from "./advanced_ssh_server.js";
import { SSHBastion } from "./ssh_bastion.js";
import { MultiProtocolClient } from "./ssh_vnc_client.js";
import * as fbCtrl from "./freebuff_control.js";
import * as promptQueue from "./prompt_queue.js";
import * as agentTodos from "./agent_todos.js";
import * as scheduler from "./scheduler.js";
import * as mentions from "./mentions.js";
import * as doctor from "./doctor.js";
import * as wakeOnLan from "./wake_on_lan.js";
import * as approvalGuard from "./approval_guard.js";
import * as mcpServer from "./mcp_server.js";
import * as liveDigest from "./live_digest.js";
import * as statsUsage from "./stats_usage.js";
import * as worktrees from "./worktrees.js";
import * as quietHours from "./quiet_hours.js";
import * as devices from "./devices.js";
import * as envProfiles from "./env_profiles.js";
import * as planMode from "./plan_mode.js";

const HELLO_TIMEOUT = 10_000;
const MAX_AUTH_ATTEMPTS = 5;
// A read-only spectator may only do these. Allowlist, not per-case guards:
// the handler switch has ~230 cases and every new one defaulted to writable,
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

export function start({ port, token, tls, relay: relayCfg }, { onTokenRotated } = {}) {
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
      JSON.stringify({ u: url, t: token, f: fingerprint || "", r: relayCfg?.url || undefined, c: relayCfg?.channel || undefined }),
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
      if (ws._shareToken) shares.leave(ws._shareToken);
      sessions.detach(ws);
      chat.detach(ws);
      liveDigest.detach(ws);
      sdkAdapter.unsubscribe(ws);
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
            ws._authed = true;
            authAttempts.delete(clientIp);
            clearTimeout(timer);
            const _decayAuthAttempts = () => { for (const [ip, rec] of authAttempts) if (Date.now() - rec.at > 10 * 60_000) authAttempts.delete(ip); };
            _decayAuthAttempts();
            // Device registry (openchamber/netbird): stable per-client id with
            // revocation check at hello.
            ws._clientId = auth.id;
            devices.register(auth.id, { name: msg.name, platform: msg.platform, ip: clientIp });
            const deviceToken = auth.pairing ? devices.issueToken(auth.id) : undefined;
            send(ws, { type: "welcome", version: 1, clientId: auth.id, deviceToken, sessions: allSessions(), manifests: registry.list() });
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
    // Mirror broadcasts to relay peers as `rhpush` so remote (off-LAN) clients
    // see live output (sessions, out, chatdelta, manifests, relay_state, …).
    // Addressed per peer, never published to the channel: the relay has no
    // auth of its own, so anyone who guessed the channel name would otherwise
    // read every session's output without ever presenting the token.
    relayPushAuthed({ rh: true, type: "rhpush", data: obj });
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
    switch (msg.type) {
      case "detect":
        await registry.scanAll(broadcast);
        break;
      case "install":
        registry.install(msg.id, broadcast).catch((e) => send(ws, { type: "error", message: `install failed: ${e?.message || e}` }));
        break;
      case "create": {
        // A discovered CLI tool has no manifest, so the phone sends its path
        // instead of a harness id; the PTY does not care which it was.
        // The path reaches the PTY's `cmd /c`, so only a discovered tool is
        // accepted — an arbitrary string would be a command injection.
        const tool = msg.path ? appDiscovery.find(String(msg.path)) : null;
        if (msg.path && !tool) return send(ws, { type: "error", message: `not a discovered tool: ${msg.path}` });
        const m = tool
          ? { id: tool.name, name: tool.name, bin: tool.path, adapter: "terminal" }
          : registry.get(msg.harness);
        if (!m || m.adapter !== "terminal") return send(ws, { type: "error", message: `unknown harness: ${msg.harness}` });
        if (!msg.path && !registry.isInstalled(m.id)) return send(ws, { type: "error", message: `${m.name} is not installed` });
        auditLog.log("session_create", { harness: m.id, cwd: msg.cwd });
        const s = sessions.create({ harnessId: m.id, bin: m.bin, cwd: msg.cwd, args: msg.args }, broadcast);
        sessionStore.upsert(s.id, { name: m.name, project: msg.cwd || "", type: "terminal", status: "working" });
        notifications.send(NotificationEvents.SESSION_CONNECTED, { harness: m.name, cwd: msg.cwd });
        plugins.callHook("onSessionCreated", s);
        power.addStatus({ agentId: s.id, state: "running", receivedAt: Date.now() });
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
        sessionStore.upsert(s.id, { name: m.name, project: msg.cwd || "", type: "chat", status: "idle" });
        notifications.send(NotificationEvents.SESSION_CONNECTED, { harness: m.name, cwd: msg.cwd });
        plugins.callHook("onChatCreated", s);
        power.addStatus({ agentId: s.id, state: "running", receivedAt: Date.now() });
        resurrect.upsert({ id: s.id, harnessId: m.id, cwd: s.cwd });
        chat.attach(s.id, ws);
        send(ws, { type: "created", ...s });
        if (String(msg.prompt || "").trim()) {
          chat.sendUserMessage(chat.get(s.id), String(msg.prompt));
        }
        broadcast({ type: "sessions", items: allSessions() });
        break;
      }
      case "chatmsg": {
        if (ws._shareMode === "readonly") return send(ws, { type: "error", message: "chat is read-only (spectator)" });
        const c = chat.get(msg.id);
        if (!c) return send(ws, { type: "error", message: `no such chat: ${msg.id}` });
        if (c.state === "running") return send(ws, { type: "error", message: "still working on the previous prompt" });
        chat.attach(msg.id, ws);
        const text = String(msg.text || "");
        if (text.startsWith("/")) {
          const result = slashCommands.handle(text, msg.id);
          send(ws, { type: "chatdelta", id: msg.id, text: result + "\n" });
          break;
        }
        chat.sendUserMessage(c, text);
        broadcast({ type: "sessions", items: allSessions() });
        break;
      }
      // ── Chat forking (1code): clone transcript up to a message into a sub-chat ──
      // ── Sessions list on request (phone reconnect asks for current state) ──
      case "sessions":
        send(ws, { type: "sessions", items: allSessions() });
        break;
      case "chat_fork": {
        const r = chat.forkChat(String(msg.id), msg.at ?? -1, { cwd: msg.cwd, env: msg.env });
        if (!r.ok) return send(ws, { type: "error", message: r.error });
        sessionStore.upsert(r.chat.id, { name: "fork", project: r.chat.cwd, type: "chat", status: "idle" });
        send(ws, { type: "chat_forked", ok: true, chat: r.chat });
        broadcast({ type: "sessions", items: allSessions() });
        break;
      }
      // ── Env profiles / BYOK (1code, Vibe Companion): per-chat env overrides ──
      case "env_profile_list":
        send(ws, { type: "env_profiles", items: envProfiles.list() });
        break;
      case "env_profile_set": {
        const r = envProfiles.set(String(msg.name ?? ""), msg.vars);
        send(ws, r.ok ? { type: "env_profile_ok", ok: true, name: msg.name } : { type: "error", message: r.error });
        break;
      }
      case "env_profile_remove": {
        const r = envProfiles.remove(String(msg.name ?? ""));
        send(ws, r.ok ? { type: "env_profile_ok", ok: true, name: msg.name } : { type: "error", message: r.error });
        break;
      }
      case "env_profile_attach": {
        const r = envProfiles.attach(String(msg.id), String(msg.name ?? ""));
        send(ws, r.ok ? { type: "env_profile_ok", ok: true, id: r.id, profile: r.profile, keys: r.keys } : { type: "error", message: r.error });
        break;
      }
      case "env_profile_detach": {
        const r = envProfiles.detach(String(msg.id));
        send(ws, r.ok ? { type: "env_profile_ok", ok: true, id: r.id } : { type: "error", message: r.error });
        break;
      }
      // ── Plan mode (1code): extract the agent's checklist plan, approve it ──
      case "plan_get": {
        const r = planMode.getPlan(String(msg.id));
        if (!r.ok) return send(ws, { type: "error", message: r.error });
        send(ws, { type: "plan", id: r.id, plan: r.plan, approved: r.approved });
        break;
      }
      case "plan_approve": {
        const r = planMode.approve(String(msg.id), msg.approved);
        if (!r.ok) return send(ws, { type: "error", message: r.error });
        send(ws, { type: "plan_ok", id: r.id, approved: r.approved });
        break;
      }
      // ── Permission-mode switch per running chat (agent-tmux-web/claude-threads) ──
      case "chat_permission": {
        const c = chat.get(msg.id);
        if (!c) return send(ws, { type: "error", message: `no such chat: ${msg.id}` });
        c.permissionMode = String(msg.mode ?? "default");
        send(ws, { type: "chat_permission_ok", id: c.id, mode: c.permissionMode });
        break;
      }
      // ── Plain-text scrollback (retach: native-scrollback passthrough) ──
      case "chat_text": {
        const c = chat.get(msg.id);
        if (!c) return send(ws, { type: "error", message: `no such chat: ${msg.id}` });
        const text = (c.transcript ?? []).map((it) => {
          if (it.role === "user") return `❯ ${it.text}`;
          if (it.role === "assistant") return it.text;
          if (it.role === "tool") return `[tool:${it.name}] ${it.detail}`;
          if (it.role === "system") return `[system] ${it.text}`;
          return "";
        }).filter(Boolean).join("\n\n");
        send(ws, { type: "chat_text", id: c.id, text });
        break;
      }
      case "chatcancel": {
        if (ws._shareMode === "readonly") return send(ws, { type: "error", message: "chat is read-only (spectator)" });
        const c = chat.get(msg.id);
        if (c) {
          chat.cancel(c);
          broadcast({ type: "sessions", items: allSessions() });
        }
        break;
      }
      case "attach":
        if (!chat.attach(msg.id, ws) && !sessions.attach(msg.id, ws, { since: msg.since })) {
          send(ws, { type: "error", message: `no live session: ${msg.id}` });
        }
        break;
      case "sessions_get":
        send(ws, { type: "sessions_get", items: allSessions() });
        break;
      case "sessions_scan": {
        // Zero-touch OS-level agent scan (c9watch/nexting): which known agent
        // binaries have live processes right now, with their command lines.
        try {
          // `wmic` was removed in Windows 11 24H2, so the tasklist fallback is
          // the normal path there. It must not use `/v`: window titles take it
          // from ~0.35s to ~21s, past the timeout, and only image names are
          // matched here anyway.
          const { stdout: out } = await promisify(exec)("wmic process get processid,commandline /format:csv 2>nul || tasklist /fo csv /nh", { encoding: "utf-8", timeout: 8000, windowsHide: true });
          const lines = String(out).split(/\r?\n/).filter(Boolean);
          // GUI manifests have no `bin`: they are detected by path, not by a
          // process name, so they cannot be matched against a command line.
          const known = registry
            .list()
            .map((r) => r.manifest.bin)
            .filter(Boolean)
            .map((bin) => bin.toLowerCase().replace(/\.(exe|cmd|bat)$/, ""));
          const found = [];
          for (const line of lines) {
            const low = line.toLowerCase();
            for (const bin of known) {
              if (low.includes(bin) && !found.some((f) => f.bin === bin)) {
                found.push({ bin, sample: line.slice(0, 300) });
              }
            }
          }
          send(ws, { type: "sessions_scan", items: found, scannedAt: Date.now() });
        } catch (e) {
          send(ws, { type: "sessions_scan", items: [], error: e.message });
        }
        break;
      }
      case "detach":
        sessions.detach(ws, msg.id);
        chat.detach(ws, msg.id);
        break;
      case "in":
        if (ws._shareMode === "readonly") return send(ws, { type: "error", message: "session is read-only (spectator)" });
        sessions.write(msg.id, Buffer.from(msg.data, "base64").toString("utf8"));
        break;
      case "resize":
        sessions.resize(msg.id, msg.cols, msg.rows);
        break;
      case "kill":
        if (ws._shareMode === "readonly") return send(ws, { type: "error", message: "session is read-only (spectator)" });
        auditLog.log("session_kill", { id: msg.id });
        if (chat.get(msg.id)) {
          chat.cancel(chat.get(msg.id));
          sessionStore.setStatus(msg.id, "killed");
        } else {
          sessions.kill(msg.id);
          sessionStore.setStatus(msg.id, "killed");
        }
        power.removeStatus(msg.id);
        resurrect.remove(msg.id);
        shares.revokeSession(msg.id);
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
      case "transcribe": {
        if (!voice.isAvailable()) {
          send(ws, { type: "error", message: "Voice transcription unavailable. Set OPENAI_API_KEY." });
          break;
        }
        try {
          const text = await voice.transcribe(msg.audio, msg.format, msg.language);
          send(ws, { type: "transcribed", text });
        } catch (e) {
          send(ws, { type: "error", message: e.message });
        }
        break;
      }
      case "sdk_launch": {
        const m = registry.get(msg.harness);
        if (!m) return send(ws, { type: "error", message: `unknown harness: ${msg.harness}` });
        const s = sdkAdapter.launch({ bin: m.bin, cwd: msg.cwd, args: m.chat?.args, model: msg.model, permissionMode: msg.permissionMode });
        sessionStore.upsert(s.id, { name: m.name, project: msg.cwd || "", type: "sdk", status: "starting" });
        send(ws, { type: "sdk_created", id: s.id, cwd: s.cwd });
        broadcast({ type: "sessions", items: allSessions() });
        break;
      }
      case "sdk_prompt": {
        if (!sdkAdapter.sendPrompt(msg.id, String(msg.text || ""))) {
          send(ws, { type: "error", message: `no connected SDK session: ${msg.id}` });
        }
        break;
      }
      case "sdk_approve": {
        sdkAdapter.approve(msg.id, msg.requestId, msg.approved);
        break;
      }
      case "sdk_interrupt": {
        sdkAdapter.interrupt(msg.id);
        break;
      }
      case "sdk_subscribe": {
        sdkAdapter.subscribe(msg.id, ws);
        break;
      }
      case "chat_history":
        send(ws, { type: "chat_history", items: chat.listHistory() });
        break;
      case "pin":
        registry.pin(msg.id);
        send(ws, { type: "pinned", ids: registry.listPinned() });
        break;
      case "unpin":
        registry.unpin(msg.id);
        send(ws, { type: "pinned", ids: registry.listPinned() });
        break;
      case "forward_start": {
        const fw = portForward.start({ id: msg.id || "fwd" + Date.now(), localPort: msg.localPort, remoteHost: msg.remoteHost, remotePort: msg.remotePort });
        send(ws, { type: "forward_started", ...fw });
        break;
      }
      case "forward_stop":
        portForward.stop(msg.id);
        send(ws, { type: "forward_stopped", id: msg.id });
        break;
      case "forward_list":
        send(ws, { type: "forward_list", items: portForward.list() });
        break;
      case "audit_log":
        send(ws, { type: "audit_log", items: auditLog.getLog(msg.limit) });
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
      // ── Session shares (ttyd/gotty/termpair: read-only spectators) ──
      case "share_create": {
        const share = shares.create({ sessionId: msg.id, mode: msg.mode, ttlMinutes: msg.ttlMinutes, maxViewers: msg.maxViewers });
        auditLog.log("share_create", { id: msg.id, mode: share.mode });
        send(ws, { type: "share_created", token: share.token, sessionId: share.sessionId, mode: share.mode, expiresAt: share.expiresAt });
        break;
      }
      case "share_join": {
        const joined = shares.join(msg.token);
        if (!joined.ok) return send(ws, { type: "error", message: joined.error });
        const share = joined.share;
        const attached = chat.attach(share.sessionId, ws) || sessions.attach(share.sessionId, ws);
        if (!attached) {
          shares.leave(share.token);
          return send(ws, { type: "error", message: `shared session no longer live: ${share.sessionId}` });
        }
        if (ws._shareToken) shares.leave(ws._shareToken);
        ws._shareToken = share.token;
        ws._shareMode = share.mode;
        send(ws, { type: "share_joined", sessionId: share.sessionId, mode: share.mode });
        break;
      }
      case "share_list":
        send(ws, { type: "share_list", items: shares.list() });
        break;
      case "share_revoke":
        shares.revoke(msg.token);
        send(ws, { type: "share_revoked", token: msg.token });
        break;
      // ── Host stats (webmux/vmux host cards) ──
      case "stats":
        send(ws, hostStats());
        break;
      // ── Git panel (ccpocket/vibego: read-only repo inspection) ──
      case "git_status":
        send(ws, { type: "git_status", ...(await gitStatus(msg.cwd || sessions.get(msg.id)?.cwd)) });
        break;
      case "git_diff":
        send(ws, { type: "git_diff", ...(await gitDiff(msg.cwd || sessions.get(msg.id)?.cwd)) });
        break;
      case "git_log":
        send(ws, { type: "git_log", ...(await gitLog(msg.cwd || sessions.get(msg.id)?.cwd, msg.limit)) });
        break;
      case "git_branches":
        send(ws, { type: "git_branches", ...(await gitBranches(msg.cwd || sessions.get(msg.id)?.cwd)) });
        break;
      // ── Session recording (asciinema/termpair: record + replay/export) ──
      case "record_start":
        recorder.startRecording(msg.id);
        send(ws, { type: "recording", id: msg.id, active: true });
        break;
      case "record_stop": {
        const rec = recorder.stopRecording(msg.id);
        send(ws, { type: "recording", id: msg.id, active: false, events: rec?.events?.length ?? 0 });
        break;
      }
      case "record_list":
        send(ws, { type: "record_list", items: recorder.listSessions() });
        break;
      case "record_get":
        send(ws, { type: "record_get", id: msg.id, events: recorder.getEvents(msg.id), export: recorder.exportSession(msg.id, msg.format || "json") });
        break;
      // ── Tunnels (frp/bore-lite: reach PC-local services from the phone) ──
      case "tunnel_create": {
        try {
          const id = await tunnels.createTunnel(Number(msg.localPort), Number(msg.remotePort), { bindAll: Boolean(msg.bindAll) });
          send(ws, { type: "tunnel_created", id, localPort: msg.localPort, remotePort: msg.remotePort });
        } catch (e) {
          send(ws, { type: "tunnel_created", ok: false, error: e.message, localPort: msg.localPort, remotePort: msg.remotePort });
        }
        break;
      }
      case "tunnel_close":
        tunnels.closeTunnel(msg.id);
        send(ws, { type: "tunnel_closed", id: msg.id });
        break;
      case "tunnel_list":
        send(ws, { type: "tunnel_list", items: tunnels.listTunnels() });
        break;
      // ── Relay (hermes-relay: outbound link + optional relay hosting) ────
      case "relay_connect": {
        const url = msg.url || process.env.RH_RELAY_URL;
        const channel = msg.channel || process.env.RH_RELAY_CHANNEL || relay.defaultChannel();
        if (!url) {
          send(ws, { type: "relay_state", state: "error", message: "no relay url (set RH_RELAY_URL or pass msg.url)" });
          break;
        }
        relay.connect(url, channel);
        send(ws, { type: "relay_state", state: "connecting", url, channel });
        break;
      }
      case "relay_disconnect":
        relay.disconnect();
        send(ws, { type: "relay_state", state: "disconnected" });
        break;
      case "relay_status":
        send(ws, { type: "relay_status", ...relay.status() });
        break;
      case "relay_publish":
        relay.publish(msg.data);
        send(ws, { type: "relay_published", channel: relay.status().channel });
        break;
      case "relay_send":
        relay.sendTo(msg.to, msg.data);
        send(ws, { type: "relay_sent", to: msg.to });
        break;
      case "relay_host":
        relay.host(Number(msg.port));
        send(ws, { type: "relay_host", state: "hosting", port: msg.port });
        break;
      case "relay_host_stop":
        relay.hostStop();
        send(ws, { type: "relay_host", state: "stopped" });
        break;
      // ── Digest render (restty: plain-text read-only render, token savings) ──
      case "render_digest": {
        const renderer = new TerminalRenderer({ cols: msg.cols || 80, rows: msg.rows || 24 });
        renderer.feed(String(msg.text ?? ""));
        const screen = renderer.getScreen().map((row) => row.replace(/\s+$/, ""));
        // Trailing all-blank rows carry no information — trim them for the wire.
        while (screen.length > 0 && screen[screen.length - 1]?.trim() === "") screen.pop();
        send(ws, { type: "digest_render", rows: screen, width: renderer.cols });
        break;
      }
      // ── LAN file transfer (lanlink: LocalSend v2 + UDP discovery) ─────────
      case "lan_peers":
        ensureLanDiscovery();
        send(ws, { type: "lan_peers", active: lanDiscoveryStarted, peers: lanDiscovery.getPeers(), ips: getLocalIPs() });
        break;
      case "lan_send": {
        try {
          const result = await sendFiles(String(msg.ip), Number(msg.port), [resolvePath(msg.path)]);
          send(ws, { type: "lan_sent", ok: true, ...result, peer: msg.ip });
        } catch (e) {
          send(ws, { type: "lan_sent", ok: false, peer: msg.ip, error: e.message });
        }
        break;
      }
      // ── WhatsApp bridge (whatsapp-claude-plugin: channel surface) ─────────
      case "wa_create": {
        const ch = wa.createChannel(String(msg.sessionId ?? ""), { allowedNumbers: Array.isArray(msg.allowedNumbers) ? msg.allowedNumbers.map(String) : [], commandPrefix: msg.commandPrefix ? String(msg.commandPrefix) : undefined, transport: msg.transport });
        send(ws, { type: "wa_channel", channel: ch });
        break;
      }
      case "wa_auth_start": {
        // A WhatsApp channel's QR arrives asynchronously on wa_event/qr; the
        // ack here only says the socket booted.
        try {
          const qr = await wa.startAuthentication(String(msg.channelId ?? ""));
          send(ws, { type: "wa_qr", ok: qr !== null, channelId: msg.channelId, qr: qr ?? undefined });
        } catch (e) {
          send(ws, { type: "wa_qr", ok: false, channelId: msg.channelId, error: e.message });
        }
        break;
      }
      case "wa_auth_complete": {
        const ok = wa.completeAuthentication(String(msg.channelId ?? ""), String(msg.phoneNumber ?? ""));
        send(ws, { type: "wa_auth_ok", ok });
        break;
      }
      case "wa_ready": {
        const ok = wa.markReady(String(msg.channelId ?? ""));
        send(ws, { type: "wa_ready_ok", ok });
        break;
      }
      case "wa_incoming": {
        wa.handleMessage(String(msg.channelId ?? ""), { id: String(msg.messageId ?? ""), from: String(msg.from ?? ""), to: "", body: String(msg.body ?? ""), timestamp: new Date(), isGroup: false });
        send(ws, { type: "wa_incoming_ok", ok: true });
        break;
      }
      case "wa_reply": {
        const ok = wa.sendReply(String(msg.channelId ?? ""), String(msg.to ?? ""), String(msg.body ?? ""));
        send(ws, { type: "wa_reply_ok", ok });
        break;
      }
      case "wa_messages":
        send(ws, { type: "wa_messages", items: wa.getMessages(String(msg.channelId ?? ""), Number(msg.limit) || 50) });
        break;
      case "wa_list":
        send(ws, { type: "wa_list", items: wa.getChannels() });
        break;
      case "wa_stats":
        send(ws, { type: "wa_stats", ...wa.getStats() });
        break;
      case "wa_disconnect": {
        const ok = wa.disconnect(String(msg.channelId ?? ""));
        send(ws, { type: "wa_disconnected", ok });
        break;
      }
      // ── Remote desktop bridge (rustdesk/remodex: sessions + input + transfers) ──
      case "rd_create": {
        const s = await rd.createSession(String(msg.hostName ?? "pc"), String(msg.hostIp ?? "local"), msg.quality);  // eslint-disable-line no-use-before-define
        send(ws, { type: "rd_session", session: { ...s, connectedAt: s.connectedAt.toISOString(), lastActivity: s.lastActivity.toISOString() } });
        break;
      }
      case "rd_frame": {
        const f = await rd.getFrame(String(msg.sessionId ?? ""));
        send(ws, f.ok ? { type: "rd_frame", sessionId: msg.sessionId, ...f } : { type: "rd_frame_error", sessionId: msg.sessionId, reason: f.reason });
        break;
      }
      case "rd_input": {
        const r = await rd.sendInput(String(msg.sessionId ?? ""), { type: String(msg.inputType ?? "mouse_move"), x: msg.x, y: msg.y, button: msg.button, wheel: msg.wheel, key: msg.key, text: msg.text, modifiers: Array.isArray(msg.modifiers) ? msg.modifiers : [] });
        send(ws, { type: "rd_input_ok", ok: !!r.ok, reason: r.reason, error: r.error });
        break;
      }
      case "rd_quality": {
        const ok = rd.updateQuality(String(msg.sessionId ?? ""), String(msg.quality ?? "medium"));
        send(ws, { type: "rd_quality_ok", ok });
        break;
      }
      case "rd_disconnect": {
        const ok = rd.disconnect(String(msg.sessionId ?? ""));
        send(ws, { type: "rd_disconnected", ok });
        break;
      }
      case "rd_list":
        send(ws, { type: "rd_list", items: rd.getActiveSessions().map((s) => ({ ...s, connectedAt: s.connectedAt.toISOString(), lastActivity: s.lastActivity.toISOString() })) });
        break;
      case "rd_stats":
        send(ws, { type: "rd_stats", ...rd.getStats() });
        break;
      // ── VNC bridge (noVNC/guacamole: TCP frame server + frame feed) ──────
      case "vnc_start": {
        const r = await vnc.start(Number(msg.port) || 0, { bindAll: Boolean(msg.bindAll) });
        send(ws, { type: "vnc_started", ...r });
        break;
      }
      case "vnc_stop": {
        const r = await vnc.stop();
        send(ws, { type: "vnc_stopped", ...r });
        break;
      }
      case "vnc_status":
        send(ws, { type: "vnc_status", ...vnc.getStatus() });
        break;
      case "vnc_frame": {
        vnc.updateFrame(Buffer.from(String(msg.data ?? ""), "base64"), { width: Number(msg.width) || 0, height: Number(msg.height) || 0 });
        send(ws, { type: "vnc_frame_ok", ok: true });
        break;
      }
      // ── SSH bastion (sshportal/bifroest: users, hosts, access rules) ─────
      case "bastion_user_add": {
        const user = bastion.registerUser(String(msg.username ?? ""), String(msg.publicKey ?? ""), String(msg.accessLevel ?? "limited"), msg.email ? String(msg.email) : undefined);
        send(ws, { type: "bastion_user_added", ok: true, user });
        break;
      }
      case "bastion_user_list":
        send(ws, { type: "bastion_user_list", items: bastion.listUsers() });
        break;
      case "bastion_host_add": {
        const host = bastion.registerHost(String(msg.name ?? ""), String(msg.hostname ?? ""), Number(msg.port) || 22, String(msg.username ?? ""), msg.group ? String(msg.group) : undefined, { password: msg.password, privateKeyPath: msg.privateKeyPath });
        const { credentials, ...safe } = host;
        send(ws, { type: "bastion_host_added", ok: true, host: safe });
        break;
      }
      case "bastion_start": {
        try {
          const r = await bastion.start({ port: msg.port, host: msg.host });
          send(ws, { type: "bastion_started", ...r });
        } catch (e) {
          send(ws, { type: "bastion_started", ok: false, error: e.message });
        }
        break;
      }
      case "bastion_stop":
        send(ws, { type: "bastion_stopped", ...(await bastion.stop()) });
        break;
      case "bastion_host_list":
        send(ws, { type: "bastion_host_list", items: bastion.listHosts() });
        break;
      case "bastion_rule_add": {
        const rule = bastion.createAccessRule(String(msg.userId ?? ""), String(msg.hostId ?? ""), String(msg.accessLevel ?? "limited"), msg.allowed !== false, { expiresAt: msg.expiresAt, conditions: msg.conditions });
        send(ws, { type: "bastion_rule_added", ok: true, rule });
        break;
      }
      case "bastion_access":
        send(ws, { type: "bastion_access", ...bastion.canAccess(String(msg.userId ?? ""), String(msg.hostId ?? "")) });
        break;
      case "bastion_session_start": {
        const session = bastion.startSession(String(msg.userId ?? ""), String(msg.hostId ?? ""), String(msg.clientIp ?? "phone"));
        send(ws, { type: "bastion_session_started", ok: !!session, session: session ? (({ client, ...x }) => x)(session) : null });
        break;
      }
      case "bastion_session_end": {
        const ok = bastion.endSession(String(msg.sessionId ?? ""));
        send(ws, { type: "bastion_session_ended", ok });
        break;
      }
      case "bastion_sessions": {
        const items = msg.userId ? bastion.getActiveSessions(String(msg.userId)) : Array.from(bastion.sessions.values()).filter((s) => s.isActive);
        // The live ssh2 client on a proxied session stays off the wire.
        send(ws, { type: "bastion_sessions", items: items.map(({ client, ...x }) => x) });
        break;
      }
      case "bastion_stats":
        send(ws, { type: "bastion_stats", ...bastion.getStats() });
        break;
      case "bastion_invite": {
        const token = bastion.generateInviteToken(String(msg.email ?? ""), String(msg.accessLevel ?? "limited"));
        send(ws, { type: "bastion_invite", token });
        break;
      }
      case "bastion_invite_accept": {
        const user = bastion.acceptInvite(String(msg.token ?? ""), String(msg.username ?? ""), String(msg.publicKey ?? ""));
        send(ws, { type: "bastion_invite_accepted", ok: !!user, user: user ?? null });
        break;
      }
      // ── Advanced SSH server (bifroest/sshwifty: auth + command control) ──
      case "sshserver_user_add": {
        const user = sshSrv.registerUser(String(msg.username ?? ""), { password: msg.password ? String(msg.password) : undefined, publicKey: msg.publicKey ? String(msg.publicKey) : undefined, allowedCommands: Array.isArray(msg.allowedCommands) ? msg.allowedCommands.map(String) : [], maxSessions: Number(msg.maxSessions) || 3, isAdmin: !!msg.isAdmin });
        send(ws, { type: "sshserver_user_added", ok: true, user });
        break;
      }
      case "sshserver_user_list":
        // passwordHash never leaves the daemon: it is a scrypt hash, but
        // still no reason to expose it.
        send(ws, { type: "sshserver_user_list", items: Array.from(sshSrv.users.values()).map(({ passwordHash, ...u }) => u) });
        break;
      case "sshserver_session_create": {
        // The auth surface existed but nothing called it — a registered
        // username alone opened a session.
        const username = String(msg.username ?? "");
        const method = String(msg.method ?? "token");
        if (!sshSrv.authenticate(username, method, msg.credential)) {
          send(ws, { type: "sshserver_session_created", ok: false, session: null, error: "authentication failed" });
          break;
        }
        const session = sshSrv.createSession(username, String(msg.clientIp ?? "phone"), method);
        send(ws, { type: "sshserver_session_created", ok: !!session, session: session ? (({ client, pty, ...x }) => x)(session) : null });
        break;
      }
      case "sshserver_exec": {
        const ok = sshSrv.executeCommand(String(msg.sessionId ?? ""), String(msg.command ?? ""));
        send(ws, { type: "sshserver_exec_ok", ok });
        break;
      }
      case "sshserver_session_end": {
        const ok = sshSrv.endSession(String(msg.sessionId ?? ""));
        send(ws, { type: "sshserver_session_ended", ok });
        break;
      }
      case "sshserver_start": {
        try {
          const r = await sshSrv.start({ port: msg.port, host: msg.host });
          send(ws, { type: "sshserver_started", ...r });
        } catch (e) {
          send(ws, { type: "sshserver_started", ok: false, error: e.message });
        }
        break;
      }
      case "sshserver_stop":
        send(ws, { type: "sshserver_stopped", ...(await sshSrv.stop()) });
        break;
      case "sshserver_sessions":
        // Live handles (ssh2 client, PTY) stay off the wire.
        send(ws, { type: "sshserver_sessions", items: sshSrv.getActiveSessions().map(({ client, pty, ...s }) => s) });
        break;
      case "sshserver_stats":
        send(ws, { type: "sshserver_stats", ...sshSrv.getStats() });
        break;
      // ── Multi-protocol client (haven-ssh-client: profiles + host-key TOFU) ──
      case "profile_create": {
        const profile = mpc.createProfile({ name: msg.name, host: String(msg.host ?? ""), port: Number(msg.port) || 22, username: String(msg.username ?? ""), protocols: Array.isArray(msg.protocols) ? msg.protocols.map(String) : ["ssh"], authMethod: String(msg.authMethod ?? "password"), keyId: msg.keyId ? String(msg.keyId) : undefined, tags: Array.isArray(msg.tags) ? msg.tags.map(String) : [] });
        send(ws, { type: "profile_created", ok: true, profile });
        break;
      }
      case "profile_list":
        send(ws, { type: "profile_list", items: mpc.listProfiles({ tag: msg.tag, protocol: msg.protocol }) });
        break;
      case "profile_update": {
        try {
          const profile = mpc.updateProfile(String(msg.id ?? ""), msg.updates ?? {});
          send(ws, { type: "profile_updated", ok: true, profile });
        } catch (e) {
          send(ws, { type: "profile_updated", ok: false, error: e.message });
        }
        break;
      }
      case "profile_delete": {
        const ok = mpc.deleteProfile(String(msg.id ?? ""));
        send(ws, { type: "profile_deleted", ok });
        break;
      }
      case "profile_connect": {
        const proto = String(msg.protocol ?? "ssh");
        const id = String(msg.id ?? "");
        // Credentials are used for this connect only — never stored on the profile.
        const opts = { password: msg.password, passphrase: msg.passphrase, port: msg.port, timeoutMs: msg.timeoutMs };
        try {
          const session = proto === "vnc" ? await mpc.connectVNC(id, opts) : proto === "sftp" ? await mpc.connectSFTP(id, opts) : await mpc.connectSSH(id, opts);
          // The live handles (ssh2 client, TCP socket, sftp channel) never go on the wire.
          const { client, socket, sftp, channels, ...safe } = session;
          send(ws, { type: "profile_connected", ok: true, session: safe });
        } catch (e) {
          send(ws, { type: "profile_connected", ok: false, error: e.message });
        }
        break;
      }
      case "profile_disconnect": {
        const proto = String(msg.protocol ?? "ssh");
        const sid = String(msg.sessionId ?? "");
        const r = proto === "vnc" ? await mpc.disconnectVNC(sid) : proto === "sftp" ? await mpc.disconnectSFTP(sid) : await mpc.disconnectSSH(sid);
        send(ws, { type: "profile_disconnected", ok: r.ok === true });
        break;
      }
      case "hostkey_verify":
        send(ws, { type: "hostkey_verify", ...mpc.verifyHostKey(String(msg.host ?? ""), Number(msg.port) || 22, String(msg.fingerprint ?? ""), String(msg.keyType ?? "ssh-ed25519")) });
        break;
      case "hostkey_list":
        send(ws, { type: "hostkey_list", items: mpc.listHostKeys() });
        break;
      case "sshkey_generate": {
        try {
          const key = mpc.generateKey(String(msg.algo ?? "ed25519"), msg.name ? String(msg.name) : "", { bits: msg.bits, passphrase: msg.passphrase });
          send(ws, { type: "sshkey_generated", ok: true, key: { id: key.id, name: key.name, type: key.type, publicKey: key.publicKey, fingerprint: key.fingerprint } });
        } catch (e) {
          send(ws, { type: "sshkey_generated", ok: false, error: e.message });
        }
        break;
      }
      case "sshkey_list":
        send(ws, { type: "sshkey_list", items: mpc.listKeys() });
        break;
      case "sshkey_delete": {
        const ok = mpc.deleteKey(String(msg.id ?? ""));
        send(ws, { type: "sshkey_deleted", ok });
        break;
      }
      case "mproto_status":
        send(ws, { type: "mproto_status", ...mpc.getStatus() });
        break;
      // ── Launch a GUI application (IDEs) ──────────────────────────────────
      // GUI apps have no PTY to stream, so this only starts the process. The
      // phone then watches and drives it through the desktop frame stream.
      case "gui_open": {
        // `path` is a discovered application with no manifest behind it.
        const label = String(msg.harness || msg.path || "");
        const known = msg.path ? appDiscovery.find(String(msg.path)) : null;
        if (msg.path && !known) return send(ws, { type: "gui_opened", ok: false, harness: label, reason: "not a discovered app" });
        const r = known
          ? registry.launchApp({ path: known.path, folder: msg.cwd })
          : registry.launchGui(msg.harness, msg.cwd);
        if (!r.ok) return send(ws, { type: "gui_opened", ok: false, harness: label, reason: r.reason });
        auditLog.log("gui_open", { harness: label, path: r.path, cwd: msg.cwd });
        send(ws, { type: "gui_opened", ok: true, harness: label, path: r.path });
        break;
      }
      // Everything installed on this machine, not only what ships a manifest.
      case "apps_discover":
        if (msg.refresh) appDiscovery.discover({ refresh: true });
        send(ws, { type: "apps", items: appDiscovery.search(msg.q ?? "") });
        break;
      // ── Real desktop control (AnyDesk-style: watch + full input) ─────────
      case "desktop_start": {
        const r = await desktop.startFrameStream(ws._clientId || "anon", msg.quality);
        if (r.ok) {
          desktopWatchers.add(ws);
          // Remember the quality so every watcher's input coordinates can be
          // mapped from frame px to real desktop px with the same factor.
          desktopQuality = r.quality;
          // Auto-stop when the watcher disconnects.
          ws.once?.("close", () => {
            desktopWatchers.delete(ws);
            // A reconnect under the same clientId may already own the stream.
            if (![...desktopWatchers].some((w) => w._clientId === ws._clientId)) desktop.stopFrameStream(ws._clientId || "anon");
          });
        }
        send(ws, { type: "desktop_started", ...r });
        break;
      }
      case "desktop_stop": {
        desktopWatchers.delete(ws);
        const r = desktop.stopFrameStream(ws._clientId || "anon");
        send(ws, { type: "desktop_stopped", ...r });
        break;
      }
      case "desktop_frame": {
        // On-demand single frame (thumbnail / refresh) without starting the loop.
        const r = await desktop.getFrame();
        send(ws, r.ok ? { type: "desktop_frame", ...r } : { type: "desktop_frame_error", reason: r.reason });
        break;
      }
      case "desktop_mouse": {
        if (ws._shareMode === "readonly") return send(ws, { type: "error", message: "desktop is read-only (spectator)" });
        // Frame px -> real desktop px: the capture helper downscales the full
        // virtual screen by the quality factor (1 / 0.75 / 0.5), so client
        // coords measured on the frame must be divided back out. Wheel-only
        // events carry no meaningful x/y and skip the transform.
        const factor = desktopScale();
        const x = msg.wheel != null ? 0 : Math.round(Number(msg.x) / factor);
        const y = msg.wheel != null ? 0 : Math.round(Number(msg.y) / factor);
        const r = await desktop.inputMouse({ x, y, click: msg.click, wheel: msg.wheel });
        send(ws, { type: "desktop_input_ok", ok: !!r.ok, error: r.error });
        break;
      }
      case "desktop_key": {
        if (ws._shareMode === "readonly") return send(ws, { type: "error", message: "desktop is read-only (spectator)" });
        const r = await desktop.inputKey({ key: msg.key, modifiers: Array.isArray(msg.modifiers) ? msg.modifiers : [] });
        send(ws, { type: "desktop_input_ok", ok: !!r.ok, error: r.error });
        break;
      }
      case "desktop_type": {
        if (ws._shareMode === "readonly") return send(ws, { type: "error", message: "desktop is read-only (spectator)" });
        const r = await desktop.inputType(String(msg.text ?? ""));
        send(ws, { type: "desktop_input_ok", ok: !!r.ok, error: r.error });
        break;
      }
      case "desktop_quality":
        send(ws, { type: "desktop_quality_ok", ...desktop.setQuality(Number(msg.quality) || 60) });
        break;
      case "desktop_status":
        send(ws, { type: "desktop_status", ...desktop.getStatus() });
        break;
      // ── Model selection (phone picks the model a chat runs with) ───────────
      case "model_list": {
        const r = chat.listModels(String(msg.id ?? ""));
        send(ws, { type: "model_list", ...r });
        break;
      }
      case "chat_model_set": {
        const r = chat.setModel(String(msg.id ?? ""), msg.model ? String(msg.model) : null);
        send(ws, { type: "chat_model_set", ...r });
        break;
      }
      // ── Freebuff control (status/configs/skills/auth from the phone) ───────
      case "fb_status":
        send(ws, { type: "fb_status", ...fbCtrl.status() });
        break;
      case "fb_config_list":
        send(ws, { type: "fb_config_list", items: fbCtrl.configList() });
        break;
      case "fb_config_get":
        send(ws, { type: "fb_config_get", ...fbCtrl.configGet(String(msg.name ?? "")) });
        break;
      case "fb_config_set": {
        const r = fbCtrl.configSet(String(msg.name ?? ""), msg.patch);
        send(ws, { type: "fb_config_set", ...r });
        break;
      }
      case "fb_skill_list":
        send(ws, { type: "fb_skill_list", items: fbCtrl.skillList() });
        break;
      case "fb_skill_get":
        send(ws, { type: "fb_skill_get", ...fbCtrl.skillGet(String(msg.name ?? "")) });
        break;
      case "fb_skill_run": {
        const s = fbCtrl.skillGet(String(msg.name ?? ""));
        if (!s.ok) { send(ws, { type: "fb_skill_run", ok: false, error: s.error }); break; }
        const m = registry.get(String(msg.harness ?? "claude"));
        if (!m) { send(ws, { type: "fb_skill_run", ok: false, error: `unknown harness: ${msg.harness}` }); break; }
        if (!chat.supported(m)) { send(ws, { type: "fb_skill_run", ok: false, error: `${m.name} has no chat adapter` }); break; }
        if (!registry.isInstalled(m.id)) { send(ws, { type: "fb_skill_run", ok: false, error: `${m.name} is not installed` }); break; }
        const prompt = [`Skill: ${s.name}`, "", s.content, "", String(msg.args ?? "").trim() ? `Task: ${msg.args}` : ""].filter(Boolean).join("\n");
        const ch = chat.create({ manifest: m, cwd: msg.cwd });
        chat.attach(ch.id, ws);
        send(ws, { type: "created", ...ch });
        if (prompt.trim()) chat.sendUserMessage(chat.get(ch.id), prompt.trim());
        broadcast({ type: "sessions", items: allSessions() });
        send(ws, { type: "fb_skill_run", ok: true, skill: s.name, chatId: ch.id });
        break;
      }
      case "fb_auth_status":
        send(ws, { type: "fb_auth_status", ...fbCtrl.authStatus() });
        break;
      case "fb_auth_logout": {
        const r = fbCtrl.authLogout(String(msg.confirm ?? ""), { restart: !!msg.restart });
        send(ws, { type: "fb_auth_logout", ...r });
        break;
      }
      case "fb_app_open":
        send(ws, { type: "fb_app_open", ...fbCtrl.appOpen() });
        break;
      case "fb_app_quit":
        send(ws, { type: "fb_app_quit", ...fbCtrl.appQuit() });
        break;
      // ── Smart notifications (shooter: coalescing/dedupe + telemetry) ──────
      case "notify_send": {
        const result = shooter.sendNotification({
          projectId: String(msg.projectId ?? "default"),
          type: String(msg.eventType ?? "info"),
          text: String(msg.text ?? ""),
        });
        send(ws, { type: "notify_sent", ok: result.sent, reason: result.reason ?? null, priority: result.priority ?? null });
        break;
      }
      case "notify_stats":
        send(ws, { type: "notify_stats", ...shooter.getTelemetryStats() });
        break;
      case "notify_test": {
        // Fire a test push through EVERY registered channel so a phone can
        // verify its subscription end-to-end (ntfy topic, Pushover keys, …).
        const results = [];
        for (const name of notifications.channels()) {
          const t0 = Date.now();
          try {
            const ch = notifications;
            void ch;
            // send() fans out to all channels — per-channel results come from
            // calling the channel directly, so reach into the manager's list.
            results.push({ channel: name, ok: true, ms: Date.now() - t0 });
          } catch (e) {
            results.push({ channel: name, ok: false, error: e.message });
          }
        }
        if (notifications.count() === 0) {
          send(ws, { type: "notify_test", ok: false, error: "no channels configured (set NTFY_TOPIC or PUSHOVER_TOKEN+PUSHOVER_USER)" });
          break;
        }
        // notifications.send is fire-and-forget per channel with its own error
        // logging; a true per-channel ack would need the manager to expose it.
        notifications.send("session_asking", { summary: "PocketDesk test push — if you can read this on your phone, push works 🎉" });
        send(ws, { type: "notify_test", ok: true, channels: results.map((r) => r.channel), note: "sent to all channels — check your phone" });
        break;
      }
      case "notify_bursts":
        send(ws, { type: "notify_bursts", items: shooter.detectBursts(Number(msg.windowMs) || 60000) });
        break;
      // ── Stream JSON parser (format-claude-stream: agent JSONL → cards) ────
      case "stream_parse": {
        const parsed = streamParser.parseLines(String(msg.lines ?? ""));
        send(ws, { type: "stream_parsed", items: parsed.map((p) => ({ type: p.type, formatted: p.formatted, sessionId: p.sessionId })), stats: streamParser.getStats() });
        break;
      }
      case "stream_stats":
        send(ws, { type: "stream_stats", ...streamParser.getStats() });
        break;
      case "stream_reset":
        streamParser.reset();
        send(ws, { type: "stream_reset", ok: true });
        break;
      // ── Power manager (orca/LinkShell: keep the PC awake while agents run) ──
      case "power_set":
        power.setMode(normalizeAwakeMode(msg.mode));
        send(ws, { type: "power_status", ...power.getStatus() });
        break;
      case "power_status":
        send(ws, { type: "power_status", ...power.getStatus() });
        break;
      // ── Activity monitor (webmux/purplemux: busy→quiet, per-session status) ──
      case "activity_list":
        send(ws, { type: "activity_list", items: activity.summary() });
        break;
      // ── Chat resurrection (zellij-resurrect: restore chats after restart) ──
      case "resurrect_list":
        send(ws, { type: "resurrect_list", items: resurrect.list() });
        break;
      case "resume": {
        const rec = resurrect.get(msg.id);
        const m = rec && registry.get(rec.harnessId);
        if (!rec || !m || !chat.supported(m)) return send(ws, { type: "error", message: `no resumable chat: ${msg.id}` });
        const s = chat.create({ manifest: m, cwd: rec.cwd, resumeFirst: true });
        sessionStore.upsert(s.id, { name: m.name, project: rec.cwd || "", type: "chat", status: "idle" });
        power.addStatus({ agentId: s.id, state: "running", receivedAt: Date.now() });
        // IDs restart from 1 per process, so the resumed chat often reuses the
        // old record's id — clear the stale record BEFORE re-registering.
        resurrect.remove(rec.id);
        resurrect.upsert({ id: s.id, harnessId: m.id, cwd: rec.cwd, name: rec.name });
        chat.attach(s.id, ws);
        send(ws, { type: "created", ...s, resumed: true });
        broadcast({ type: "sessions", items: allSessions() });
        break;
      }
      // ── Prompt queue (1code/ccpocket/oc-remote: queued follow-ups) ───────
      case "prompt_enqueue": {
        const chatId = String(msg.id ?? "");
        const text = String(msg.text ?? "").trim();
        if (!text) return send(ws, { type: "prompt_queued", ok: false, error: "empty prompt" });
        const r = promptQueue.enqueue(chatId, text);
        if (r.ok) send(ws, { type: "prompt_queued", ok: true, id: chatId, queue: promptQueue.list(chatId), position: promptQueue.list(chatId).length });
        else send(ws, { type: "prompt_queued", ok: false, error: r.error });
        break;
      }
      case "prompt_queue":
        send(ws, { type: "prompt_queue", id: msg.id, items: promptQueue.list(String(msg.id ?? "")) });
        break;
      case "prompt_remove": {
        const ok = promptQueue.remove(String(msg.id ?? ""), String(msg.promptId ?? ""));
        send(ws, { type: "prompt_removed", ok, id: msg.id, queue: promptQueue.list(String(msg.id ?? "")) });
        break;
      }
      // ── Agent todos (c9watch/claude-threads/codeman: live task board) ────
      case "todos_set": {
        const items = agentTodos.setTodos(String(msg.id ?? ""), Array.isArray(msg.items) ? msg.items : []);
        broadcast({ type: "todos_updated", id: msg.id, items, derived: false });
        break;
      }
      case "todos_get":
        send(ws, { type: "todos", id: msg.id, items: agentTodos.getTodos(String(msg.id ?? "")) });
        break;
      case "todos_status": {
        const item = agentTodos.updateStatus(String(msg.id ?? ""), String(msg.todoId ?? ""), String(msg.status ?? "pending"));
        if (item) broadcast({ type: "todos_updated", id: msg.id, items: agentTodos.getTodos(String(msg.id ?? "")), derived: false });
        else send(ws, { type: "error", message: `no todo ${msg.todoId} for ${msg.id}` });
        break;
      }
      // ── Run scheduler (codeman/codex-bee/kagora: loops + cron) ───────────
      case "schedule_create": {
        const job = scheduler.schedule({ chatId: msg.chatId, text: msg.text, kind: msg.kind, intervalMs: msg.intervalMs, delayMs: msg.delayMs, maxRuns: msg.maxRuns });
        send(ws, { type: "schedule_created", job });
        break;
      }
      case "schedule_list":
        send(ws, { type: "schedule_list", items: scheduler.list() });
        break;
      case "schedule_pause": {
        const job = scheduler.pause(String(msg.jobId ?? ""));
        send(ws, job ? { type: "schedule_paused", ok: true, job } : { type: "error", message: `no job ${msg.jobId}` });
        break;
      }
      case "schedule_resume": {
        const job = scheduler.resume(String(msg.jobId ?? ""));
        send(ws, job ? { type: "schedule_resumed", ok: true, job } : { type: "error", message: `no job ${msg.jobId}` });
        break;
      }
      case "schedule_cancel": {
        const ok = scheduler.cancel(String(msg.jobId ?? ""));
        send(ws, { type: "schedule_cancelled", ok, jobId: msg.jobId });
        break;
      }
      // ── Doctor (whatsapp-claude-plugin/marchat: self-diagnosis) ──────────
      case "doctor": {
        const health = await doctor.diagnose({ tls, manifests: undefined });
        send(ws, { type: "doctor_report", ...health });
        break;
      }
      // ── Wake-on-LAN (rustdesk: power on a LAN machine) ──────────────────
      case "wake": {
        const r = await wakeOnLan.wake(msg.mac, { port: msg.port, address: msg.address });
        send(ws, { type: "wake_result", ...r });
        break;
      }
      // ── Approval auto-deny status (cc-pocket) ───────────────────────────
      case "approval_waiting":
        send(ws, { type: "approval_waiting", items: approvalGuard.listWaiting(), timeoutMs: approvalGuard.getTimeoutMs() });
        break;
      // ── Usage/cost dashboard (c9watch/flue/orca/cc-pocket) ──────────────
      case "usage_list":
        send(ws, { type: "usage_list", items: statsUsage.list(), totals: statsUsage.totals() });
        break;
      case "usage_get":
        send(ws, { type: "usage", id: msg.id, ...(statsUsage.get(String(msg.id ?? "")) ?? { inputTokens: 0, outputTokens: 0, costUsd: 0, turns: 0, points: [] }) });
        break;
      // ── Live digest attach (mcp-interactive-terminal: token-saving view) ──
      case "digest_attach":
        if (sessions.get(String(msg.id ?? ""))) {
          liveDigest.attach(String(msg.id), ws, { cols: msg.cols, rows: msg.rows });
          send(ws, { type: "digest_attached", ok: true, id: msg.id });
        } else {
          send(ws, { type: "error", message: `no live session: ${msg.id}` });
        }
        break;
      case "digest_detach":
        liveDigest.detach(ws, String(msg.id ?? ""));
        send(ws, { type: "digest_detached", ok: true });
        break;
      // ── MCP server control (quil/paseo: expose agents as MCP tools) ─────
      case "mcp_start":
        mcpServer.start(Number(msg.port) || 4680);
        send(ws, { type: "mcp_status", ...mcpServer.status() });
        break;
      case "mcp_stop":
        mcpServer.stop();
        send(ws, { type: "mcp_status", ...mcpServer.status() });
        break;
      case "mcp_status":
        send(ws, { type: "mcp_status", ...mcpServer.status() });
        break;
      // ── @file mention in terminal session (agent-tmux-web pattern) ────
      case "mention": {
        try {
          const ex = mentions.expand(String(msg.text ?? ""), msg.cwd || sessions.get(msg.id)?.cwd);
          send(ws, { type: "mention_expanded", ok: true, ...ex });
        } catch (e) {
          send(ws, { type: "mention_expanded", ok: false, error: e.message });
        }
        break;
      }
      // ── Chat search (flue/1code: find prompts across history) ─────────
      case "chat_search": {
        const q = String(msg.query ?? "").toLowerCase();
        const hits = [];
        for (const h of chat.listHistory()) {
          for (const it of h.transcript ?? []) {
            if (q && String(it.text ?? "").toLowerCase().includes(q)) {
              hits.push({ chatId: h.id, harnessId: h.harnessId, cwd: h.cwd, role: it.role, text: String(it.text).slice(0, 200) });
              if (hits.length >= 50) break;
            }
          }
          if (hits.length >= 50) break;
        }
        send(ws, { type: "chat_search", query: msg.query, items: hits });
        break;
      }
      // ── Worktree isolation (vmux/orca/ccpocket/nimbalyst) ─────────────
      case "wt_create": {
        const r = await worktrees.createWorktree({ repo: msg.repo, name: msg.name, branch: msg.branch === undefined ? undefined : msg.branch, base: msg.base });
        send(ws, { type: "worktree_created", ...r });
        break;
      }
      case "wt_list": {
        const r = await worktrees.listWorktrees(String(msg.repo ?? ""));
        send(ws, { type: "worktree_list", ...r, tracked: worktrees.listTracked() });
        break;
      }
      case "wt_remove": {
        const r = await worktrees.removeWorktree(String(msg.repo ?? ""), String(msg.path ?? ""), { force: Boolean(msg.force) });
        send(ws, { type: "worktree_removed", ...r });
        break;
      }
      // ── Quiet hours (marchat/shooter: focus mode) ───────────────────
      case "quiet_set": {
        if (msg.mode !== undefined) quietHours.setMode(String(msg.mode));
        if (Array.isArray(msg.windows)) quietHours.setWindows(msg.windows);
        send(ws, { type: "quiet_status", ...quietHours.getState() });
        break;
      }
      case "quiet_status":
        send(ws, { type: "quiet_status", ...quietHours.getState() });
        break;
      // ── Client devices (openchamber/netbird: list + revoke) ──────────
      case "device_list":
        send(ws, { type: "device_list", items: devices.list() });
        break;
      case "device_revoke": {
        const r = devices.revoke(String(msg.clientId ?? ""));
        if (r.ok) {
          for (const client of wss.clients) if (client._clientId === msg.clientId) client.close(4003, "device revoked");
          for (const [from, shim] of relayShims) if (shim._clientId === msg.clientId) relayShims.delete(from);
          // The revoked device knew the pairing token too, so it must change.
          rotateToken();
        }
        send(ws, { type: "device_revoked", ...r, pairingToken: r.ok ? token : undefined });
        break;
      }
      case "device_allow": {
        const r = devices.allow(String(msg.clientId ?? ""));
        send(ws, { type: "device_allowed", ...r });
        break;
      }
      // ── Hot manifest reload (frp: config reload without restart) ─────
      case "manifest_reload": {
        await registry.scanAll(broadcast);
        send(ws, { type: "manifests_reloaded", count: registry.list().length });
        break;
      }
      default:
        send(ws, { type: "error", message: `unknown type: ${msg.type}` });
    }
  }

  const CHUNK = 256 * 1024;

  /**
   * Deepest existing ancestor resolved through symlinks, with the not-yet-
   * existing tail re-appended. A plain path.resolve leaves a link under $HOME
   * pointing anywhere on disk, which defeats the containment check below.
   */
  function realResolve(p) {
    let cur = p;
    const tail = [];
    for (;;) {
      try {
        return path.join(fs.realpathSync(cur), ...tail);
      } catch {
        const parent = path.dirname(cur);
        if (parent === cur) return p;
        tail.unshift(path.basename(cur));
        cur = parent;
      }
    }
  }

  function resolvePath(p) {
    const resolved = realResolve(p && String(p).trim() ? path.resolve(String(p).replace(/^~(?=$|\/|\\)/, os.homedir())) : os.homedir());
    // Security: block path traversal outside home, with an escape hatch for
    // the OS temp dir (tests and file-transfer staging legitimately live
    // there, and on Linux /tmp is NOT under home). ponytail: per-user tmp
    // roots if this ever runs multi-tenant.
    const home = realResolve(os.homedir());
    const tmpRoot = fs.realpathSync(os.tmpdir());
    const allowed = resolved === home || resolved.startsWith(home + path.sep) ||
      resolved.startsWith(tmpRoot + path.sep) || path.dirname(resolved) === tmpRoot;
    if (!allowed) throw new Error("Path traversal not allowed");
    return resolved;
  }

  function listDir(p) {
    let dir;
    try {
      dir = resolvePath(p);
    } catch (e) {
      return { type: "fs", error: e.message };
    }
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
    let file;
    try {
      file = resolvePath(p);
    } catch (e) {
      return { type: "fchunk", path: p, error: e.message };
    }
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
    let file;
    try {
      file = resolvePath(msg.path);
    } catch (e) {
      return { type: "fwritten", path: msg.path, error: e.message };
    }
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

  // ── Relay (hermes-relay: reach the daemon from outside the LAN) ──────────
  // Remote peers publish protocol commands wrapped in an `rh` envelope on the
  // daemon's channel; the daemon validates the token (same timing-safe check
  // as the /ws hello), replays the inner message through the normal handle()
  // path via a shim ws object, and pushes every response/broadcast back over
  // the channel. No inbound port on the PC — the daemon dials OUT to the
  // relay, so this works from any network, kilometers away, VPN-free.
  const relayShims = new Map(); // relay peer connId -> shim ws-like object
  const RELAY_SHIM_MAX = 64;
  // Brute-force counters, one per relay peer. A single shared counter would let
  // any one source spend the budget for every honest peer on the channel.
  const relayAuthFails = new Map(); // relay peer connId -> { n, at }
  const RELAY_AUTH_FAIL_WINDOW = 10 * 60_000;
  const RELAY_AUTH_FAIL_MAX = 20;
  // Request id for the reply being produced right now. Held in async context
  // rather than on the shim, because one shim serves concurrent requests and by
  // the time a handler replies the shim may have seen a later request.
  const relayReqCtx = new AsyncLocalStorage();

  function relayAuthFailsFor(from, now) {
    const rec = relayAuthFails.get(from);
    if (!rec) return null;
    if (now - rec.at > RELAY_AUTH_FAIL_WINDOW) {
      relayAuthFails.delete(from);
      return null;
    }
    return rec;
  }

  function relayShimFor(from) {
    const existing = relayShims.get(from);
    if (existing) {
      // Re-insert so Map order tracks recency: eviction below must drop the
      // least recently used shim, and a cache hit is a use.
      relayShims.delete(from);
      relayShims.set(from, existing);
      return existing;
    }
    const s = {
      readyState: 1,
      _authed: false,
      _subs: new Set(),
      _clientId: `relay-${from}`,
      _isRelayShim: true,
      send(str) {
        let data = str;
        try {
          data = JSON.parse(str);
        } catch {
          /* non-JSON send — forward raw */
        }
        // null when nothing is being answered: stream output driven by a
        // session or chat rather than by a request.
        relaySendTo(from, { rh: true, type: "rhresp", reqId: relayReqCtx.getStore() ?? null, data });
      },
    };
    // Bounded: a peer that auths then silently dies leaves its shim behind
    // (the relay never announces member departures) — evict the oldest.
    if (relayShims.size >= RELAY_SHIM_MAX) {
      const oldest = relayShims.keys().next().value;
      const dead = relayShims.get(oldest);
      if (dead) {
        try {
          sessions.detach(dead);
          chat.detach(dead);
        } catch {}
        relayShims.delete(oldest);
      }
    }
    relayShims.set(from, s);
    return s;
  }

  function relayDetachAll() {
    for (const shim of relayShims.values()) {
      try {
        sessions.detach(shim);
        chat.detach(shim);
      } catch {
        /* shim never attached */
      }
    }
    relayShims.clear();
  }

  function relaySendTo(to, obj) {
    if (relay.status().connected) relay.sendTo(to, obj);
  }

  function relayPushAuthed(obj) {
    if (!relay.status().connected) return;
    for (const [from, shim] of relayShims) if (shim._authed) relay.sendTo(from, obj);
  }

  /**
   * A failed relay hello answers late, and later the more the channel has
   * failed recently. The per-peer lockout below keys on the relay-assigned
   * connId, which an attacker resets just by reconnecting; this throttle has
   * no such handle. It only ever delays a rejection, so it cannot lock anyone
   * out the way a shared counter would.
   */
  let relayFailStreak = { n: 0, at: 0 };
  function relayRejectDelay() {
    const now = Date.now();
    if (now - relayFailStreak.at > RELAY_AUTH_FAIL_WINDOW) relayFailStreak = { n: 0, at: now };
    relayFailStreak = { n: relayFailStreak.n + 1, at: now };
    // The first couple of rejections answer immediately — a typo should not
    // feel broken. Only a streak pays.
    return Math.min(Math.max(0, relayFailStreak.n - 2) * 250, 3000);
  }

  function onRelayEvent(evt) {
    if (evt.type === "relay_message") {
      let data = evt.data;
      if (typeof data === "string") {
        try {
          data = JSON.parse(data);
        } catch {
          data = null;
        }
      }
      if (data && data.rh === true && data.type === "rhreq") {
        // Bridge path: a remote peer's protocol request.
        const shim = relayShimFor(evt.from);
        const reqId = data.reqId ?? null;
        const inner = data.msg || {};
        const now = Date.now();
        // Brute-force gate (WS path has MAX_AUTH_ATTEMPTS). Checked before the
        // token test, because every failed hello returns below and would
        // otherwise never reach it — the peer just gets a fresh shim and tries
        // again. Per peer, so one attacker cannot lock out the channel.
        const fails = relayAuthFailsFor(evt.from, now);
        if (fails && fails.n >= RELAY_AUTH_FAIL_MAX) {
          relaySendTo(evt.from, { rh: true, type: "rherr", reqId, error: "too many failed auth attempts" });
          return;
        }
        if (!shim._authed) {
          const auth = authenticate(inner);
          if (!auth) {
            relayAuthFails.set(evt.from, { n: (fails?.n ?? 0) + 1, at: fails?.at ?? now });
            setTimeout(() => relaySendTo(evt.from, { rh: true, type: "rherr", reqId, error: "bad token" }), relayRejectDelay()).unref?.();
            relayShims.delete(evt.from);
            return;
          }
          shim._authed = true;
          shim._clientId = auth.id;
          relayAuthFails.delete(evt.from); // an honest hello clears its own count
          devices.register(auth.id, { name: inner.name, platform: inner.platform });
          const deviceToken = auth.pairing ? devices.issueToken(auth.id) : undefined;
          relaySendTo(evt.from, { rh: true, type: "rhresp", reqId, data: { type: "welcome", version: 1, clientId: auth.id, deviceToken, sessions: allSessions(), manifests: registry.list() } });
          return;
        }
        relayReqCtx.run(reqId, () => handle(shim, inner)).catch((e) => {
          try {
            shim.send({ type: "error", message: `handler error: ${e?.message || e}` });
          } catch {}
        });
        return;
      }
      // Own echoes / foreign envelopes (rhresp/rhpush/rherr) must NEVER be
      // re-broadcast — broadcast() mirrors to the relay, so echoing an
      // envelope here would loop forever. Plain non-envelope peer traffic
      // passes through to WS clients as before the bridge existed.
      if (data && data.rh === true) return;
      broadcast(evt);
      return;
    }
    if (evt.state === "disconnected" || evt.state === "error") relayDetachAll();
    broadcast(evt);
  }

  const relay = createRelayLink({ onEvent: onRelayEvent });
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
  let desktopQuality = 60;
  // Quality → capture downscale factor (mirrors desktop_capture.js's mapping:
  // >=70 → 1, 40-69 → 0.75, else 0.5); used to convert client frame coords
  // back to real desktop pixels.
  const desktopScale = () => (desktopQuality >= 70 ? 1 : desktopQuality >= 40 ? 0.75 : 0.5);
  desktop.on("frame", (frame) => {
    for (const w of desktopWatchers) {
      try {
        send(w, { type: "desktop_frame", ...frame });
      } catch { /* watcher vanished mid-send */ }
    }
  });

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
  chat.chatEvents.on("state", ({ id, state }) => {
    if (state === "idle" || state === "error") resurrect.touch(id);
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
    if (!decision.deliver) {
      try { shooter?.getTelemetryStats?.(); } catch {}
      return false;
    }
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
