// Every test that starts a daemon must wait for the server to answer, not for a number of
// milliseconds. Measured 2026-11-24: the daemon needs 5-7 s from a cold cache here against
// fixed waits of 1.2-3 s, which is why `absorb`, `graceful-shutdown`, `sessions-leakguard`,
// `smoke` and `smoke-chat` were red on a cold machine and green on a warm one.
//
// Two checks: no test file may sleep a second or more before its first connection, and every
// file that spawns the daemon must have a readiness signal (`waitForHealth` or `.ready`).
// The third check runs `waitForHealth` itself both ways so the helper cannot rot silently.
import fs from "node:fs";
import path from "node:path";
import { REPO, check, finish, makeTmp, startDaemon, teardown, waitForHealth } from "./helpers.mjs";

const dir = path.join(REPO, "daemon", "test");
const files = fs.readdirSync(dir).filter((f) => f.endsWith(".test.mjs") && f !== "startup-readiness.test.mjs");

const SPAWNS = /spawn\(process\.execPath, \["src\/index\.js"\]|startDaemon\(/;
const CONNECTS = ["new WebSocket(", "openAndHello(", "connectRaw(", "connect("];

/** A fixed delay of a second or more, e.g. `await new Promise((r) => setTimeout(r, 1500))`. */
const SLEEP = /new Promise\(\(\s*(\w+)\s*\) => setTimeout\(\1, (\d+)\)\)/g;

const spawners = files.filter((f) => SPAWNS.test(fs.readFileSync(path.join(dir, f), "utf8")));
check(`there are daemon-spawning test files to check (${spawners.length})`, spawners.length > 20);

const offenders = [];
for (const f of spawners) {
  const text = fs.readFileSync(path.join(dir, f), "utf8");
  const firstConnect = Math.min(...CONNECTS.map((s) => {
    const i = text.indexOf(s);
    return i < 0 ? Infinity : i;
  }));
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
  return !/await waitForHealth\(|\.ready\b/.test(text);
});
check(
  `every spawner waits on a readiness signal${noSignal.length ? ": " + noSignal.join("; ") : ""}`,
  noSignal.length === 0,
);

// The helper itself, against a real daemon and against nothing at all.
const tmp = makeTmp("rh-readiness-");
const daemon = startDaemon(8819, 8820, { token: "ready-token", manifests: tmp });
await daemon.ready;
const health = await waitForHealth(8819, 30_000);
check("waitForHealth returns the daemon's own health payload", health.status === "healthy" && health.service === "pocketdesk", JSON.stringify(health));

const started = Date.now();
let refused = null;
try {
  await waitForHealth(8818, 1_500);
} catch (e) {
  refused = e;
}
check(`waitForHealth gives up on a dead port (${Date.now() - started} ms)`, refused !== null && Date.now() - started >= 1_400, refused?.message);
check("and it says which port never answered", String(refused?.message || "").includes("8818"), refused?.message);

await teardown(tmp);
finish();
