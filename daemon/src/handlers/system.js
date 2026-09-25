import * as registry from "../registry.js";
import * as sessions from "../sessions.js";
import * as chat from "../chat.js";
import * as proposals from "../proposals.js";
import { hostStats } from "../stats.js";
import * as fbCtrl from "../freebuff_control.js";
import * as doctor from "../doctor.js";
import * as devices from "../devices.js";

export default function systemHandlers(ctx) {
  const { send, broadcast, allSessions, plugins, streamParser, tls, rotateToken, disconnectDevice } = ctx;
  return {
    async propose(ws, msg) {
      const p = proposals.create({
        type: msg.proposalType || "command_execute",
        summary: msg.summary || "Unnamed action",
        detail: msg.detail || {},
        sessionId: msg.sessionId || "unknown",
      });
      plugins.callHook("onProposal", ws, p);
      send(ws, { type: "proposal_created", proposal: { id: p.id, type: p.type, summary: p.summary, status: p.status } });
    },
    async approve(ws, msg) {
      const p = proposals.approve(msg.id);
      if (p) {
        plugins.callHook("onProposalApproved", ws, p);
        send(ws, { type: "proposal_approved", proposal: { id: p.id, status: p.status } });
      } else {
        send(ws, { type: "error", message: `proposal ${msg.id} not found or already decided` });
      }
    },
    async reject(ws, msg) {
      const p = proposals.reject(msg.id);
      if (p) {
        plugins.callHook("onProposalRejected", ws, p);
        send(ws, { type: "proposal_rejected", proposal: { id: p.id, status: p.status } });
      } else {
        send(ws, { type: "error", message: `proposal ${msg.id} not found or already decided` });
      }
    },
    async proposal_list(ws, msg) {
      send(ws, { type: "proposal_list", items: proposals.listPending() });
    },
    // ── Host stats (webmux/vmux host cards) ──
    async stats(ws, msg) {
      send(ws, hostStats());
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
      const r = fbCtrl.authLogout(String(msg.confirm ?? ""));
      send(ws, { type: "fb_auth_logout", ...r });
    },
    async fb_accounts(ws, msg) {
      send(ws, { type: "fb_accounts", accounts: fbCtrl.accounts() });
    },
    async fb_account_switch(ws, msg) {
      const r = fbCtrl.accountSwitch(String(msg.email ?? ""));
      send(ws, { type: "fb_account_switch", ...r });
      if (r.ok) send(ws, { type: "fb_auth_status", ...fbCtrl.authStatus() });
    },
    async fb_account_forget(ws, msg) {
      send(ws, { type: "fb_accounts", accounts: fbCtrl.accountForget(String(msg.email ?? "")) });
    },
    async fb_app_open(ws, msg) {
      send(ws, { type: "fb_app_open", ...fbCtrl.appOpen() });
    },
    async fb_app_quit(ws, msg) {
      send(ws, { type: "fb_app_quit", ...fbCtrl.appQuit() });
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
    // ── Doctor (whatsapp-claude-plugin/marchat: self-diagnosis) ──────────
    async doctor(ws, msg) {
      const health = await doctor.diagnose({ tls, manifests: undefined });
      send(ws, { type: "doctor_report", ...health });
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
