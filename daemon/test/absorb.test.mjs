// End-to-end tests for the absorption-pass features:
// prompt queue, todos, scheduler, doctor, wake, approval guard, usage stats,
// digest attach, MCP status.
import WebSocket from "ws";
import fs from "node:fs";
import path from "node:path";
import { check, failureCount, failureNames, makeTmp, startDaemon, teardown } from "./helpers.mjs";

const PORT = 8897;
const CLI = 4707;
const TOKEN = "absorbtoken";
const tmp = makeTmp("rh-absorb-");

// Fake chat agent (echoes the prompt as stream-json) for chat_text/search tests.
const agentJs = path.join(tmp, "fakeagent.js");
fs.writeFileSync(agentJs, `
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "echo: " + input.trim() + (process.env.RH_FORK_PROBE ? " RH_FORK_PROBE=" + process.env.RH_FORK_PROBE : "") }] } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "" }) + "\\n");
});
`);
fs.writeFileSync(path.join(tmp, "fakechat.json"), JSON.stringify({
  id: "fakechat", name: "Fake Chat", adapter: "terminal", bin: "node", install: {},
  chat: { args: [agentJs], format: "claude-stream-json" },
}));

// Plain-text agent that prints a permission marker and stays alive, so the
// chat really enters "waiting" (drives the waiting-transition broadcast test).
const waitAgentJs = path.join(tmp, "fakewaitagent.js");
fs.writeFileSync(waitAgentJs, [
  '// Print a permission marker immediately (stdin-independent), stay alive so',
  '// the chat really enters "waiting" — but always self-exit so a Windows',
  '// kill-tree gap can never leak the process.',
  'process.stdout.write("Approve? (y/n)" + String.fromCharCode(10));',
  'setTimeout(() => process.exit(0), 15000);',
].join(String.fromCharCode(10)) + String.fromCharCode(10));
fs.writeFileSync(path.join(tmp, "fakewait.json"), JSON.stringify({
  id: "fakewait", name: "Fake Wait", adapter: "terminal", bin: "node", install: {},
  chat: { args: [waitAgentJs] },
}));

const daemon = startDaemon(PORT, CLI, { token: TOKEN, manifests: tmp });
await daemon.ready;

const seen = [];
const waiters = [];
const ws = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
let authed = false;

ws.on("message", (raw) => {
  const m = JSON.parse(raw.toString());
  seen.push(m);
  for (let i = waiters.length - 1; i >= 0; i--) {
    if (waiters[i].pred(m)) {
      waiters.splice(i, 1)[0].resolve(m);
    }
  }
});

function send(obj) {
  ws.send(JSON.stringify(obj));
}

function next(pred, timeoutMs = 15000) {
  for (const m of seen) if (pred(m)) return Promise.resolve(m);
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting for frame")), timeoutMs);
    waiters.push({ pred: (m) => { if (pred(m)) { clearTimeout(t); return true; } return false; }, resolve });
  });
}

await new Promise((resolve, reject) => {
  ws.on("open", resolve);
  ws.on("error", reject);
});
send({ type: "hello", token: TOKEN });
await next((m) => m.type === "welcome");
authed = true;

// ── Prompt queue ──────────────────────────────────────────────────────────
send({ type: "prompt_enqueue", id: "c999", text: "run the tests" });
await check("prompt_enqueue acks", (await next((m) => m.type === "prompt_queued")).ok === true);
send({ type: "prompt_queue", id: "c999" });
const q = await next((m) => m.type === "prompt_queue");
check("prompt_queue lists the item", q.items.length === 1 && q.items[0].text === "run the tests");
send({ type: "prompt_remove", id: "c999", promptId: q.items[0].id });
const qr = await next((m) => m.type === "prompt_removed");
check("prompt_remove empties the queue", qr.ok === true && qr.queue.length === 0);

