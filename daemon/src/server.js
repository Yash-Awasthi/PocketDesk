import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
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
import { DesktopController, toFraction } from "./desktop_capture.js";
import { createAccess } from "./access.js";
import { wakeTargets } from "./wake.js";
import { Recorder, RECORD_FLAG } from "./recorder.js";
import { DesktopVideo } from "./desktop_video.js";
import { DesktopAudio } from "./desktop_audio.js";
import { AdvancedSSHServerManager } from "./advanced_ssh_server.js";
import { SSHBastion } from "./ssh_bastion.js";
import { MultiProtocolClient } from "./ssh_vnc_client.js";
import * as promptQueue from "./prompt_queue.js";
import * as agentTodos from "./agent_todos.js";
import * as scheduler from "./scheduler.js";
import * as approvalGuard from "./approval_guard.js";
import * as statsUsage from "./stats_usage.js";
import * as devices from "./devices.js";
import * as totp from "./totp.js";
import agentsHandlers from "./handlers/agents.js";
import filesHandlers from "./handlers/files.js";
import remoteHandlers from "./handlers/remote.js";
import sshHandlers from "./handlers/ssh.js";
import systemHandlers from "./handlers/system.js";
import phoneHandlers, { phoneBinary } from "./handlers/phone.js";
import phoneAdbHandlers from "./handlers/phone_adb.js";
import phoneSyncHandlers from "./handlers/phone_sync.js";
import pcPadHandlers from "./handlers/pc_pad.js";
import displayHandlers from "./handlers/display.js";
import computersHandlers from "./handlers/computers.js";
import { withSources } from "./handlers/sources.js";
import { startIroh } from "./iroh_link.js";
import { configDir, configPath } from "./config.js";

const HELLO_TIMEOUT = 10_000;
const MAX_AUTH_ATTEMPTS = 5;
const authAttempts = new Map();
const pluginDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "plugins");
const CONSOLE = Boolean(process.env.RH_CONSOLE);
const AUDIT_LOG = path.join(configDir, "console-audit.log");
// While control is paused a phone may only look: these read/view/refuse/stop ops stay allowed,
// everything else (terminals, files, agents, power, approvals) is refused, including later handlers.
const PAUSE_ALLOWED = new Set([
  "sessions", "sessions_get", "sessions_scan", "attach", "detach", "chat_history", "chat_search", "auth_status", "detect",
  "plan_get", "apps_discover", "model_list", "activity_list", "prompt_queue", "todos_get", "todos_status", "schedule_list",
  "approval_waiting", "usage_list", "usage_get", "recordings_list", "recording_get",
  "fs", "fread", "fs_search", "fs_zip", "fs_thumb", "git_status", "git_diff", "git_log", "git_branches", "mention",
  "desktop_start", "desktop_ping", "desktop_monitors", "video_ack", "desktop_stop", "desktop_frame", "desktop_quality",
  "desktop_status", "desktop_permissions", "desktop_mouse", "desktop_key", "desktop_type", "sources_list", "pc_list",
  "bastion_user_list", "bastion_host_list", "bastion_sessions", "bastion_stats", "bastion_stop", "sshserver_user_list",
  "sshserver_sessions", "sshserver_stats", "sshserver_stop", "profile_list", "profile_disconnect", "hostkey_list", "sshkey_list", "mproto_status",
  "phone_watch", "phone_unwatch", "phone_share_start", "phone_share_stop", "phone_share_end", "phone_apps", "phone_input", "phone_switch", "phone_fs", "phone_fs_result",
  "proposal_list", "reject", "stats", "fb_status", "fb_config_list", "fb_config_get", "fb_skill_list", "fb_skill_get",
  "fb_auth_status", "fb_accounts", "stream_parse", "stream_stats", "doctor", "device_list", "history_list", "history_get", "agent_panel", "agent_doc", "accounts_list",
]);
const AUDIT_SKIP = new Set(["in", "resize", "video_ack", "desktop_ping", "desktop_frame", "desktop_mouse", "desktop_key", "desktop_type", "phone_input"]);

