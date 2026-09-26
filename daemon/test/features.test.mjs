// Features absorption test: seq backfill, host stats, git panel, activity
// monitor, agent accounts, and per-chat CLI sessions.
import WebSocket from "ws";
import { check, connect, failureCount, failureNames, makeTmp, openAndHello, startDaemon, teardown } from "./helpers.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const REPO = path.dirname(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")); // git repo root for git_* surfaces
const tmp = makeTmp("rh-features-");

const PORT = 8795;
const TOKEN = "featuretoken";

const agentJs = path.join(tmp, "fakeagent.js");
fs.writeFileSync(agentJs, `
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const extra = process.argv.slice(2).join(" ");
  process.stdout.write(JSON.stringify({ type: "system", subtype: "init", session_id: "sess-1" }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "echo: " + input.trim() + (extra ? " [" + extra + "]" : "") }] } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "" }) + "\\n");
});
`);
const agentResumeJs = path.join(tmp, "fakeresume.js");
fs.writeFileSync(agentResumeJs, `
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  process.stdout.write(JSON.stringify({ type: "assistant", message: { content: [{ type: "text", text: "resumed: " + input.trim() }] } }) + "\\n");
  process.stdout.write(JSON.stringify({ type: "result", is_error: false, result: "" }) + "\\n");
});
`);
fs.writeFileSync(path.join(tmp, "fakechat.json"), JSON.stringify({
  id: "fakechat", name: "Fake Chat", adapter: "terminal", bin: "node", install: {},
  auth: { status: ["-e", "console.log('Logged in as test')"], login: ["-e", "console.log('visit example.com/device')"] },
  chat: { args: [agentJs], format: "claude-stream-json", resumeArgs: [agentResumeJs], resumeIdArgs: [agentJs, "--resume-id", "{id}"] },
}));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  // ── Phase 1: daemon #1 — protocol features ────────────────────────────────
  const d1 = startDaemon(PORT, 46791, { token: TOKEN, manifests: tmp, env: { RH_QUIET_MS: "3000" } });
  await d1.ready;
  const c = await openAndHello(PORT, TOKEN);

  // Origin check: cross-origin browser upgrade is rejected with 4004.
  await new Promise((res) => {
    let done = false;
    const finish = (ok) => { if (!done) { done = true; check("cross-origin upgrade rejected (4004)", ok); res(); } };
    const bad = new WebSocket(`ws://localhost:${PORT}/ws`, { origin: "http://evil.example" });
    bad.on("close", () => finish(true)); // refused at HTTP upgrade → error/close, never open
    bad.on("open", () => { bad.close(); finish(false); });
    bad.on("error", () => finish(true));
  });

  // Terminal session + seq numbers on out events
  c.send({ type: "create", harness: "node", args: ["-e", "console.log('feat-ok'); let n=0; setInterval(()=>console.log('tick'+(++n)),500)"] });
  const created = await c.next((m) => m.type === "created");
  check("terminal session created", created.harnessId === "node");
  c.send({ type: "attach", id: created.id });
  await c.next((m) => m.type === "replay" && m.id === created.id);
  const firstOut = await c.next((m) => m.type === "out" && m.id === created.id);
  check("out carries monotonic seq", typeof firstOut.seq === "number" && firstOut.seq >= 1);

  // Missed-output backfill: reconnect with since → only newer chunks, incremental replay
  const sinceSeq = firstOut.seq;
  await c.next((m) => m.type === "out" && Buffer.from(m.data, "base64").toString().includes("feat-ok"));
  await c.close();
  const c2 = connect(PORT);
  await new Promise((res) => c2.ws.on("open", res));
  c2.send({ type: "hello", token: TOKEN });
  await c2.next((m) => m.type === "welcome");
  c2.send({ type: "attach", id: created.id, since: sinceSeq });
  const backfillOut = await c2.next((m) => m.type === "out" && m.id === created.id);
  check("backfill sends only chunks after since", backfillOut.seq > sinceSeq);
  const incrReplay = await c2.next((m) => m.type === "replay" && m.id === created.id);
  check("backfill replay is incremental", incrReplay.incremental === true && incrReplay.data === "");

  // Host stats
  c2.send({ type: "stats" });
  const stats = await c2.next((m) => m.type === "stats");
  check("stats shape", stats.memTotalMb > 0 && stats.cpuCount > 0 && typeof stats.hostname === "string");

  // Git panel against this repo
  c2.send({ type: "git_status", cwd: REPO });
  const git = await c2.next((m) => m.type === "git_status");
  check("git_status returns branch", git.ok === true && typeof git.branch === "string" && git.branch.length > 0);
  c2.send({ type: "git_log", cwd: REPO, limit: 3 });
  const log = await c2.next((m) => m.type === "git_log");
  check("git_log returns commits", log.ok === true && log.commits.length >= 1 && log.commits[0].hash.length >= 7);

  // Activity monitor: working → quiet broadcast (second session prints once, stays alive, silent)
  c2.send({ type: "create", harness: "node", args: ["-e", "console.log('silent-alive'); setTimeout(()=>{}, 60000)"] });
  const sq = await c2.next((m) => m.type === "created" && m.harnessId === "node" && m.id !== created.id);
  c2.send({ type: "attach", id: sq.id });
  // Output may land in the attach replay (printed before attach) or in an out
  // event (printed after) — accept either.
  await Promise.race([
    c2.next((m) => m.type === "replay" && m.id === sq.id && m.data && Buffer.from(m.data, "base64").toString().includes("silent-alive")),
    c2.next((m) => m.type === "out" && m.id === sq.id && Buffer.from(m.data, "base64").toString().includes("silent-alive")),
  ]);
  const quietEvt = c2.next((m) => m.type === "activity" && m.id === sq.id && m.state === "quiet", 20000);
  await quietEvt;
  check("activity busy→quiet broadcast", true);
  c2.send({ type: "activity_list" });
  const actList = await c2.next((m) => m.type === "activity_list");
  check("activity_list tracks both sessions", actList.items.some((a) => a.id === sq.id && a.state === "quiet"));

  // Agent accounts: status is headless; login opens a terminal; an agent without a command says so.
  c2.send({ type: "auth_status", harness: "fakechat" });
  const st = await c2.next((m) => m.type === "auth_status");
  check("auth_status reports logged in", st.loggedIn === true && st.text.includes("Logged in as test"));
  c2.send({ type: "auth_login", harness: "fakechat", cwd: tmp });
  const login = await c2.next((m) => m.type === "created");
  check("auth_login opens a terminal session", login.kind !== "chat" && Boolean(login.id));
  c2.send({ type: "auth_logout", harness: "fakechat" });
  const noLogout = await c2.next((m) => m.type === "error" && m.message.includes("logout"));
  check("agent without a logout command is told to use its terminal", noLogout.message.includes("use its terminal"));

  // ── Chat session: per-chat CLI session, daemon slash commands ─────────────
  c2.send({ type: "chatsession", harness: "fakechat", cwd: tmp, prompt: "hello-resurrect" });
  const chatCreated = await c2.next((m) => m.type === "created" && m.kind === "chat");
  const chatDone = await c2.next((m) => m.type === "chatstate" && m.id === chatCreated.id && m.state === "idle");
  check("chat turn completed", chatDone.state === "idle");
  // --continue would pick the newest conversation in cwd, which may belong to another client.
  c2.send({ type: "chatmsg", id: chatCreated.id, text: "second-turn" });
  const turn2 = await c2.next((m) => m.type === "chatdelta" && m.id === chatCreated.id && m.text.includes("second-turn"));
  check("second turn resumes the chat's own CLI session", /\[--resume-id sess-1[ \]]/.test(turn2.text));
  await c2.next((m) => m.type === "chatstate" && m.id === chatCreated.id && m.state === "idle");
  c2.send({ type: "chatmsg", id: chatCreated.id, text: "/status" });
  const status = await c2.next((m) => m.type === "chatdelta" && m.id === chatCreated.id && m.text.includes("Sessions:"));
  check("daemon slash command answered by the daemon", status.text.includes("idle"));
  c2.send({ type: "chatmsg", id: chatCreated.id, text: "/my-skill do it" });
  const skill = await c2.next((m) => m.type === "chatdelta" && m.id === chatCreated.id && m.text.includes("my-skill"));
  check("unknown slash command reaches the agent as a skill", skill.text.includes("echo: /my-skill do it"));
  await c2.next((m) => m.type === "chatstate" && m.id === chatCreated.id && m.state === "idle");

  await c2.close();
  await c.close();
  d1.kill("SIGTERM");
  // cleanup test data dir in home
  try { fs.rmSync(path.join(os.homedir(), ".pocketdesk-test"), { recursive: true, force: true }); } catch {}
  await teardown(tmp);

  console.log(failureCount() ? `\n${failureCount()} FAILURE(S): ${failureNames()}` : "\nALL PASS");
  process.exit(failureCount() ? 1 : 0);
}

main().catch((e) => {
  console.error("TEST CRASH:", e);
  process.exit(1);
});
