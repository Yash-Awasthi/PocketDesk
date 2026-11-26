// Input to a session whose PTY just exited is kept, bounded, and delivered by resume; a
// live session takes the same direct path as before. Real sessions, real PTYs.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, finish } from "./helpers.mjs";
import * as sessions from "../src/sessions.js";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function until(what, fn, ms = 15_000) {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out waiting for ${what}`);
    await sleep(50);
  }
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pd-pending-"));
const script = path.join(tmp, "echo.mjs");
// Without the marker the process exits at once; with it the process stays and echoes stdin,
// so "the process is back" is observable output rather than a flag.
fs.writeFileSync(
  script,
  `
import fs from "node:fs";
const marker = process.argv[2];
if (!fs.existsSync(marker)) process.exit(3);
process.stdout.write("READY\\n");
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => process.stdout.write("GOT:" + d.trim() + "\\n"));
process.stdin.resume();
`,
);
const start = (marker) =>
  sessions.create({ harnessId: "node", bin: process.execPath, cwd: tmp, args: [script, marker] }, () => {});
const session = (id) => sessions.get(id);

const ids = [];
try {
  // A live session is untouched: the write goes straight to the PTY and queues nothing.
  const liveMarker = path.join(tmp, "live");
  fs.writeFileSync(liveMarker, "1");
  const live = start(liveMarker);
  ids.push(live.id);
  await until("READY", () => session(live.id).scrollback.includes("READY"));
  check("a live session takes the write directly", sessions.write(live.id, "hello\r") === true);
  await until("GOT:hello", () => session(live.id).scrollback.includes("GOT:hello"));
  check("the live write reached the process", session(live.id).scrollback.includes("GOT:hello"));
  check("a live session queues nothing", session(live.id).pending.length === 0);

  // A reply that lands after the PTY exited is held, then delivered when the process is back.
  const marker = path.join(tmp, "later");
  const dead = start(marker);
  ids.push(dead.id);
  await until("exit", () => session(dead.id).exitCode !== null);
  check("the session really exited", session(dead.id).exitCode === 3);
  check("input to the exited session is taken", sessions.write(dead.id, "carry on\r") === true);
  check("it waits in the session queue", session(dead.id).pending.length === 1);
  fs.writeFileSync(marker, "1");
  check("resume puts the process back", sessions.resume(dead.id, () => {}) === true);
  check("the session is live again", session(dead.id).exitCode === null);
  await until("delivery", () => session(dead.id).scrollback.includes("GOT:carry on"));
  check(
    "the queued reply reached the restarted process",
    session(dead.id).scrollback.includes("GOT:carry on"),
  );
  check("the queue is empty after delivery", session(dead.id).pending.length === 0);

  // The queue holds a fixed few inputs; the oldest go first.
  const bounded = start(path.join(tmp, "never"));
  ids.push(bounded.id);
  await until("exit", () => session(bounded.id).exitCode !== null);
  for (let i = 0; i < 20; i++) sessions.write(bounded.id, `t${i}\r`);
  check("the queue is bounded at 8", session(bounded.id).pending.length === 8);
  check("the oldest inputs were dropped", session(bounded.id).pending[0] === "t12\r");
  check("the newest input is kept", session(bounded.id).pending[7] === "t19\r");

  // Past the reaper's TTL the session is expired: nothing is taken and nothing waits.
  const expired = start(path.join(tmp, "never"));
  ids.push(expired.id);
  await until("exit", () => session(expired.id).exitCode !== null);
  session(expired.id).endedAt = Date.now() - 6 * 60_000;
  check("an expired session takes no input", sessions.write(expired.id, "late\r") === false);
  check("an expired session holds nothing", session(expired.id).pending.length === 0);
  check("an expired session does not resume", sessions.resume(expired.id, () => {}) === false);
} finally {
  for (const id of ids) sessions.kill(id);
  sessions.killAll();
}
finish();
// node-pty keeps a handle open after killAll; the checks are done, so end the file.
setTimeout(() => process.exit(0), 200);