// ── Todos ─────────────────────────────────────────────────────────────────
send({ type: "todos_set", id: "s1", items: [{ id: "t1", content: "fix bug", status: "in_progress" }, { id: "t2", content: "ship", status: "pending" }] });
await next((m) => m.type === "todos_updated" && m.id === "s1");
send({ type: "todos_get", id: "s1" });
const tg = await next((m) => m.type === "todos" && m.id === "s1");
check("todos_set/todos_get round-trip", tg.items.length === 2 && tg.items[0].status === "in_progress");
send({ type: "todos_status", id: "s1", todoId: "t2", status: "completed" });
await next((m) => m.type === "todos_updated" && m.id === "s1" && m.items?.[1]?.status === "completed");
check("todos_status broadcast reaches subscribers", true);

// ── Scheduler ─────────────────────────────────────────────────────────────
send({ type: "schedule_create", chatId: "c1", text: "say hi", kind: "interval", intervalMs: 6000 });
const sc = await next((m) => m.type === "schedule_created");
check("schedule_create returns job", Boolean(sc.job?.id) && sc.job.intervalMs === 6000);
send({ type: "schedule_list" });
const sl = await next((m) => m.type === "schedule_list");
check("schedule_list shows the job", sl.items.some((j) => j.id === sc.job.id));
send({ type: "schedule_pause", jobId: sc.job.id });
check("schedule_pause acks", (await next((m) => m.type === "schedule_paused")).ok === true);
send({ type: "schedule_cancel", jobId: sc.job.id });
check("schedule_cancel acks", (await next((m) => m.type === "schedule_cancelled")).ok === true);

// ── Doctor ────────────────────────────────────────────────────────────────
send({ type: "doctor" });
const dr = await next((m) => m.type === "doctor_report", 30000);
check("doctor report has checks", Array.isArray(dr.checks) && dr.checks.some((c) => c.name === "node"));
check("doctor report ok flag", typeof dr.ok === "boolean");

// ── Wake-on-LAN (bad mac must error, not crash) ───────────────────────────
send({ type: "wake", mac: "not-a-mac" });
const wr = await next((m) => m.type === "wake_result");
check("wake with bad mac errors cleanly", wr.ok === false && wr.errors.length > 0);

// ── Approval guard status ─────────────────────────────────────────────────
send({ type: "approval_waiting" });
const aw = await next((m) => m.type === "approval_waiting");
check("approval_waiting shape", Array.isArray(aw.items) && typeof aw.timeoutMs === "number");

// ── Usage stats ───────────────────────────────────────────────────────────
send({ type: "usage_list" });
const ul = await next((m) => m.type === "usage_list");
check("usage_list shape", Array.isArray(ul.items) && typeof ul.totals === "object");
send({ type: "usage_get", id: "c1" });
check("usage_get acks", (await next((m) => m.type === "usage")).id === "c1");

// ── Digest attach on a fake session ───────────────────────────────────────
send({ type: "digest_attach", id: "s424242" });
check("digest_attach rejects unknown session", (await next((m) => m.type === "error" && m.message?.includes("s424242"))) != null);

// ── MCP status ────────────────────────────────────────────────────────────
send({ type: "mcp_status" });
check("mcp_status acks", (await next((m) => m.type === "mcp_status")).running === false);