/** One line per action on the SYSTEM endpoint, in its admin-only directory. */
function audit(ws, msg) {
  if (AUDIT_SKIP.has(msg.type) || ((msg.type === "fread" || msg.type === "fwrite") && (msg.offset || msg.append))) return;
  const pick = (k) => (typeof msg[k] === "string" ? msg[k].slice(0, 500) : undefined);
  try {
    if (fs.statSync(AUDIT_LOG, { throwIfNoEntry: false })?.size > 5 << 20) fs.renameSync(AUDIT_LOG, AUDIT_LOG + ".1");
    fs.appendFileSync(AUDIT_LOG, JSON.stringify({ at: new Date().toISOString(), device: ws._clientId, type: msg.type, harness: pick("harness"), path: pick("path"), cwd: pick("cwd") }) + "\n", { mode: 0o600 });
  } catch { /* auditing must never block the action */ }
}

  function allSessions() {
  // Attention-first ordering (c9watch): permission-waiting and running
  // sessions surface to the top so an agent stuck on approval is unmissable.
  const rank = { waiting: 0, running: 1, error: 2 };
  const all = [...sessions.summary(), ...chat.summary()];
  return all.sort((a, b) => (rank[a.state] ?? 9) - (rank[b.state] ?? 9));
}

let liveWss = null;
let stopping = null;

/** Shutdown: closes every client and refuses new ones, which could otherwise start work nothing will clean up. */
export function closeClients(code, reason) {
  stopping = { code, reason };
  for (const ws of liveWss?.clients ?? []) try { ws.close(code, reason); } catch {}
}

