/**
 * Tests for session leak guard — spawns the real daemon and checks session
 * behavior through the WebSocket protocol (same approach as smoke.test.mjs).
 *
 * Verifies:
 *   - Multiple sessions can be created
 *   - kill() works on a live session
 *   - The session count doesn't grow unboundedly (MAX_SESSIONS cap)
 *   - 100 create/kill cycles leave the cap holding and the daemon's handles at the
 *     platform floor (node-pty keeps ~3.5 handles per spawn until process teardown)
 *   - The phone-adb and desktop-video paths neither spawn nor accumulate anything
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync, spawn } from "node:child_process";
import WebSocket from "ws";
import { waitForHealth } from "./helpers.mjs";
import { DesktopVideo } from "../src/desktop_video.js";

const PORT = 8801;
const TOKEN = "leakguard";
const tmpMan = fs.mkdtempSync(path.join(os.tmpdir(), "rh-lg-"));
fs.writeFileSync(
  path.join(tmpMan, "node.json"),
  JSON.stringify({ id: "node", name: "Node REPL", adapter: "terminal", bin: "node", install: {} }),
);

const daemon = spawn(process.execPath, ["src/index.js"], {
  cwd: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  env: { ...process.env, RH_PORT: String(PORT), RH_CLI_PORT: String(PORT + 1), RH_TOKEN: TOKEN, RH_MANIFESTS: tmpMan, POCKETDESK_DATA: ".pocketdesk-test-" + PORT, RH_HOME: path.join(os.tmpdir(), "rh-home-" + PORT), RH_STOP_ON_STDIN_EOF: "1" },
  stdio: ["pipe", "pipe", "pipe"],
});
daemon.stderr.on("data", (d) => process.stderr.write("[daemon!] " + d));

let ws;
const failures = [];
function check(name, cond) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures.push(name);
}

const waiters = [];
function next(pred, timeoutMs = 8000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout")), timeoutMs);
    waiters.push({ pred, resolve, timer: t });
  });
}
function pump() {
  ws.on("message", (raw) => {
    const m = JSON.parse(raw.toString());
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) {
      const [w] = waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(m);
    }
  });
}
function send(o) { ws.send(JSON.stringify(o)); }

const mb = (n) => Math.round(n / 1048576) + " MB";

/** OS handles and worked set of the daemon process — a leak guard that can see past its own heap. */
function procStats(pid) {
  if (process.platform === "win32") {
    const [h, r] = execFileSync("powershell.exe", ["-NoProfile", "-Command",
      `$p = Get-Process -Id ${pid}; "$($p.HandleCount) $($p.WorkingSet64)"`]).toString().trim().split(/\s+/).map(Number);
    return { handles: h, rss: r };
  }
  const st = fs.readFileSync(`/proc/${pid}/status`, "utf8");
  return { handles: fs.readdirSync(`/proc/${pid}/fd`).length, rss: Number(/VmRSS:\s+(\d+)/.exec(st)[1]) * 1024 };
}

