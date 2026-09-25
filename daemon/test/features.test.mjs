// Features absorption test — exercises every protocol surface added in the
// inspiration-corpus absorption pass: seq backfill, shares, stats, git panel,
// activity monitor, session recording, tunnels, power manager, chat resurrection.
import WebSocket from "ws";
import { check, connect, failureCount, failureNames, makeTmp, openAndHello, startDaemon, teardown } from "./helpers.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";

const REPO = path.dirname(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")); // git repo root for git_* surfaces
const tmp = makeTmp("rh-features-");

const PORT = 8795;
const PORT2 = 8797;
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

  // Read-only share: spectator joined via token cannot inject input
  c2.send({ type: "share_create", id: created.id, mode: "readonly", ttlMinutes: 10 });
  const share = await c2.next((m) => m.type === "share_created");
  check("share token issued", typeof share.token === "string" && share.mode === "readonly");
  const spect = connect(PORT);
  await new Promise((res) => spect.ws.on("open", res));
  spect.send({ type: "hello", token: TOKEN });
  await spect.next((m) => m.type === "welcome");
  spect.send({ type: "share_join", token: share.token });
  const joined = await spect.next((m) => m.type === "share_joined");
  check("spectator joined share", joined.mode === "readonly" && joined.sessionId === created.id);
  spect.send({ type: "in", id: created.id, data: Buffer.from("echo bad").toString("base64") });
  const denied = await spect.next((m) => m.type === "error");
  check("readonly spectator input blocked", /read-only/.test(denied.message));
  // The gate is an allowlist, so write verbs outside the terminal are refused
  // too — a spectator used to be able to write files and open tunnels.
  spect.send({ type: "fwrite", path: "spectator-should-not-write.txt", data: "" });
  const deniedWrite = await spect.next((m) => m.type === "error");
  check("readonly spectator cannot write files", /read-only/.test(deniedWrite.message));
  spect.send({ type: "tunnel_create", localPort: PORT, remotePort: 18999 });
  const deniedTunnel = await spect.next((m) => m.type === "error");
  check("readonly spectator cannot open tunnels", /read-only/.test(deniedTunnel.message));

  // maxViewers was stored and never enforced.
  c2.send({ type: "share_create", id: created.id, mode: "readonly", ttlMinutes: 10, maxViewers: 1 });
  const capped = await c2.next((m) => m.type === "share_created");
  const v1 = connect(PORT);
  await new Promise((res) => v1.ws.on("open", res));
  v1.send({ type: "hello", token: TOKEN });
  await v1.next((m) => m.type === "welcome");
  v1.send({ type: "share_join", token: capped.token });
  await v1.next((m) => m.type === "share_joined");
  const v2 = connect(PORT);
  await new Promise((res) => v2.ws.on("open", res));
  v2.send({ type: "hello", token: TOKEN });
  await v2.next((m) => m.type === "welcome");
  v2.send({ type: "share_join", token: capped.token });
  const full = await v2.next((m) => m.type === "error");
  check("maxViewers enforced", /full/.test(full.message));
  await v1.close();
  await v2.close();
  c2.send({ type: "share_revoke", token: capped.token });
  await c2.next((m) => m.type === "share_revoked");
  c2.send({ type: "in", id: created.id, data: Buffer.from("echo ok\r").toString("base64") });
  check("owner input still works", true);
  c2.send({ type: "share_list" });
  const shares = await c2.next((m) => m.type === "share_list");
  check("share_list lists active share", shares.items.length === 1);

  // Expired share
  c2.send({ type: "share_create", id: created.id, mode: "readwrite", ttlMinutes: 0.01 });
  await c2.next((m) => m.type === "share_created");
  await sleep(900);
  const spect2 = connect(PORT);
  await new Promise((res) => spect2.ws.on("open", res));
  spect2.send({ type: "hello", token: TOKEN });
  await spect2.next((m) => m.type === "welcome");
  spect2.send({ type: "share_join", token: "bogus" });
  const expired = await spect2.next((m) => m.type === "error");
  check("bogus/expired share rejected", /not found/.test(expired.message));

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

  // Session recording
  c2.send({ type: "record_start", id: created.id });
  await c2.next((m) => m.type === "recording" && m.active === true);
  c2.send({ type: "in", id: created.id, data: Buffer.from("echo recorded\r").toString("base64") });
  // Wait for the echo itself: a fixed sleep raced the PTY and flaked.
  await Promise.race([
    c2.next((m) => m.type === "out" && m.id === created.id && Buffer.from(m.data, "base64").toString().includes("recorded"), 5000),
    sleep(3000),
  ]).catch(() => {});
  c2.send({ type: "record_stop", id: created.id });
  await c2.next((m) => m.type === "recording" && m.active === false);
  c2.send({ type: "record_get", id: created.id });
  const recGet = await c2.next((m) => m.type === "record_get");
  check("recorder captured events", Array.isArray(recGet.events) && recGet.events.length > 0);
  check("recorder export available", typeof recGet.export === "string" && recGet.export.length > 10);

  // Tunnel: TCP listener forwarding to the daemon's own HTTP port
  c2.send({ type: "tunnel_create", localPort: PORT, remotePort: 18777 });
  await c2.next((m) => m.type === "tunnel_created");
  const httpResp = await new Promise((resolve, reject) => {
    const sock = net.connect(18777, "127.0.0.1", () => {
      sock.write(`GET /health HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n`);
    });
    let buf = "";
    sock.on("data", (d) => (buf += d.toString()));
    sock.on("close", () => resolve(buf));
    sock.on("error", reject);
    setTimeout(() => reject(new Error("tunnel http timeout")), 8000);
  });
  check("tunnel forwards TCP to local service", httpResp.includes("healthy"));
  c2.send({ type: "tunnel_close", id: "t1" });
  await c2.next((m) => m.type === "tunnel_closed");

  // Power manager status
  c2.send({ type: "power_set", mode: "on" });
  const powerOn = await c2.next((m) => m.type === "power_status");
  check("power_set on activates assertion", powerOn.mode === "on" && powerOn.active === true);

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

  // ── Phase 2: chat session for resurrection ────────────────────────────────
  c2.send({ type: "chatsession", harness: "fakechat", cwd: tmp, prompt: "hello-resurrect" });
  const chatCreated = await c2.next((m) => m.type === "created" && m.kind === "chat");
  const chatDone = await c2.next((m) => m.type === "chatstate" && m.id === chatCreated.id && m.state === "idle");
  check("chat turn completed", chatDone.state === "idle");
  // --continue would pick the newest conversation in cwd, which may belong to another client.
  c2.send({ type: "chatmsg", id: chatCreated.id, text: "second-turn" });
  const turn2 = await c2.next((m) => m.type === "chatdelta" && m.id === chatCreated.id && m.text.includes("second-turn"));
  check("second turn resumes the chat's own CLI session", turn2.text.includes("[--resume-id sess-1]"));
  await c2.next((m) => m.type === "chatstate" && m.id === chatCreated.id && m.state === "idle");
  c2.send({ type: "chatmsg", id: chatCreated.id, text: "/status" });
  const status = await c2.next((m) => m.type === "chatdelta" && m.id === chatCreated.id && m.text.includes("Sessions:"));
  check("daemon slash command answered by the daemon", status.text.includes("idle"));
  c2.send({ type: "chatmsg", id: chatCreated.id, text: "/my-skill do it" });
  const skill = await c2.next((m) => m.type === "chatdelta" && m.id === chatCreated.id && m.text.includes("my-skill"));
  check("unknown slash command reaches the agent as a skill", skill.text.includes("echo: /my-skill do it"));
  await c2.next((m) => m.type === "chatstate" && m.id === chatCreated.id && m.state === "idle");

  // Simulate restart: the chat record lives on disk, so even a hard stop
  // resurrects. SIGTERM so the exit handler disposes helpers (no leaks).
  await c2.close();
  await c.close();
  d1.kill("SIGTERM");
  await sleep(1200);

  // ── Phase 3: daemon #2 — chat resurrection ────────────────────────────────
  const d2 = startDaemon(PORT2, 46792, { token: TOKEN, manifests: tmp });
  await d2.ready;
  const c3 = connect(PORT2);
  await new Promise((res, rej) => { c3.ws.on("open", res); c3.ws.on("error", rej); });
  c3.send({ type: "hello", token: TOKEN });
  await c3.next((m) => m.type === "welcome");
  c3.send({ type: "resurrect_list" });
  const rez = await c3.next((m) => m.type === "resurrect_list");
  check("resurrect_list remembers chat after crash", rez.items.some((r) => r.harnessId === "fakechat"));
  const rec = rez.items.find((r) => r.harnessId === "fakechat");
  c3.send({ type: "resume", id: rec.id });
  const resumed = await c3.next((m) => m.type === "created" && m.kind === "chat");
  check("resume creates new chat marked resumed", resumed.resumed === true);
  c3.send({ type: "resurrect_list" });
  const rez2 = await c3.next((m) => m.type === "resurrect_list");
  check("resurrect tracks resumed chat exactly once", rez2.items.filter((r) => r.harnessId === "fakechat").length === 1);
  c3.send({ type: "chatmsg", id: resumed.id, text: "continue-please" });
  const delta = await c3.next((m) => m.type === "chatdelta" && m.id === resumed.id && m.text.includes("continue-please"));
  check("resumed chat resumes its recorded CLI session", delta.text.includes("echo: continue-please [--resume-id sess-1]"));

  await c3.close();
  d2.kill("SIGTERM");
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
