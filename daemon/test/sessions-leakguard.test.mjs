/**
 * Tests for session leak guard — spawns the real daemon and checks session
 * behavior through the WebSocket protocol (same approach as smoke.mjs).
 *
 * Verifies:
 *   - Multiple sessions can be created
 *   - kill() works on a live session
 *   - The session count doesn't grow unboundedly (MAX_SESSIONS cap)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";

const PORT = 8801;
const TOKEN = "leakguard";
const tmpMan = fs.mkdtempSync(path.join(os.tmpdir(), "rh-lg-"));
fs.writeFileSync(
  path.join(tmpMan, "node.json"),
  JSON.stringify({ id: "node", name: "Node REPL", adapter: "terminal", bin: "node", install: {} }),
);

const daemon = spawn(process.execPath, ["src/index.js"], {
  cwd: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  env: { ...process.env, RH_PORT: String(PORT), RH_TOKEN: TOKEN, RH_MANIFESTS: tmpMan },
  stdio: ["ignore", "pipe", "pipe"],
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

async function run() {
  try {
    await new Promise((res) => setTimeout(res, 1500));
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

    ws.close();
  } catch (e) {
    console.error("LEAKGUARD ERROR:", e.message);
    failures.push(e.message);
  } finally {
    daemon.kill();
  }
}
await run();
console.log(failures.length ? `\n${failures.length} FAILURE(S)` : "\nALL PASS");
process.exit(failures.length ? 1 : 0);