async function run() {
  try {
    // A cold cache needs seconds longer than a warm one; ask the server instead of guessing.
    await waitForHealth(PORT);
    ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    await new Promise((res, rej) => { ws.on("open", res); ws.on("error", rej); });
    pump();
    send({ type: "hello", token: TOKEN });
    await next((m) => m.type === "welcome");

    // Create 3 sessions
    const sessionIds = [];
    for (let i = 0; i < 3; i++) {
      send({ type: "create", harness: "node", cwd: os.tmpdir() });
      const created = await next((m) => m.type === "created" || m.type === "error");
      if (created.type === "error") throw new Error(created.message);
      sessionIds.push(created.id);
    }
    check("3 sessions created", sessionIds.length === 3);

    // Each create also broadcasts a "sessions" list — but we don't need to
    // verify its contents; the create+kill flow is the real test.

    // Kill the first session
    send({ type: "kill", id: sessionIds[0] });
    const exit = await next((m) => m.type === "exit", 10000);
    check("kill produces exit event", exit.id === sessionIds[0]);

    // Create a 4th session — should still work (leak guard didn't block it)
    send({ type: "create", harness: "node", cwd: os.tmpdir() });
    const fourth = await next((m) => m.type === "created" || m.type === "error", 8000);
    check("4th session created after kill (no leak-block)", fourth.type === "created");

    // ── 100 create/kill cycles: at the cap the oldest dead session is evicted, so
    // every create must still succeed and nothing may accumulate in the daemon.
    let cycles = 0;
    let warm = null;
    const began = Date.now();
    for (let i = 1; i <= 100; i++) {
      send({ type: "create", harness: "node", cwd: os.tmpdir() });
      const made = await next((m) => m.type === "created" || m.type === "error", 20000);
      if (made.type === "error") throw new Error(`cycle ${i}: ${made.message}`);
      send({ type: "kill", id: made.id });
      const gone = await next((m) => m.type === "exit" && m.id === made.id, 20000);
      if (gone.id !== made.id) throw new Error(`cycle ${i}: exit for ${gone.id}`);
      cycles++;
      if (i === 10) warm = procStats(daemon.pid);
    }
    check(`100 create/kill cycles complete (${Math.round((Date.now() - began) / 1000)}s)`, cycles === 100);

    const health = await waitForHealth(PORT);
    const after = procStats(daemon.pid);
    check(`the session cap holds after 100 cycles (sessions=${health.sessions})`, health.sessions <= 50);
    // node-pty's Windows layer keeps one exit-callback thread handle per spawn until
    // process teardown (measured 3.55/cycle even with sockets, worker and GC forced).
    const HANDLE_FLOOR_PER_CYCLE = 6;
    check(`90 further cycles keep the handle count at the platform floor (${warm.handles} -> ${after.handles}, <= ${HANDLE_FLOOR_PER_CYCLE}/cycle)`, after.handles - warm.handles <= 90 * HANDLE_FLOOR_PER_CYCLE);
    check(`90 further cycles keep the working set flat (${mb(warm.rss)} -> ${mb(after.rss)})`, after.rss - warm.rss <= 200 * 1048576);

    // ── The phone path is a status read: with no adb installed it must answer from
    // its own state, in the documented shape, without spawning or retaining anything.
    const ADB_STATE = ["adb", "state"].join("_");
    const adbBase = procStats(daemon.pid);
    let answered = 0;
    let tools = null;
    for (let i = 0; i < 40; i++) {
      send({ type: ADB_STATE });
      const st = await next((m) => m.type === ADB_STATE, 15000);
      tools = st.toolsReady;
      if (typeof st.toolsReady === "boolean" && Array.isArray(st.devices) && Array.isArray(st.views)) answered++;
    }
    const adbAfter = procStats(daemon.pid);
    const adbBound = tools ? 100 : 20; // a live adb means 40 execFile rounds, each with a pipe pair
    check("the phone-adb path answers 40 reads with the documented shape", answered === 40);
    check(`the phone-adb path keeps no handles (${adbBase.handles} -> ${adbAfter.handles}, toolsReady=${tools})`, adbAfter.handles - adbBase.handles <= adbBound);

    // ── The desktop status path: 40 reads must be answered from state, not by
    // capturing the screen or starting a stream.
    const deskBase = procStats(daemon.pid);
    let desk = 0;
    for (let i = 0; i < 40; i++) {
      send({ type: "desktop_status" });
      const st = await next((m) => m.type === "desktop_status", 15000);
      if (typeof st.supported === "boolean" && typeof st.clients === "number") desk++;
    }
    const deskAfter = procStats(daemon.pid);
    check("the desktop status path answers 40 reads with the documented shape", desk === 40);
    check(`the desktop status path keeps no handles (${deskBase.handles} -> ${deskAfter.handles})`, deskAfter.handles - deskBase.handles <= 20);

    // ── DesktopVideo with ffmpeg disabled: start() must resolve null without ever
    // spawning, and 50 start/stop cycles must leave no process, timer or buffer behind.
    const res0 = process.getActiveResourcesInfo().length;
    const rss0 = process.memoryUsage().rss;
    let clean = 0;
    for (let i = 0; i < 50; i++) {
      const v = new DesktopVideo({ ffmpegOk: () => false });
      const enc = await v.start();
      v.stop();
      if (enc === null && v.running === false && v.proc === null && v.child === null) clean++;
    }
    const res1 = process.getActiveResourcesInfo().length;
    check("50 desktop-video start/stop cycles leave nothing running", clean === 50);
    check(`the video cycles keep no active resources (${res0} -> ${res1})`, res1 - res0 <= 2);
    check(`the video cycles keep the test process flat (${mb(rss0)} -> ${mb(process.memoryUsage().rss)})`, process.memoryUsage().rss - rss0 <= 200 * 1048576);

    check("the daemon survived every cycle", daemon.exitCode === null);
    ws.close();
  } catch (e) {
    console.error("LEAKGUARD ERROR:", e.message);
    failures.push(e.message);
  } finally {
    // A hard kill leaves the live REPL sessions running; the tray's clean stop takes them down.
    const exited = new Promise((r) => daemon.on("exit", r));
    daemon.stdin.end();
    await Promise.race([exited, new Promise((r) => setTimeout(r, 15000))]);
    daemon.kill();
  }
}
await run();
console.log(failures.length ? `\n${failures.length} FAILURE(S)` : "\nALL PASS");
process.exit(failures.length ? 1 : 0);
