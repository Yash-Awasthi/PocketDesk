import * as registry from "../registry.js";
import * as sessions from "../sessions.js";
import * as chat from "../chat.js";
import * as proposals from "../proposals.js";
import { NotificationEvents } from "../notifications.js";
import * as voice from "../voice.js";
import * as auditLog from "../audit-log.js";
import { normalizeAwakeMode } from "../power_manager.js";
import { hostStats } from "../stats.js";
import * as fbCtrl from "../freebuff_control.js";
import * as doctor from "../doctor.js";
import * as wakeOnLan from "../wake_on_lan.js";
import * as mcpServer from "../mcp_server.js";
import * as quietHours from "../quiet_hours.js";
import * as devices from "../devices.js";

export default function systemHandlers(ctx) {
  const { send, broadcast, allSessions, notifications, plugins, power, shares, recorder, relay, shooter, streamParser, tls, rotateToken, disconnectDevice } = ctx;
  return {
    async propose(ws, msg) {
      const p = proposals.create({
        type: msg.proposalType || "command_execute",
        summary: msg.summary || "Unnamed action",
        detail: msg.detail || {},
        sessionId: msg.sessionId || "unknown",
      });
      plugins.callHook("onProposal", ws, p);
      notifications.send(NotificationEvents.PROPOSAL_CREATED, { id: p.id, type: p.type, summary: p.summary });
      send(ws, { type: "proposal_created", proposal: { id: p.id, type: p.type, summary: p.summary, status: p.status } });
    },
    async approve(ws, msg) {
      const p = proposals.approve(msg.id);
      if (p) {
        plugins.callHook("onProposalApproved", ws, p);
        notifications.send(NotificationEvents.PROPOSAL_APPROVED, { id: p.id, summary: p.summary });
        send(ws, { type: "proposal_approved", proposal: { id: p.id, status: p.status } });
      } else {
        send(ws, { type: "error", message: `proposal ${msg.id} not found or already decided` });
      }
    },
    async reject(ws, msg) {
      const p = proposals.reject(msg.id);
      if (p) {
        plugins.callHook("onProposalRejected", ws, p);
        notifications.send(NotificationEvents.PROPOSAL_REJECTED, { id: p.id, summary: p.summary });
        send(ws, { type: "proposal_rejected", proposal: { id: p.id, status: p.status } });
      } else {
        send(ws, { type: "error", message: `proposal ${msg.id} not found or already decided` });
      }
    },
    async proposal_list(ws, msg) {
      send(ws, { type: "proposal_list", items: proposals.listPending() });
    },
    async transcribe(ws, msg) {
      if (!voice.isAvailable()) {
        send(ws, { type: "error", message: "Voice transcription unavailable. Set OPENAI_API_KEY." });
        return;
      }
      try {
        const text = await voice.transcribe(msg.audio, msg.format, msg.language);
        send(ws, { type: "transcribed", text });
      } catch (e) {
        send(ws, { type: "error", message: e.message });
      }
    },
    async audit_log(ws, msg) {
      send(ws, { type: "audit_log", items: auditLog.getLog(msg.limit) });
    },
    // ── Session shares (ttyd/gotty/termpair: read-only spectators) ──
    async share_create(ws, msg) {
      const share = shares.create({ sessionId: msg.id, mode: msg.mode, ttlMinutes: msg.ttlMinutes, maxViewers: msg.maxViewers });
      auditLog.log("share_create", { id: msg.id, mode: share.mode });
      send(ws, { type: "share_created", token: share.token, sessionId: share.sessionId, mode: share.mode, expiresAt: share.expiresAt });
    },
    async share_join(ws, msg) {
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
    },
    async share_list(ws, msg) {
      send(ws, { type: "share_list", items: shares.list() });
    },
    async share_revoke(ws, msg) {
      shares.revoke(msg.token);
      send(ws, { type: "share_revoked", token: msg.token });
    },
    // ── Host stats (webmux/vmux host cards) ──
    async stats(ws, msg) {
      send(ws, hostStats());
    },
    // ── Session recording (asciinema/termpair: record + replay/export) ──
    async record_start(ws, msg) {
      recorder.startRecording(msg.id);
      send(ws, { type: "recording", id: msg.id, active: true });
    },
    async record_stop(ws, msg) {
      const rec = recorder.stopRecording(msg.id);
      send(ws, { type: "recording", id: msg.id, active: false, events: rec?.events?.length ?? 0 });
    },
    async record_list(ws, msg) {
      send(ws, { type: "record_list", items: recorder.listSessions() });
    },
    async record_get(ws, msg) {
      send(ws, { type: "record_get", id: msg.id, events: recorder.getEvents(msg.id), export: recorder.exportSession(msg.id, msg.format || "json") });
    },
    // ── Relay (hermes-relay: outbound link + optional relay hosting) ────
    async relay_connect(ws, msg) {
      const url = msg.url || process.env.RH_RELAY_URL;
      const channel = msg.channel || process.env.RH_RELAY_CHANNEL || relay.defaultChannel();
      if (!url) {
        send(ws, { type: "relay_state", state: "error", message: "no relay url (set RH_RELAY_URL or pass msg.url)" });
        return;
      }
      relay.connect(url, channel);
      send(ws, { type: "relay_state", state: "connecting", url, channel });
    },
    async relay_disconnect(ws, msg) {
      relay.disconnect();
      send(ws, { type: "relay_state", state: "disconnected" });
    },
    async relay_status(ws, msg) {
      send(ws, { type: "relay_status", ...relay.status() });
    },
    async relay_publish(ws, msg) {
      relay.publish(msg.data);
      send(ws, { type: "relay_published", channel: relay.status().channel });
    },
    async relay_send(ws, msg) {
      relay.sendTo(msg.to, msg.data);
      send(ws, { type: "relay_sent", to: msg.to });
    },
    async relay_host(ws, msg) {
      relay.host(Number(msg.port));
      send(ws, { type: "relay_host", state: "hosting", port: msg.port });
    },
    async relay_host_stop(ws, msg) {
      relay.hostStop();
      send(ws, { type: "relay_host", state: "stopped" });
    },
    // ── Freebuff control (status/configs/skills/auth from the phone) ───────
    async fb_status(ws, msg) {
      send(ws, { type: "fb_status", ...fbCtrl.status() });
    },
    async fb_config_list(ws, msg) {
      send(ws, { type: "fb_config_list", items: fbCtrl.configList() });
    },
    async fb_config_get(ws, msg) {
      send(ws, { type: "fb_config_get", ...fbCtrl.configGet(String(msg.name ?? "")) });
    },
    async fb_config_set(ws, msg) {
      const r = fbCtrl.configSet(String(msg.name ?? ""), msg.patch);
      send(ws, { type: "fb_config_set", ...r });
    },
    async fb_skill_list(ws, msg) {
      send(ws, { type: "fb_skill_list", items: fbCtrl.skillList() });
    },
    async fb_skill_get(ws, msg) {
      send(ws, { type: "fb_skill_get", ...fbCtrl.skillGet(String(msg.name ?? "")) });
    },
    async fb_skill_run(ws, msg) {
      const s = fbCtrl.skillGet(String(msg.name ?? ""));
      if (!s.ok) { send(ws, { type: "fb_skill_run", ok: false, error: s.error }); return; }
      const m = registry.get(String(msg.harness ?? "claude"));
      if (!m) { send(ws, { type: "fb_skill_run", ok: false, error: `unknown harness: ${msg.harness}` }); return; }
      if (!chat.supported(m)) { send(ws, { type: "fb_skill_run", ok: false, error: `${m.name} has no chat adapter` }); return; }
      if (!registry.isInstalled(m.id)) { send(ws, { type: "fb_skill_run", ok: false, error: `${m.name} is not installed` }); return; }
      const prompt = [`Skill: ${s.name}`, "", s.content, "", String(msg.args ?? "").trim() ? `Task: ${msg.args}` : ""].filter(Boolean).join("\n");
      const ch = chat.create({ manifest: m, cwd: msg.cwd });
      chat.attach(ch.id, ws);
      send(ws, { type: "created", ...ch });
      if (prompt.trim()) chat.sendUserMessage(chat.get(ch.id), prompt.trim());
      broadcast({ type: "sessions", items: allSessions() });
      send(ws, { type: "fb_skill_run", ok: true, skill: s.name, chatId: ch.id });
    },
    async fb_auth_status(ws, msg) {
      send(ws, { type: "fb_auth_status", ...fbCtrl.authStatus() });
    },
    async fb_auth_logout(ws, msg) {
      const r = fbCtrl.authLogout(String(msg.confirm ?? ""), { restart: !!msg.restart });
      send(ws, { type: "fb_auth_logout", ...r });
    },
    async fb_app_open(ws, msg) {
      send(ws, { type: "fb_app_open", ...fbCtrl.appOpen() });
    },
    async fb_app_quit(ws, msg) {
      send(ws, { type: "fb_app_quit", ...fbCtrl.appQuit() });
    },
    // ── Smart notifications (shooter: coalescing/dedupe + telemetry) ──────
    async notify_send(ws, msg) {
      const result = shooter.sendNotification({
        projectId: String(msg.projectId ?? "default"),
        type: String(msg.eventType ?? "info"),
        text: String(msg.text ?? ""),
      });
      send(ws, { type: "notify_sent", ok: result.sent, reason: result.reason ?? null, priority: result.priority ?? null });
    },
    async notify_stats(ws, msg) {
      send(ws, { type: "notify_stats", ...shooter.getTelemetryStats() });
    },
    async notify_test(ws, msg) {
      // Fire a test push through every registered channel so a phone can
      // verify its subscription end-to-end (ntfy topic, Pushover keys, …).
      if (notifications.count() === 0) {
        return send(ws, { type: "notify_test", ok: false, error: "no channels configured (set NTFY_TOPIC or PUSHOVER_TOKEN+PUSHOVER_USER)" });
      }
      notifications.send("session_asking", { summary: "PocketDesk test push — if you can read this on your phone, push works 🎉" });
      send(ws, { type: "notify_test", ok: true, channels: notifications.channels(), note: "sent to all channels — check your phone" });
    },
    async notify_bursts(ws, msg) {
      send(ws, { type: "notify_bursts", items: shooter.detectBursts(Number(msg.windowMs) || 60000) });
    },
    // ── Stream JSON parser (format-claude-stream: agent JSONL → cards) ────
    async stream_parse(ws, msg) {
      const parsed = streamParser.parseLines(String(msg.lines ?? ""));
      send(ws, { type: "stream_parsed", items: parsed.map((p) => ({ type: p.type, formatted: p.formatted, sessionId: p.sessionId })), stats: streamParser.getStats() });
    },
    async stream_stats(ws, msg) {
      send(ws, { type: "stream_stats", ...streamParser.getStats() });
    },
    async stream_reset(ws, msg) {
      streamParser.reset();
      send(ws, { type: "stream_reset", ok: true });
    },
    // ── Power manager (orca/LinkShell: keep the PC awake while agents run) ──
    async power_set(ws, msg) {
      power.setMode(normalizeAwakeMode(msg.mode));
      send(ws, { type: "power_status", ...power.getStatus() });
    },
    async power_status(ws, msg) {
      send(ws, { type: "power_status", ...power.getStatus() });
    },
    // ── Doctor (whatsapp-claude-plugin/marchat: self-diagnosis) ──────────
    async doctor(ws, msg) {
      const health = await doctor.diagnose({ tls, manifests: undefined });
      send(ws, { type: "doctor_report", ...health });
    },
    // ── Wake-on-LAN (rustdesk: power on a LAN machine) ──────────────────
    async wake(ws, msg) {
      const r = await wakeOnLan.wake(msg.mac, { port: msg.port, address: msg.address });
      send(ws, { type: "wake_result", ...r });
    },
    // ── MCP server control (quil/paseo: expose agents as MCP tools) ─────
    async mcp_start(ws, msg) {
      mcpServer.start(Number(msg.port) || 4680);
      send(ws, { type: "mcp_status", ...mcpServer.status() });
    },
    async mcp_stop(ws, msg) {
      mcpServer.stop();
      send(ws, { type: "mcp_status", ...mcpServer.status() });
    },
    async mcp_status(ws, msg) {
      send(ws, { type: "mcp_status", ...mcpServer.status() });
    },
    // ── Quiet hours (marchat/shooter: focus mode) ───────────────────
    async quiet_set(ws, msg) {
      if (msg.mode !== undefined) quietHours.setMode(String(msg.mode));
      if (Array.isArray(msg.windows)) quietHours.setWindows(msg.windows);
      send(ws, { type: "quiet_status", ...quietHours.getState() });
    },
    async quiet_status(ws, msg) {
      send(ws, { type: "quiet_status", ...quietHours.getState() });
    },
    // ── Client devices (openchamber/netbird: list + revoke) ──────────
    async device_list(ws, msg) {
      send(ws, { type: "device_list", items: devices.list() });
    },
    async device_revoke(ws, msg) {
      const r = devices.revoke(String(msg.clientId ?? ""));
      // The revoked device knew the pairing token too, so it must change.
      let pairingToken;
      if (r.ok) {
        disconnectDevice(String(msg.clientId));
        pairingToken = rotateToken();
      }
      send(ws, { type: "device_revoked", ...r, pairingToken });
    },
    async device_allow(ws, msg) {
      const r = devices.allow(String(msg.clientId ?? ""));
      send(ws, { type: "device_allowed", ...r });
    },
  };
}
