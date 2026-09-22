// Shared test harness — one daemon spawner + one WS client used by every
// end-to-end test file. Extracted from 15 copy-pasted copies.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";

export const REPO = path.dirname(new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")); // PocketDesk root (git repo)

const failures = [];

export function check(name, cond) {
  console.log(`${cond ? "PASS" : "FAIL"}  ${name}`);
  if (!cond) failures.push(name);
}

export function failureCount() {
  return failures.length;
}

export function failureNames() {
  return failures.join("; ");
}

/**
 * Create a tmp dir pre-seeded with a "node" terminal-harness manifest, as
 * every e2e test needs. Caller must rmSync it when done.
 */
export function makeTmp(prefix) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.writeFileSync(path.join(tmp, "node.json"), JSON.stringify({ id: "node", name: "Node REPL", adapter: "terminal", bin: "node", install: {} }));
  return tmp;
}

/** Registry of spawned daemons so a crashed test never leaks children. */
const children = [];
for (const sig of ["exit", "SIGINT", "SIGTERM"]) {
  process.on(sig, () => { for (const c of children) { try { c.kill("SIGKILL"); } catch {} } });
}

/**
 * Spawn a daemon on the given ports. `opts.env` overrides defaults.
 * Returns the child with a `.ready` promise (resolves on "registry scanned").
 */
export function startDaemon(port, cliPort, opts = {}) {
  const env = {
    ...process.env,
    RH_PORT: String(port),
    RH_TOKEN: opts.token || process.env.RH_TEST_TOKEN || "testtoken",
    RH_MANIFESTS: opts.manifests,
    RH_CLI_PORT: String(cliPort),
    POCKETDESK_DATA: opts.dataDir || ".pocketdesk-test",
    // Keep generated state (config, TLS, SSH host/user keys) out of the real profile.
    RH_HOME: opts.home || path.join(os.tmpdir(), "rh-home-" + port),
    ...(opts.env || {}),
  };
  const d = spawn(process.execPath, ["src/index.js"], {
    cwd: REPO + "/daemon",
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  d.stderr.on("data", (x) => process.stderr.write("[daemon!] " + x));
  d.ready = new Promise((resolve, reject) => {
    d.stdout.on("data", (x) => {
      process.stdout.write("[daemon] " + x);
      if (String(x).includes("registry scanned")) resolve();
    });
    d.on("exit", (code) => reject(new Error(`daemon exited early (code ${code})`)));
  });
  children.push(d);
  return d;
}

/**
 * Kill all spawned daemons gracefully (SIGTERM lets the daemon's exit handler
 * reap pty children — a SIGKILL leaves them holding tmp dirs on Windows),
 * wait for reaping, and remove a tmp dir best-effort.
 */
export async function teardown(tmp) {
  for (const c of children) { try { c.kill("SIGTERM"); } catch {} }
  await new Promise((r) => setTimeout(r, 1200));
  if (tmp) { try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {} }
}

/**
 * Authenticated WS client. `next(pred)` resolves the first matching message
 * received *after* the last send (stale log entries can't satisfy waiters);
 * falls back to a latest-first scan of the post-`since` log.
 */
export function connect(port, token = "testtoken") {
  return connectRaw(`ws://localhost:${port}/ws`, token);
}

/** Same client shape for arbitrary URLs (QR relay port, peer links). */
export function connectRaw(url, token) {
  const ws = new WebSocket(url);
  const waiters = [];
  const log = [];
  let since = 0;
  ws.on("message", (raw) => {
    let m;
    try { m = JSON.parse(raw.toString()); } catch { m = { raw: raw.toString() }; }
    log.push(m);
    const i = waiters.findIndex((w) => w.pred(m));
    if (i >= 0) {
      const [w] = waiters.splice(i, 1);
      clearTimeout(w.timer);
      w.resolve(m);
    }
  });
  return {
    ws,
    send: (o) => { since = log.length; ws.send(JSON.stringify(o)); },
    sendRaw: (t) => { since = log.length; ws.send(t); },
    next: (pred, timeoutMs = 15000) => {
      for (let i = log.length - 1; i >= since; i--) {
        if (pred(log[i])) return Promise.resolve(log[i]);
      }
      return new Promise((resolve, reject) => {
        const t = setTimeout(() => reject(new Error("timeout waiting for: " + String(pred).slice(0, 120))), timeoutMs);
        waiters.push({ pred, resolve, timer: t });
      });
    },
    close: () => new Promise((res) => { ws.close(); setTimeout(res, 100); }),
  };
}

/** Open a socket and complete the hello/welcome handshake. */
export async function openAndHello(port, token = "testtoken") {
  const c = connect(port, token);
  await new Promise((res, rej) => { c.ws.on("open", res); c.ws.on("error", rej); });
  c.send({ type: "hello", token });
  await c.next((m) => m.type === "welcome");
  return c;
}

/** Exit with the conventional ALL PASS / FAILED summary. */
export function finish() {
  if (failures.length) {
    console.error(`FAILED: ${failures.length} — ${failures.join("; ")}`);
    process.exit(1);
  }
  console.log("ALL PASS");
}