export function start(config, { onTokenRotated } = {}) {
  const { port, token: _token, tls, iroh: irohCfg } = config;
  let token = _token;
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
  let pairLink = "";
  let pairFp = "";
  let irohTicket = "";
  let irohEp = null;
  // True while iroh is still starting: a QR shown now would carry no way to reach the PC from outside.
  let irohStarting = false;
  // Rebuilt on token rotation, so the QR never shows a dead token.
  function buildPairPage(useTls, fingerprint = pairFp) {
    pairFp = fingerprint;
    const url = `${useTls ? "wss" : "ws"}://${lanAddress()}:${port}/ws`;
    const payload = Buffer.from(
      JSON.stringify({ u: url, t: token, f: fingerprint || "", i: irohTicket || undefined, n: process.env.RH_LABEL || undefined }),
      "utf8",
    ).toString("base64url");
    pairLink = `pocketdesk://pair#${payload}`;
    pairPage = pairTemplate
      .replaceAll("__RH_PAYLOAD__", pairLink)
      .replaceAll("__RH_URL__", url)
      .replaceAll("__RH_TOKEN__", token)
      .replaceAll("__RH_FP__", fingerprint || "n/a");
  }

  const requestHandler = (req, res) => {
    // No page here may be framed or content-sniffed; the pair page also carries a secret.
    res.setHeader("x-frame-options", "DENY");
    res.setHeader("content-security-policy", "frame-ancestors 'none'");
    res.setHeader("x-content-type-options", "nosniff");
    res.setHeader("referrer-policy", "no-referrer");
    // /access changes local settings, so it alone may POST; everything else is read-only GET.
    if (req.method !== "GET" && !(req.method === "POST" && req.url.startsWith("/access"))) {
      res.writeHead(405).end();
      return;
    }
    if ((req.url.startsWith("/vendor/") || req.url.startsWith("/ui/")) && !req.url.includes("..") && /^[\w/.-]+$/.test(req.url)) {
      const file = path.join(publicDir, req.url);
      if (fs.existsSync(file)) {
        const type = req.url.endsWith(".js") ? "text/javascript" : req.url.endsWith(".css") ? "text/css"
          : req.url.endsWith(".svg") ? "image/svg+xml" : req.url.endsWith(".webmanifest") ? "application/manifest+json" : "text/plain";
        res.writeHead(200, { "content-type": type, "cache-control": "no-cache" });
        res.end(fs.readFileSync(file));
        return;
      }
    }
    // /pair carries the pairing token and is only ever served to the local machine.
    // Windows dual-stack sockets present IPv4 clients as ::ffff:127.0.0.1.
    const remoteAddr = (req.socket.remoteAddress || "").replace(/^::ffff:/, "");
    // Host must be loopback too: DNS rebinding delivers a web page's requests from 127.0.0.1 under its own name.
    const loopback = (remoteAddr === "127.0.0.1" || remoteAddr === "::1" || remoteAddr === "[::1]") &&
      /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(req.headers.host || "");
    if (req.url === "/health") {
      res.writeHead(200, { "content-type": "application/json" });
      // Anyone on the network may probe liveness; only this machine learns what answers and how busy it is.
      res.end(JSON.stringify(loopback ? { status: "healthy", service: "pocketdesk", sessions: allSessions().length } : { status: "healthy" }));
      return;
    }
    // The launcher's check before it hands the token to a plain-HTTP page: only the daemon can sign its nonce.
    if (req.url.startsWith("/prove?") && loopback) {
      const n = new URL(req.url, "http://x").searchParams.get("n") || "";
      res.writeHead(200, { "content-type": "text/plain" });
      res.end(crypto.createHmac("sha256", token).update(n).digest("hex"));
      return;
    }
    // Loopback alone admits every local account, and the console endpoint's token is SYSTEM;
    // the key is the token itself, so only whoever can read the config dir can open the page.
    const key = new URL(req.url, "http://x").searchParams.get("k") || "";
    const keyOk = key.length === token.length && crypto.timingSafeEqual(Buffer.from(key), Buffer.from(token));
    // Local, token-gated settings the pair page drives. Security settings live only here, never on the
    // socket, so a stolen phone or device token can use the PC but cannot change who may reach it.
    if (req.url.startsWith("/access") && loopback && keyOk) {
      const path0 = req.url.split("?")[0];
      const reply = (code, obj) => {
        res.writeHead(code, { "content-type": "application/json", "cache-control": "no-store" });
        res.end(JSON.stringify(obj));
      };
      const status = () => ({ hasPassword: access.hasPassword, controlAllowed: access.controlAllowed, totpEnabled: totp.enabled(), recording: recorder.enabled, remoteOn: access.remoteOn });
      if (req.method === "GET") {
        if (path0 === "/access") return reply(200, status());
        if (path0 === "/access/devices") return reply(200, { items: devices.list() });
        return reply(404, { ok: false });
      }
      let body = "";
      req.on("data", (d) => { body += d; if (body.length > 4096) req.destroy(); });
      req.on("end", () => {
        try {
          let msg = {};
          try { msg = JSON.parse(body || "{}"); } catch { /* empty */ }
          const id = String(msg.clientId ?? "");
          if (path0 === "/access/control") access.setControlAllowed(msg.allowed !== false);
          else if (path0 === "/access/password") access.setPassword(typeof msg.password === "string" ? msg.password : "");
          else if (path0 === "/access/remote") access.setRemoteOn(msg.on !== false);
          else if (path0 === "/access/uninstall") {
            // Detached, because the uninstaller stops this daemon; it may ask for elevation on the PC.
            const script = path.join(process.env.LOCALAPPDATA || "", "PocketDesk", "uninstall.ps1");
            if (process.platform !== "win32" || !fs.existsSync(script)) return reply(400, { ok: false, error: "no installed copy to uninstall; run uninstall.sh or remove the checkout" });
            spawn("powershell.exe", ["-NoProfile", "-ExecutionPolicy", "Bypass", "-File", script, ...(msg.removeData ? ["-RemoveData"] : [])],
              { detached: true, stdio: "ignore" }).unref();
            return reply(200, { ok: true });
          }
          else if (path0 === "/access/record") {
            if (msg.on) fs.writeFileSync(RECORD_FLAG, "");
            else fs.rmSync(RECORD_FLAG, { force: true });
          }
          else if (path0 === "/access/devices/revoke") {
            const r = devices.revoke(id);
            if (!r.ok) return reply(404, r);
            disconnectDevice(id);
            // The revoked device knew the pairing token too, so it must change.
            return reply(200, { ...r, pairingToken: rotateToken() });
          } else if (path0 === "/access/devices/allow") {
            const r = devices.allow(id);
            return reply(r.ok ? 200 : 404, r);
          } else if (path0 === "/access/devices/remove") {
            const r = devices.remove(id);
            return reply(r.ok ? 200 : 400, r);
          } else if (path0 === "/access/totp/setup") return reply(200, { ok: true, ...totp.setup(os.hostname()) });
          else if (path0 === "/access/totp/enable" || path0 === "/access/totp/disable") {
            const ok = path0 === "/access/totp/enable" ? totp.enable(String(msg.code ?? "")) : totp.disable(String(msg.code ?? ""));
            return reply(ok ? 200 : 400, { ok, ...status(), ...(ok ? {} : { error: "wrong code" }) });
          } else return reply(404, { ok: false });
          reply(200, { ok: true, ...status() });
        } catch (e) {
          reply(500, { ok: false, error: String(e?.message || e) });
        }
      });
      return;
    }
    if (req.url.startsWith("/access")) {
      res.writeHead(403).end();
      return;
    }
    if (req.url.startsWith("/pair?") && loopback && keyOk) {
      // The ticket carries current addresses and relay, which change with the network.
      const t = irohEp?.ticket();
      if (t && t !== irohTicket) { irohTicket = t; buildPairPage(useTls); }
      res.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" });
      res.end(irohStarting ? pairPage.replace("</head>", '<meta http-equiv="refresh" content="2"></head>') : pairPage);
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
  // Plaintext would put the token and every byte on the LAN in the clear, so without TLS only this machine may connect.
  if (!useTls) server.on("connection", (s) => { if (!/^(::ffff:)?127\.|^::1$/.test(s.remoteAddress || "")) s.destroy(); });

  // Origin check: browsers always send Origin, so cross-origin upgrades are refused (403) before any
  // socket opens; native clients send none. Max payload is a clipboard image (24 MB base64).
  const wss = new WebSocketServer({ noServer: true, maxPayload: 32 << 20 });
  liveWss = wss;
  const onUpgrade = (req, socket, head) => {
    const samePath = req.url === "/ws";
    let originOk = true;
    if (req.headers.origin) {
      try {
        const oh = new URL(req.headers.origin).host;
        // Exact same-origin or any loopback origin: webviews and port-forward proxies rewrite Host,
        // and the token gate still authenticates the socket itself.
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
  };
  server.on("upgrade", onUpgrade);
  // The PC's own browser: plain HTTP bound to loopback, which browsers treat as a secure context, so the
  // phone page opens without a certificate warning while phones keep the pinned TLS port.
  const localPort = Number(process.env.RH_LOCAL_PORT) || port + 10;
  const local = useTls ? http.createServer(requestHandler) : null;
  local?.on("upgrade", onUpgrade);
  local?.on("error", (e) => console.warn(`  local page unavailable on ${localPort}: ${e.message}`));
  local?.listen(localPort, "127.0.0.1");

  wss.on("connection", (ws, req) => {
    if (stopping) return ws.close(stopping.code, stopping.reason);
    // 4100: the phone shows why and does not keep retrying until it is switched back on.
    if (!access.remoteOn) return ws.close(4100, "remote access is switched off on the PC");
    // Read off `req`: ws exposes the socket as `_socket`, so `ws.socket?.remoteAddress` was always
    // undefined and every client shared one rate-limit counter, locking out the whole LAN.
    const clientIp = (req.socket?.remoteAddress || "unknown").replace(/^::ffff:/, "");
    ws._subs = new Set();
    ws._loopback = clientIp === "127.0.0.1" || clientIp === "::1";
    ws._authed = false;
    ws._alive = true;
    ws.on("pong", () => { ws._alive = true; });
    plugins.callHook("onConnect", ws);
    const timer = setTimeout(() => ws.close(4001, "auth timeout"), HELLO_TIMEOUT);
    ws.on("close", () => {
      clearTimeout(timer);
      detachClient(ws);
      plugins.callHook("onDisconnect", ws);
    });
    ws.on("message", (raw, isBinary) => {
      // A hello is tiny; anything big before auth is only there to burn memory and CPU.
      if (!ws._authed && raw.length > 16 << 10) return ws.close(1009, "hello too large");
      if (isBinary) return ws._authed && phoneBinary(ws, raw);
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }
      if (!msg || typeof msg !== "object") return;
      // Nothing but a hello is answered before auth, so the socket is not kept open to feed plugins and logs.
      if (!ws._authed && msg.type !== "hello") return ws.close(4003, "hello first");
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
          if (auth?.totpRequired) {
            ws.close(4011, "two-factor code required");
            return;
          }
          if (auth?.passwordRequired) {
            ws.close(4012, "connection password required");
            return;
          }
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
            ws._android = msg.platform === "android";
            ws._name = typeof msg.name === "string" ? msg.name.slice(0, 80) : null;
            send(ws, hi);
            // The console token opens a SYSTEM daemon: once a phone holds its own token, the
            // master token (on screen, in a QR photo, in browser history) stops working.
            if (CONSOLE && auth.pairing) rotateToken();
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

  // A slept or dropped phone leaves a half-open TCP the daemon still counts as connected; ping each
  // real ws every 30s and drop any that missed the last pong. iroh sockets self-detect a dead path.
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (typeof ws.ping !== "function" || typeof ws.terminate !== "function") continue;
      if (ws._alive === false) { ws.terminate(); continue; }
      ws._alive = false;
      try { ws.ping(); } catch {}
    }
  }, 30_000);
  heartbeat.unref();
  wss.on("close", () => clearInterval(heartbeat));

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
    // The phone keeps the current iroh address, which also repairs an entry paired from a QR without one.
    const iroh = irohEp?.ticket() || undefined;
    return { type: "welcome", version: 1, clientId: auth.id, deviceToken, sessions: allSessions(), manifests: registry.list(), wake, iroh, os: process.platform };
  }

  function disconnectDevice(clientId) {
    for (const client of wss.clients) if (client._clientId === clientId) client.close(4003, "device revoked");
  }

  // Master token pairs a new device and gets it its own token; a device token
  // identifies that device. The id is never taken from a client claim alone.
  function authenticate(msg) {
    if (msg.type !== "hello" || typeof msg.token !== "string") return null;
    const t = msg.token;
    const master = t.length === token.length && crypto.timingSafeEqual(Buffer.from(t), Buffer.from(token));
    const d = master ? null : devices.byToken(t);
    if (!master && !d) return null;
    // Checked only after a valid token, so the close code never tells a tokenless guesser the password was right.
    if (access.hasPassword && !access.verifyPassword(msg.password)) return { passwordRequired: true };
    if (d) return { id: d.id };
    let id = String(msg.clientId || crypto.randomUUID());
    if (devices.isRevoked(id)) return null;
    // Claiming a paired device's id would replace its token and take over its identity.
    if (devices.hasToken(id)) id = crypto.randomUUID();
    if (!totp.allowsPairing(msg.totp)) return { totpRequired: true };
    return { id, pairing: true };
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
    if (!access.controlAllowed && !PAUSE_ALLOWED.has(msg.type)) return send(ws, { type: "error", message: `${msg.type}: control is paused on the PC` });
    if (CONSOLE) audit(ws, msg);
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

  // Desktop capture + input, the frame source for rd_/desktop UIs. Frames (~200-300 KB) go straight
  // to each watching ws, too heavy to broadcast; the capture loop runs only while a watcher is attached.
  const desktop = new DesktopController();
  // New terminals take the PC screen's size once the desktop view has listed the monitors.
  const listMonitors = desktop.monitors.bind(desktop);
  desktop.monitors = async () => {
    const r = await listMonitors();
    const p = r.monitors?.find((m) => m.primary) || r.monitors?.[0];
    if (p) sessions.setPcScreen(p.w, p.h);
    return r;
  };
  const access = createAccess(config);
  access.onRemoteChange = (on) => { if (!on) for (const ws of wss.clients) try { ws.close(4100, "remote access is switched off on the PC"); } catch {} };
  const recorder = new Recorder();
  const desktopWatchers = new Set();
  desktop.on("frame", (frame) => {
    for (const w of desktopWatchers) {
      try {
        send(w, { type: "desktop_frame", ...frame });
      } catch { /* watcher vanished mid-send */ }
    }
  });
  // A stream that cannot capture (macOS without Screen Recording) would otherwise just stay black.
  desktop.on("capture_error", (reason) => {
    for (const w of desktopWatchers) {
      try { send(w, { type: "desktop_frame_error", reason }); } catch { /* watcher vanished mid-send */ }
    }
  });

  // Viewers draw the pointer themselves, in the pixels of the picture they receive.
  // fx/fy (a fraction of what the viewer's picture shows) is exact at any capture size; x/y is for older viewers.
  desktop.on("cursor", (c) => {
    for (const w of new Set([...videoWatchers, ...desktopWatchers])) {
      const video_ = videoWatchers.has(w);
      const s = video_ ? video.scale : desktop.scale;
      const m = video_ ? video.monitor : null;
      const rect = video_ ? video.monitor : desktop.frameRect;
      const f = rect?.w > 0 && rect?.h > 0 ? toFraction(rect, c) : {};
      try {
        send(w, { type: "desktop_cursor", x: Math.round((c.x - (m?.x || 0)) * s), y: Math.round((c.y - (m?.y || 0)) * s), ...f, shape: c.shape, visible: c.visible });
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

  // Viewers get binary [kind, ...bitstream] messages (0 config, 1 key, 2 delta, 3 audio). A viewer
  // whose socket backs up skips frames until a fresh keyframe, which only a restart produces.
  const video = new DesktopVideo({ native: desktop.macVideo });
  const audio = new DesktopAudio();
  const videoWatchers = new Set();
  let resyncTimer = null;
  // Ctrl+Alt+Del, a UAC prompt or the lock screen switch to the secure desktop, which stops ddagrab
  // until the switch ends; keep retrying while anyone watches instead of leaving the picture frozen.
  const resync = (delay = 250) => {
    if (resyncTimer) return;
    resyncTimer = setTimeout(async () => {
      resyncTimer = null;
      if (videoWatchers.size && !(await video.restart()) && videoWatchers.size) resync(1000);
    }, delay);
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
  // PC sound: Windows/Linux encode it separately; macOS's native helper hands it through DesktopVideo.
  // One AAC ADTS frame per message, kind 3, only to viewers that asked for sound and are not far behind.
  // Phones playing the PC's sound without watching the screen (the phone as a speaker).
  const audioListeners = new Set();
  const onAudio = (adts) => {
    const msg = Buffer.concat([Buffer.from([3]), adts]);
    for (const w of new Set([...videoWatchers, ...audioListeners])) {
      if (w.readyState !== 1 || !(w._audio || audioListeners.has(w))) continue;
      if (w.sendAudio) w.sendAudio(adts);
      else if (w.bufferedAmount < 1_000_000) w.send(msg);
    }
  };
  video.on("audio", onAudio);
  audio.on("audio", onAudio);
  /** Turn PC sound on while any viewer wants it, off when none do. macOS folds it into the video restart. */
  function syncAudio() {
    const want = [...videoWatchers].some((w) => w._audio) || audioListeners.size > 0;
    if (process.platform === "darwin") {
      if (want !== video.audio) { video.audio = want; if (videoWatchers.size) resync(); }
      return;
    }
    if (want && !audio.running) audio.start();
    else if (!want && audio.running) audio.stop();
  }
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
    audio.stop();
    scheduler.stop();
    desktop.dispose();
    recorder.dispose();
    mpc.dispose();
    sshSrv.stop();
    bastion.stop();
    devices.persist();
  });

  sessions.sessionEvents.on("create", (s) => recorder.terminalStarted(s));
  sessions.sessionEvents.on("resize", ({ id, cols, rows }) => recorder.terminalResized(id, cols, rows));
  sessions.sessionEvents.on("exit", ({ id }) => recorder.terminalEnded(id));
  sessions.sessionEvents.on("output", ({ id, text }) => {
    recorder.terminalOutput(id, text);
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
  // Queued follow-ups: when a turn finishes, send the next queued prompt so the phone can walk away.
  // Broadcast after every change, or clients show a stale queue strip.
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
    desktop, desktopWatchers, video, videoWatchers, recorder, access, bastion, sshSrv, mpc, streamParser,
    activity, tls, syncAudio, audioListeners, clients: () => wss.clients,
  };
  const handlers = withSources({
    ...agentsHandlers(ctx), ...filesHandlers(ctx), ...remoteHandlers(ctx), ...sshHandlers(ctx), ...systemHandlers(ctx), ...phoneHandlers(ctx), ...phoneAdbHandlers(ctx), ...phoneSyncHandlers(ctx), ...pcPadHandlers(ctx), ...displayHandlers(ctx), ...computersHandlers(ctx),
  }, ctx);
  // The link another PC adds this one with; it carries the pairing token, so only this machine's page gets it.
  handlers.pc_pairing_link = async (ws) => send(ws, ws._loopback && pairLink ? { type: "pc_pairing_link", link: pairLink } : { type: "pc_error", message: "open this page on the PC itself to copy its link" });


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
    // Only to an interactive console: the tray and service capture stdout into log files.
    if (process.env.NODE_ENV !== 'production' && process.stdout.isTTY) {
      console.log(`  token     ${token}`);
    }
    if (useTls) {
      console.log(`  tls       enabled, cert fingerprint ${fp}`);
    } else {
      console.warn("  tls       OFF: only connections from this machine are accepted (phones need wss)");
    }
    const pairUrl = `http${useTls ? "s" : ""}://localhost:${port}/pair`;
    console.log(process.stdout.isTTY
      ? `  pairing   ${pairUrl}?k=${token}  (open on THIS PC, scan the QR from the app)`
      : `  pairing   the PocketDesk app entry, or ${pairUrl}?k=<token from config.json>`);
    console.log(`  config    ${configPath}`);
    console.log("");
    // iroh sockets join wss.clients so broadcast and revoke reach them like /ws sockets.
    if (irohCfg?.enabled) {
      irohStarting = true;
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
        irohStarting = false;
        if (!ep) return console.log("  iroh      unavailable (optional @number0/iroh not installed)");
        irohEp = ep;
        irohTicket = ep.ticket();
        buildPairPage(useTls);
        console.log(`  iroh      ${ep.id}`);
      }).catch((e) => { irohStarting = false; console.log(`  iroh      failed to start: ${e?.message || e}`); });
    }
    sessionStore.init();
    cliServer.start(() => token, { broadcast, allSessions, pairLink: () => pairLink });
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