// ── Recheck-pass features (one-by-one repo recheck) ───────────────────────
// retach: plain-text scrollback of a real chat (fakeagent manifest is in tmp)
send({ type: "chatsession", harness: "fakechat", cwd: tmp, prompt: "recheck ping" });
const chatCreated = await next((m) => m.type === "created" && m.kind === "chat");
await next((m) => m.type === "chatstate" && m.id === chatCreated.id && m.state === "idle", 20000);
send({ type: "chat_text", id: chatCreated.id });
const ct = await next((m) => m.type === "chat_text" && m.id === chatCreated.id);
check("chat_text renders plain transcript", ct.text.includes("recheck ping"));
send({ type: "chat_text", id: "c-nosuch" });
check("chat_text errors on missing chat", (await next((m) => m.type === "error" && m.message?.includes("c-nosuch"))) != null);
// flue/1code: chat history search
send({ type: "chat_search", query: "test" });
const cs = await next((m) => m.type === "chat_search");
check("chat_search returns items array", Array.isArray(cs.items));
// agent-tmux-web: permission mode switch
send({ type: "chat_permission", id: chatCreated.id, mode: "autopilot" });
check("chat_permission acks", (await next((m) => m.type === "chat_permission_ok")).mode === "autopilot");
// c9watch/nexting: OS process scan
send({ type: "sessions_scan" });
const scan = await next((m) => m.type === "sessions_scan", 20000);
check("sessions_scan returns items", Array.isArray(scan.items));
// vmux/orca: worktree create/list against this repo
send({ type: "wt_create", repo: process.env.RH_TEST_REPO || process.cwd() + "/..", name: "recheck1" });
const wt = await next((m) => m.type === "worktree_created");
check("wt_create ok", wt.ok === true && wt.worktree?.path !== undefined, );
if (wt.ok) {
  send({ type: "wt_list", repo: process.env.RH_TEST_REPO || process.cwd() + "/.." });
  const wl = await next((m) => m.type === "worktree_list");
  check("wt_list shows worktree", wl.ok === true && wl.items.some((i) => i.path === wt.worktree.path));
  send({ type: "wt_remove", repo: process.env.RH_TEST_REPO || process.cwd() + "/..", path: wt.worktree.path, force: true });
  const wr = await next((m) => m.type === "worktree_removed");
  check("wt_remove ok", wr.ok === true);
}
// marchat/shooter: quiet hours
send({ type: "quiet_set", mode: "priority", windows: ["23:00-07:00"] });
const qs = await next((m) => m.type === "quiet_status");
check("quiet_set persists mode", qs.mode === "priority" && qs.windows.includes("23:00-07:00"));
send({ type: "quiet_set", mode: "off", windows: [] });
await next((m) => m.type === "quiet_status" && m.mode === "off");
// openchamber/netbird: device registry
// openchamber/netbird: device registry — fresh socket, hello carries clientId
const ws2 = new WebSocket(`ws://127.0.0.1:${PORT}/ws`);
await new Promise((resolve, reject) => { ws2.on("open", resolve); ws2.on("error", reject); });
ws2.send(JSON.stringify({ type: "hello", token: TOKEN, clientId: "test-device-1", name: "e2e", platform: "test" }));
const seen2 = [];
const next2 = (pred, timeoutMs = 15000) => new Promise((resolve, reject) => {
  for (const m of seen2) if (pred(m)) return resolve(m);
  const t = setTimeout(() => reject(new Error("timeout (ws2)")), timeoutMs);
  ws2.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    seen2.push(m);
    if (pred(m)) { clearTimeout(t); resolve(m); }
  });
});
const w2 = await next2((m) => m.type === "welcome");
check("welcome echoes clientId", w2.clientId === "test-device-1");
ws2.close();
send({ type: "device_list" });
const dl = await next((m) => m.type === "device_list");
check("device_list contains our device", dl.items.some((d) => d.id === "test-device-1"));
send({ type: "device_revoke", clientId: "test-device-1" });
check("device_revoke acks", (await next((m) => m.type === "device_revoked")).ok === true);
send({ type: "device_allow", clientId: "test-device-1" });
check("device_allow acks", (await next((m) => m.type === "device_allowed")).ok === true);
// frp: hot manifest reload
send({ type: "manifest_reload" });
check("manifest_reload acks", (await next((m) => m.type === "manifests_reloaded")).count > 0);
// agent-tmux-web: @mention expansion helper
send({ type: "mention", text: "see @package.json", cwd: process.cwd() });
const me = await next((m) => m.type === "mention_expanded");
check("mention expands existing file", me.ok === true && me.mentions.some((x) => x.ok));

