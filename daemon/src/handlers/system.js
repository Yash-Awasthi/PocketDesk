import * as proposals from "../proposals.js";
import * as registry from "../registry.js";
import * as toolApproval from "../tool_approval.js";
import * as pcPower from "../pc_power.js";
import { hostStats } from "../stats.js";
import * as fbCtrl from "../freebuff_control.js";
import * as doctor from "../doctor.js";
import * as devices from "../devices.js";
import { startChat } from "./agents.js";
import fs from "node:fs";
import path from "node:path";
import { RECORDINGS } from "../recorder.js";

export default function systemHandlers(ctx) {
  const { send, plugins, streamParser, tls, desktop } = ctx;
  return {
    // Recorded terminal sessions (asciicast) for the phone's player; the folder is flat, so a bare name is all it takes.
    async recordings_list(ws) {
      let names = [];
      try { names = fs.readdirSync(RECORDINGS).filter((n) => n.endsWith(".cast")); } catch {}
      const items = names.map((name) => {
        const st = fs.statSync(path.join(RECORDINGS, name));
        return { name, size: st.size, mtime: st.mtimeMs };
      }).sort((a, b) => b.mtime - a.mtime);
      send(ws, { type: "recordings_list", items });
    },
    async recording_get(ws, msg) {
      const name = String(msg.name || "");
      const file = path.join(RECORDINGS, name);
      if (name !== path.basename(name) || !name.endsWith(".cast") || !fs.existsSync(file)) return send(ws, { type: "recording_get", name, error: `no such recording: ${name}` });
      // ponytail: whole file in one message; stream it in chunks if recordings outgrow the socket's message cap.
      send(ws, { type: "recording_get", name, text: fs.readFileSync(file, "utf8") });
    },
    async propose(ws, msg) {
      const p = proposals.create({
        type: msg.proposalType || "command_execute",
        summary: msg.summary || "Unnamed action",
        detail: msg.detail || {},
        sessionId: msg.sessionId || "unknown",
      });
      // proposals.create, approve and reject broadcast the change to every phone, this one included.
      plugins.callHook("onProposal", ws, p);
    },
    async approve(ws, msg) {
      const p = proposals.approve(msg.id);
      if (p) {
        if (msg.all === true) toolApproval.trust(p.detail?.agentSession);
        plugins.callHook("onProposalApproved", ws, p);
      } else {
        send(ws, { type: "error", message: `proposal ${msg.id} not found or already decided` });
      }
    },
    async reject(ws, msg) {
      const p = proposals.reject(msg.id);
      if (p) {
        plugins.callHook("onProposalRejected", ws, p);
      } else {
        send(ws, { type: "error", message: `proposal ${msg.id} not found or already decided` });
      }
    },
    async pc_power(ws, msg) {
      send(ws, { type: "pc_power", action: msg.action, ...(await pcPower.run(msg.action, { lockMac: () => desktop.lockScreen() })) });
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
      await registry.ready;
      const s = fbCtrl.skillGet(String(msg.name ?? ""));
      if (!s.ok) { send(ws, { type: "fb_skill_run", ok: false, error: s.error }); return; }
      const prompt = [`Skill: ${s.name}`, "", s.content, "", String(msg.args ?? "").trim() ? `Task: ${msg.args}` : ""].filter(Boolean).join("\n");
      const r = startChat(ctx, ws, String(msg.harness ?? "claude"), msg.cwd, prompt);
      if (r.error) { send(ws, { type: "fb_skill_run", ok: false, error: r.error }); return; }
      send(ws, { type: "fb_skill_run", ok: true, skill: s.name, chatId: r.chat.id });
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
    // ── Client devices: read-only here; revoke and allow live on the local settings page ──
    async device_list(ws, msg) {
      send(ws, { type: "device_list", items: devices.list() });
    },
  };
}
