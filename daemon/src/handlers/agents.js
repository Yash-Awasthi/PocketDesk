import { exec, execFile } from "node:child_process";
import { promisify } from "node:util";
import * as registry from "../registry.js";
import * as appDiscovery from "../app_discovery.js";
import * as sessions from "../sessions.js";
import * as chat from "../chat.js";
import { NotificationEvents } from "../notifications.js";
import * as sessionStore from "../session-store.js";
import * as sdkAdapter from "../sdk-adapter.js";
import * as slashCommands from "../slash-commands.js";
import * as auditLog from "../audit-log.js";
import * as resurrect from "../resurrect.js";
import { TerminalRenderer } from "../terminal_renderer.js";
import * as promptQueue from "../prompt_queue.js";
import * as agentTodos from "../agent_todos.js";
import * as scheduler from "../scheduler.js";
import * as approvalGuard from "../approval_guard.js";
import * as liveDigest from "../live_digest.js";
import * as statsUsage from "../stats_usage.js";
import * as envProfiles from "../env_profiles.js";
import * as planMode from "../plan_mode.js";

export default function agentsHandlers(ctx) {
  const { send, broadcast, allSessions, notifications, plugins, power, shares, activity } = ctx;
  // Runs one of a manifest's fixed auth commands; nothing from the client reaches the command line.
  const runAuth = (m, args) => new Promise((resolve) => {
    const [bin, argv] = process.platform === "win32" ? ["cmd.exe", ["/c", m.bin, ...args]] : [m.bin, args];
    execFile(bin, argv, { timeout: 30000, windowsHide: true, encoding: "utf8" }, (err, stdout, stderr) =>
      resolve({ code: err ? (typeof err.code === "number" ? err.code : 1) : 0, text: `${stdout}${stderr}`.trim().slice(0, 2000) }));
  });
  const authManifest = (ws, msg, op) => {
    const m = registry.get(msg.harness);
    if (!m?.auth?.[op]) {
      send(ws, { type: "error", message: `${m?.name ?? msg.harness}: no ${op} command, use its terminal` });
      return null;
    }
    return m;
  };
  const self = {
    // ── Agent accounts: status runs headless; login/logout run in a terminal (device codes, links, provider pickers) ──
    async auth_status(ws, msg) {
      const m = authManifest(ws, msg, "status");
      if (!m) return;
      const r = await runAuth(m, m.auth.status);
      // OpenCode also counts provider keys from the environment next to its stored credentials.
      const noCreds = /\b0 credentials/i.test(r.text) && !/[1-9]\d* environment variables?/i.test(r.text);
      const loggedIn = r.code === 0 && !noCreds && !/not logged in|logged out|no credentials|"loggedIn":\s*false/i.test(r.text);
      send(ws, { type: "auth_status", harness: m.id, loggedIn, text: r.text });
    },
    async auth_logout(ws, msg) {
      const m = authManifest(ws, msg, "logout");
      if (!m) return;
      auditLog.log("auth_logout", { harness: m.id });
      return self.create(ws, { harness: m.id, cwd: msg.cwd, args: m.auth.logout });
    },
    async auth_login(ws, msg) {
      const m = authManifest(ws, msg, "login");
      if (!m) return;
      return self.create(ws, { harness: m.id, cwd: msg.cwd, args: m.auth.login });
    },
    async detect(ws, msg) {
      await registry.scanAll(broadcast);
    },
    async install(ws, msg) {
      registry.install(msg.id, broadcast).catch((e) => send(ws, { type: "error", message: `install failed: ${e?.message || e}` }));
    },
    async create(ws, msg) {
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
    },
    async chatsession(ws, msg) {
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
    },
    async chatmsg(ws, msg) {
      if (ws._shareMode === "readonly") return send(ws, { type: "error", message: "chat is read-only (spectator)" });
      const c = chat.get(msg.id);
      if (!c) return send(ws, { type: "error", message: `no such chat: ${msg.id}` });
      if (c.state === "running") return send(ws, { type: "error", message: "still working on the previous prompt" });
      chat.attach(msg.id, ws);
      const text = String(msg.text || "");
      const result = slashCommands.handle(text, msg.id);
      if (result !== null) {
        send(ws, { type: "chatdelta", id: msg.id, text: result + "\n" });
        return;
      }
      chat.sendUserMessage(c, text);
      broadcast({ type: "sessions", items: allSessions() });
    },
    // ── Chat forking (1code): clone transcript up to a message into a sub-chat ──
    // ── Sessions list on request (phone reconnect asks for current state) ──
    async sessions(ws, msg) {
      send(ws, { type: "sessions", items: allSessions() });
    },
    async chat_fork(ws, msg) {
      const r = chat.forkChat(String(msg.id), msg.at ?? -1, { cwd: msg.cwd, env: msg.env });
      if (!r.ok) return send(ws, { type: "error", message: r.error });
      sessionStore.upsert(r.chat.id, { name: "fork", project: r.chat.cwd, type: "chat", status: "idle" });
      send(ws, { type: "chat_forked", ok: true, chat: r.chat });
      broadcast({ type: "sessions", items: allSessions() });
    },
    // ── Env profiles / BYOK (1code, Vibe Companion): per-chat env overrides ──
    async env_profile_list(ws, msg) {
      send(ws, { type: "env_profiles", items: envProfiles.list() });
    },
    async env_profile_set(ws, msg) {
      const r = envProfiles.set(String(msg.name ?? ""), msg.vars);
      send(ws, r.ok ? { type: "env_profile_ok", ok: true, name: msg.name } : { type: "error", message: r.error });
    },
    async env_profile_remove(ws, msg) {
      const r = envProfiles.remove(String(msg.name ?? ""));
      send(ws, r.ok ? { type: "env_profile_ok", ok: true, name: msg.name } : { type: "error", message: r.error });
    },
    async env_profile_attach(ws, msg) {
      const r = envProfiles.attach(String(msg.id), String(msg.name ?? ""));
      send(ws, r.ok ? { type: "env_profile_ok", ok: true, id: r.id, profile: r.profile, keys: r.keys } : { type: "error", message: r.error });
    },
    async env_profile_detach(ws, msg) {
      const r = envProfiles.detach(String(msg.id));
      send(ws, r.ok ? { type: "env_profile_ok", ok: true, id: r.id } : { type: "error", message: r.error });
    },
    // ── Plan mode (1code): extract the agent's checklist plan, approve it ──
    async plan_get(ws, msg) {
      const r = planMode.getPlan(String(msg.id));
      if (!r.ok) return send(ws, { type: "error", message: r.error });
      send(ws, { type: "plan", id: r.id, plan: r.plan, approved: r.approved });
    },
    async plan_approve(ws, msg) {
      const r = planMode.approve(String(msg.id), msg.approved);
      if (!r.ok) return send(ws, { type: "error", message: r.error });
      send(ws, { type: "plan_ok", id: r.id, approved: r.approved });
    },
    // ── Permission-mode switch per running chat (agent-tmux-web/claude-threads) ──
    async chat_permission(ws, msg) {
      const c = chat.get(msg.id);
      if (!c) return send(ws, { type: "error", message: `no such chat: ${msg.id}` });
      c.permissionMode = String(msg.mode ?? "default");
      send(ws, { type: "chat_permission_ok", id: c.id, mode: c.permissionMode });
    },
    // ── Plain-text scrollback (retach: native-scrollback passthrough) ──
    async chat_text(ws, msg) {
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
    },
    async chatcancel(ws, msg) {
      if (ws._shareMode === "readonly") return send(ws, { type: "error", message: "chat is read-only (spectator)" });
      const c = chat.get(msg.id);
      if (c) {
        chat.cancel(c);
        broadcast({ type: "sessions", items: allSessions() });
      }
    },
    async attach(ws, msg) {
      if (!chat.attach(msg.id, ws) && !sessions.attach(msg.id, ws, { since: msg.since })) {
        send(ws, { type: "error", message: `no live session: ${msg.id}` });
      }
    },
    async sessions_get(ws, msg) {
      send(ws, { type: "sessions_get", items: allSessions() });
    },
    async sessions_scan(ws, msg) {
      // Zero-touch OS-level agent scan (c9watch/nexting): which known agent
      // binaries have live processes right now, with their command lines.
      try {
        // `wmic` was removed in Windows 11 24H2, so the tasklist fallback is
        // the normal path there. It must not use `/v`: window titles take it
        // from ~0.35s to ~21s, past the timeout, and only image names are
        // matched here anyway.
        const probe = process.platform === "win32"
          ? "wmic process get processid,commandline /format:csv 2>nul || tasklist /fo csv /nh"
          : "ps -eo pid=,args=";
        const { stdout: out } = await promisify(exec)(probe, { encoding: "utf-8", timeout: 8000, windowsHide: true });
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
    },
    async detach(ws, msg) {
      sessions.detach(ws, msg.id);
      chat.detach(ws, msg.id);
    },
    async in(ws, msg) {
      if (ws._shareMode === "readonly") return send(ws, { type: "error", message: "session is read-only (spectator)" });
      sessions.write(msg.id, Buffer.from(msg.data, "base64").toString("utf8"));
    },
    async resize(ws, msg) {
      sessions.resize(msg.id, msg.cols, msg.rows);
    },
    async kill(ws, msg) {
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
    },
    async sdk_launch(ws, msg) {
      const m = registry.get(msg.harness);
      if (!m) return send(ws, { type: "error", message: `unknown harness: ${msg.harness}` });
      const s = sdkAdapter.launch({ bin: m.bin, cwd: msg.cwd, args: m.chat?.args, model: msg.model, permissionMode: msg.permissionMode });
      sessionStore.upsert(s.id, { name: m.name, project: msg.cwd || "", type: "sdk", status: "starting" });
      send(ws, { type: "sdk_created", id: s.id, cwd: s.cwd });
      broadcast({ type: "sessions", items: allSessions() });
    },
    async sdk_prompt(ws, msg) {
      if (!sdkAdapter.sendPrompt(msg.id, String(msg.text || ""))) {
        send(ws, { type: "error", message: `no connected SDK session: ${msg.id}` });
      }
    },
    async sdk_approve(ws, msg) {
      sdkAdapter.approve(msg.id, msg.requestId, msg.approved);
    },
    async sdk_interrupt(ws, msg) {
      sdkAdapter.interrupt(msg.id);
    },
    async sdk_subscribe(ws, msg) {
      sdkAdapter.subscribe(msg.id, ws);
    },
    async chat_history(ws, msg) {
      send(ws, { type: "chat_history", items: chat.listHistory() });
    },
    async pin(ws, msg) {
      registry.pin(msg.id);
      send(ws, { type: "pinned", ids: registry.listPinned() });
    },
    async unpin(ws, msg) {
      registry.unpin(msg.id);
      send(ws, { type: "pinned", ids: registry.listPinned() });
    },
    // ── Digest render (restty: plain-text read-only render, token savings) ──
    async render_digest(ws, msg) {
      const renderer = new TerminalRenderer({ cols: msg.cols || 80, rows: msg.rows || 24 });
      renderer.feed(String(msg.text ?? ""));
      const screen = renderer.getScreen().map((row) => row.replace(/\s+$/, ""));
      // Trailing all-blank rows carry no information — trim them for the wire.
      while (screen.length > 0 && screen[screen.length - 1]?.trim() === "") screen.pop();
      send(ws, { type: "digest_render", rows: screen, width: renderer.cols });
    },
    // ── Launch a GUI application (IDEs) ──────────────────────────────────
    // GUI apps have no PTY to stream, so this only starts the process. The
    // phone then watches and drives it through the desktop frame stream.
    async gui_open(ws, msg) {
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
    },
    // Everything installed on this machine, not only what ships a manifest.
    async apps_discover(ws, msg) {
      if (msg.refresh) appDiscovery.discover({ refresh: true });
      send(ws, { type: "apps", items: appDiscovery.search(msg.q ?? "") });
    },
    // ── Model selection (phone picks the model a chat runs with) ───────────
    async model_list(ws, msg) {
      const r = chat.listModels(String(msg.id ?? ""));
      send(ws, { type: "model_list", ...r });
    },
    async chat_model_set(ws, msg) {
      const r = chat.setModel(String(msg.id ?? ""), msg.model ? String(msg.model) : null);
      send(ws, { type: "chat_model_set", ...r });
    },
    // ── Activity monitor (webmux/purplemux: busy→quiet, per-session status) ──
    async activity_list(ws, msg) {
      send(ws, { type: "activity_list", items: activity.summary() });
    },
    // ── Chat resurrection (zellij-resurrect: restore chats after restart) ──
    async resurrect_list(ws, msg) {
      send(ws, { type: "resurrect_list", items: resurrect.list() });
    },
    async resume(ws, msg) {
      const rec = resurrect.get(msg.id);
      const m = rec && registry.get(rec.harnessId);
      if (!rec || !m || !chat.supported(m)) return send(ws, { type: "error", message: `no resumable chat: ${msg.id}` });
      const s = chat.create({ manifest: m, cwd: rec.cwd, resumeFirst: true, cliSession: rec.cliSession });
      sessionStore.upsert(s.id, { name: m.name, project: rec.cwd || "", type: "chat", status: "idle" });
      power.addStatus({ agentId: s.id, state: "running", receivedAt: Date.now() });
      // IDs restart from 1 per process, so the resumed chat often reuses the
      // old record's id — clear the stale record BEFORE re-registering.
      resurrect.remove(rec.id);
      resurrect.upsert({ id: s.id, harnessId: m.id, cwd: rec.cwd, name: rec.name, cliSession: rec.cliSession });
      chat.attach(s.id, ws);
      send(ws, { type: "created", ...s, resumed: true });
      broadcast({ type: "sessions", items: allSessions() });
    },
    // ── Prompt queue (1code/ccpocket/oc-remote: queued follow-ups) ───────
    async prompt_enqueue(ws, msg) {
      const chatId = String(msg.id ?? "");
      const text = String(msg.text ?? "").trim();
      if (!text) return send(ws, { type: "prompt_queued", ok: false, error: "empty prompt" });
      const r = promptQueue.enqueue(chatId, text);
      if (r.ok) send(ws, { type: "prompt_queued", ok: true, id: chatId, queue: promptQueue.list(chatId), position: promptQueue.list(chatId).length });
      else send(ws, { type: "prompt_queued", ok: false, error: r.error });
    },
    async prompt_queue(ws, msg) {
      send(ws, { type: "prompt_queue", id: msg.id, items: promptQueue.list(String(msg.id ?? "")) });
    },
    async prompt_remove(ws, msg) {
      const ok = promptQueue.remove(String(msg.id ?? ""), String(msg.promptId ?? ""));
      send(ws, { type: "prompt_removed", ok, id: msg.id, queue: promptQueue.list(String(msg.id ?? "")) });
    },
    // ── Agent todos (c9watch/claude-threads/codeman: live task board) ────
    async todos_set(ws, msg) {
      const items = agentTodos.setTodos(String(msg.id ?? ""), Array.isArray(msg.items) ? msg.items : []);
      broadcast({ type: "todos_updated", id: msg.id, items, derived: false });
    },
    async todos_get(ws, msg) {
      send(ws, { type: "todos", id: msg.id, items: agentTodos.getTodos(String(msg.id ?? "")) });
    },
    async todos_status(ws, msg) {
      const item = agentTodos.updateStatus(String(msg.id ?? ""), String(msg.todoId ?? ""), String(msg.status ?? "pending"));
      if (item) broadcast({ type: "todos_updated", id: msg.id, items: agentTodos.getTodos(String(msg.id ?? "")), derived: false });
      else send(ws, { type: "error", message: `no todo ${msg.todoId} for ${msg.id}` });
    },
    // ── Run scheduler (codeman/codex-bee/kagora: loops + cron) ───────────
    async schedule_create(ws, msg) {
      const job = scheduler.schedule({ chatId: msg.chatId, text: msg.text, kind: msg.kind, intervalMs: msg.intervalMs, delayMs: msg.delayMs, maxRuns: msg.maxRuns });
      send(ws, { type: "schedule_created", job });
    },
    async schedule_list(ws, msg) {
      send(ws, { type: "schedule_list", items: scheduler.list() });
    },
    async schedule_pause(ws, msg) {
      const job = scheduler.pause(String(msg.jobId ?? ""));
      send(ws, job ? { type: "schedule_paused", ok: true, job } : { type: "error", message: `no job ${msg.jobId}` });
    },
    async schedule_resume(ws, msg) {
      const job = scheduler.resume(String(msg.jobId ?? ""));
      send(ws, job ? { type: "schedule_resumed", ok: true, job } : { type: "error", message: `no job ${msg.jobId}` });
    },
    async schedule_cancel(ws, msg) {
      const ok = scheduler.cancel(String(msg.jobId ?? ""));
      send(ws, { type: "schedule_cancelled", ok, jobId: msg.jobId });
    },
    // ── Approval auto-deny status (cc-pocket) ───────────────────────────
    async approval_waiting(ws, msg) {
      send(ws, { type: "approval_waiting", items: approvalGuard.listWaiting(), timeoutMs: approvalGuard.getTimeoutMs() });
    },
    // ── Usage/cost dashboard (c9watch/flue/orca/cc-pocket) ──────────────
    async usage_list(ws, msg) {
      send(ws, { type: "usage_list", items: statsUsage.list(), totals: statsUsage.totals() });
    },
    async usage_get(ws, msg) {
      send(ws, { type: "usage", id: msg.id, ...(statsUsage.get(String(msg.id ?? "")) ?? { inputTokens: 0, outputTokens: 0, costUsd: 0, turns: 0, points: [] }) });
    },
    // ── Live digest attach (mcp-interactive-terminal: token-saving view) ──
    async digest_attach(ws, msg) {
      if (sessions.get(String(msg.id ?? ""))) {
        liveDigest.attach(String(msg.id), ws, { cols: msg.cols, rows: msg.rows });
        send(ws, { type: "digest_attached", ok: true, id: msg.id });
      } else {
        send(ws, { type: "error", message: `no live session: ${msg.id}` });
      }
    },
    async digest_detach(ws, msg) {
      liveDigest.detach(ws, String(msg.id ?? ""));
      send(ws, { type: "digest_detached", ok: true });
    },
    // ── Chat search (flue/1code: find prompts across history) ─────────
    async chat_search(ws, msg) {
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
    },
    // ── Hot manifest reload (frp: config reload without restart) ─────
    async manifest_reload(ws, msg) {
      await registry.scanAll(broadcast);
      send(ws, { type: "manifests_reloaded", count: registry.list().length });
    },
  };
  return self;
}