// ── Wire-defect fixes (audit follow-up) ─────────────────────────────────
// 1. sessions request handler — reply lands before broadcast noise
send({ type: "sessions" });
const sessReply = await next((m) => m.type === "sessions" && Array.isArray(m.items));
check("sessions request handler replies", sessReply.items.some((s) => s.id === chatCreated.id));
// 2. waiting-transition broadcast — attention-first list reorders when an
// agent gets stuck. fakewait is a plain-text agent that prints a permission
// marker and stays alive, so the chat really enters "waiting".
send({ type: "chatsession", harness: "fakewait", cwd: tmp });
const wm = seen.length;
const waitChat = await next((m) => m.type === "created" && m.kind === "chat" && seen.indexOf(m) >= wm);
send({ type: "chatmsg", id: waitChat.id, text: "go" });
await next((m) => m.type === "sessions" && m.items?.some((s) => s.id === waitChat.id && s.state === "waiting"), 15000);
check("sessions broadcast on waiting transition", true);
send({ type: "chatcancel", id: waitChat.id });
send({ type: "chat_fork", id: chatCreated.id });
const fk = await next((m) => m.type === "chat_forked");
check("chat_fork clones chat", fk.ok === true && fk.chat.id !== chatCreated.id && fk.chat.forkedFrom?.id === chatCreated.id);
// 1code: chat_text of the fork carries the cloned transcript
send({ type: "chat_text", id: fk.chat.id });
const fkt = await next((m) => m.type === "chat_text" && m.id === fk.chat.id);
check("fork carries transcript", fkt.text.includes("recheck ping"));
// Fork env inheritance: an explicit fork env layers OVER the parent's
// attached profile (fix: it used to clobber the parent profile entirely).
send({ type: "env_profile_set", name: "forktest", vars: { RH_FORK_PROBE: "from-parent" } });
await next((m) => m.type === "env_profile_ok" && m.name === "forktest");
send({ type: "env_profile_attach", id: chatCreated.id, name: "forktest" });
const fam = seen.length;
await next((m) => m.type === "env_profile_ok" && m.profile === "forktest" && seen.indexOf(m) >= fam);
send({ type: "chat_fork", id: chatCreated.id, env: { RH_FORK_PROBE: "overridden" } });
const fk2 = await next((m) => m.type === "chat_forked" && seen.indexOf(m) >= fam);
check("chat_fork with env override clones", fk2.ok === true && fk2.chat.id !== chatCreated.id);
send({ type: "chatmsg", id: fk2.chat.id, text: "env-probe" });
await next((m) => m.type === "chatstate" && m.id === fk2.chat.id && m.state === "idle", 20000);
send({ type: "chat_text", id: fk2.chat.id });
const fkt2 = await next((m) => m.type === "chat_text" && m.id === fk2.chat.id);
check("fork inherits parent env profile (merge not clobber)", fkt2.text.includes("RH_FORK_PROBE=overridden"));
// 1code / vibe-companion: env profiles (BYOK)
send({ type: "env_profile_set", name: "test", vars: { RH_TEST_KEY: "abc" } });
check("env_profile_set acks", (await next((m) => m.type === "env_profile_ok")).ok === true);
send({ type: "env_profile_list" });
const el = await next((m) => m.type === "env_profiles");
check("env_profile_list shows profile", el.items.some((p) => p.name === "test" && p.keys.includes("RH_TEST_KEY")));
send({ type: "env_profile_attach", id: chatCreated.id, name: "test" });
const eaBefore = seen.length;
const ea = await next((m) => m.type === "env_profile_ok" && m.profile === "test" && seen.indexOf(m) >= eaBefore - 1);
check("env_profile_attach acks", ea.ok === true && ea.profile === "test");
send({ type: "env_profile_detach", id: chatCreated.id });
const edBefore = seen.length;
check("env_profile_detach acks", (await next((m) => m.type === "env_profile_ok" && m.id === chatCreated.id && m.profile === undefined && seen.indexOf(m) >= edBefore - 1)).ok === true);
send({ type: "env_profile_remove", name: "test" });
const erBefore = seen.length;
check("env_profile_remove acks", (await next((m) => m.type === "env_profile_ok" && m.name === "test" && m.id === undefined && seen.indexOf(m) >= erBefore - 1)).ok === true);
// 1code: plan mode — no checklist in transcript yet → null plan, approval toggles
send({ type: "plan_get", id: chatCreated.id });
const pg = await next((m) => m.type === "plan");
check("plan_get works without plan", pg.ok !== false && pg.plan === null);
send({ type: "plan_approve", id: chatCreated.id, approved: true });
const pa = await next((m) => m.type === "plan_ok");
check("plan_approve acks", pa.approved === true);

ws.close();
await teardown(tmp);
console.log(`\n${failureCount() ? "FAILURES: " + failureNames() : "ALL PASS"} (absorb)`);
process.exit(failureCount() ? 1 : 0);
