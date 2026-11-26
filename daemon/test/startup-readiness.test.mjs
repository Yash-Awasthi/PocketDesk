// Every test that starts a daemon must wait for the server to answer, not for a number of
// milliseconds. Measured 2026-11-24: the daemon needs 5-7 s from a cold cache here against
// fixed waits of 1.2-3 s, which is why `absorb`, `graceful-shutdown`, `sessions-leakguard`,
// `smoke` and `smoke-chat` were red on a cold machine and green on a warm one.
//
// Two checks: no test file may sleep a second or more before its first connection, and every
// file that spawns the daemon must have a readiness signal (`waitForHealth` or `.ready`).
// The third check runs `waitForHealth` itself both ways so the helper cannot rot silently.
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import {
  REPO,
  check,
  finish,
  makeTmp,
  startDaemon,
  teardown,
  waitForHealth,
  waitForUrl,
} from "./helpers.mjs";

const dir = path.join(REPO, "daemon", "test");
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".test.mjs") && f !== "startup-readiness.test.mjs");

const SPAWNS = /spawn\(process\.execPath, \["src\/index\.js"\]|startDaemon\(/;
const CONNECTS = ["new WebSocket(", "openAndHello(", "connectRaw(", "connect("];

/** A fixed delay of a second or more, e.g. `await new Promise((r) => setTimeout(r, 1500))`. */
const SLEEP = /new Promise\(\(\s*(\w+)\s*\) => setTimeout\(\1, (\d+)\)\)/g;

const spawners = files.filter((f) => SPAWNS.test(fs.readFileSync(path.join(dir, f), "utf8")));
check(`there are daemon-spawning test files to check (${spawners.length})`, spawners.length > 20);

const offenders = [];
for (const f of spawners) {
  const text = fs.readFileSync(path.join(dir, f), "utf8");
  const firstConnect = Math.min(
    ...CONNECTS.map((s) => {
      const i = text.indexOf(s);
      return i < 0 ? Infinity : i;
    }),
  );
  const head = Number.isFinite(firstConnect) ? text.slice(0, firstConnect) : text;
  const long = [...head.matchAll(SLEEP)].map((m) => Number(m[2])).filter((n) => n >= 1000);
  if (long.length) offenders.push(`${f} (${long.join(", ")} ms)`);
}
check(
  `no file sleeps a second or more before connecting${offenders.length ? ": " + offenders.join("; ") : ""}`,
  offenders.length === 0,
);

const noSignal = spawners.filter((f) => {
  const text = fs.readFileSync(path.join(dir, f), "utf8");
  // A real wait, not just an import: an unused helper import must not satisfy this.
  return !/await waitFor(Health|Url)\(|\.ready\b/.test(text);
});
check(
  `every spawner waits on a readiness signal${noSignal.length ? ": " + noSignal.join("; ") : ""}`,
  noSignal.length === 0,
);

// Daemons started side by side must not share the CLI port. Two of them on the default 4679
// makes one log "cli unavailable" and the loss lands as an unrelated flake elsewhere (measured
// 2026-11-24: `approvals` timed out on a proposal while that was in the log).
const sharedCli = spawners.filter((f) => {
  const text = fs.readFileSync(path.join(dir, f), "utf8");
  // startDaemon() always passes RH_CLI_PORT itself.
  if (!text.includes('spawn(process.execPath, ["src/index.js"]')) return false;
  return !text.includes("RH_CLI_PORT");
});
check(
  `every raw spawn sets its own CLI port${sharedCli.length ? ": " + sharedCli.join("; ") : ""}`,
  sharedCli.length === 0,
);

// Two test files on the same port would collide only when both run at once, i.e. in CI.
const ports = new Map();
for (const f of spawners) {
  for (const m of fs.readFileSync(path.join(dir, f), "utf8").matchAll(/^const (?:PORT|CLI) = (\d+);/gm)) {
    const list = ports.get(m[1]) || [];
    list.push(f);
    ports.set(m[1], list);
  }
}
const collisions = [...ports].filter(([, files]) => files.length > 1);
check(
  `no two test files declare the same port${collisions.length ? ": " + collisions.map(([p, files]) => `${p} (${files.join(", ")})`).join("; ") : ""}`,
  collisions.length === 0,
);

// The helper itself, against a real daemon and against nothing at all.
// A fixed port would collide with a daemon left behind by an interrupted run (measured: EADDRINUSE
// on 8819 after one such run), so ask the OS for a free one.
async function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

const port = await freePort();
const cliPort = await freePort();
const tmp = makeTmp("rh-readiness-");
const daemon = startDaemon(port, cliPort, { token: "ready-token", manifests: tmp });
try {
  await daemon.ready;
  const health = await waitForHealth(port, 30_000);
  check(
    "waitForHealth returns the daemon's own health payload",
    health.status === "healthy" && health.service === "pocketdesk",
    JSON.stringify(health),
  );

  const dead = await freePort();
  const started = Date.now();
  let refused = null;
  try {
    await waitForHealth(dead, 1_500);
  } catch (e) {
    refused = e;
  }
  check(
    `waitForHealth gives up on a dead port (${Date.now() - started} ms)`,
    refused !== null && Date.now() - started >= 1_400,
    refused?.message,
  );
  check(
    "and it says which port never answered",
    String(refused?.message || "").includes(String(dead)),
    refused?.message,
  );

  const page = await waitForUrl(`http://127.0.0.1:${port}/health`, (r) => r.ok, 5_000);
  check("waitForUrl works on its own too", page.status === 200);

  // A port someone else already holds must fail loudly, not quietly test the stale daemon.
  const squatted = await freePort();
  const blocker = net.createServer().listen(squatted, "127.0.0.1");
  await new Promise((r) => blocker.once("listening", r));
  const dup = startDaemon(squatted, await freePort(), { token: "dup-token", manifests: tmp });
  let portError = null;
  try {
    await dup.ready;
  } catch (e) {
    portError = e;
  }
  check(
    `a squatted port is reported as such (${portError?.message ?? "no error"})`,
    /already in use/.test(String(portError?.message)),
    portError?.message,
  );
  try {
    dup.kill("SIGKILL");
  } catch {}
  await new Promise((r) => blocker.close(r));
} finally {
  await teardown(tmp);
}
finish();
