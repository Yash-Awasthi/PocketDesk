import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";

const PORT = 8799;
const TOKEN = "smoketoken";
const tmpMan = fs.mkdtempSync(path.join(os.tmpdir(), "rh-manifests-"));
fs.writeFileSync(path.join(tmpMan, "node.json"), JSON.stringify({ id: "node", name: "Node REPL", adapter: "terminal", bin: "node", install: {} }));

const daemon = spawn(process.execPath, ["src/index.js"], {
  cwd: new URL("..", import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1"),
  env: { ...process.env, RH_PORT: String(PORT), RH_TOKEN: TOKEN, RH_MANIFESTS: tmpMan },
  stdio: ["ignore", "pipe", "pipe"],
});
daemon.stdout.on("data", (d) => process.stdout.write("[daemon] " + d));
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
    const t = setTimeout(() => reject(new Error("timeout waiting for message")), timeoutMs);
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
function send(o) {
  ws.send(JSON.stringify(o));
}

async function run() {
  try {
    await new Promise((res) => setTimeout(res, 1500));
  ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  await new Promise((res, rej) => {
    ws.on("open", res);
    ws.on("error", rej);
  });
  pump();

  send({ type: "hello", token: "wrong" });
  const badEnd = await new Promise((res) => ws.once("close", (c) => res(c)));
  check(`bad token rejected (close ${badEnd})`, badEnd === 4003);

  ws = new WebSocket(`ws://localhost:${PORT}/ws`);
  await new Promise((res) => ws.on("open", res));
  pump();
  send({ type: "hello", token: TOKEN });
  const welcome = await next((m) => m.type === "welcome");
  check("welcome received", welcome.type === "welcome");
  check("welcome lists sessions+manifests", Array.isArray(welcome.manifests) && Array.isArray(welcome.sessions));

  send({ type: "detect" });
  const mans = await next((m) => m.type === "manifests", 20000);
  check("manifests broadcast after detect", mans.items.some((i) => i.manifest.id === "node"));
  const node = mans.items.find((i) => i.manifest.id === "node");
  check("node detected installed", node.installed === true && /v\d/.test(node.version || ""));

  send({ type: "fs", path: "" });
  const fsMsg = await next((m) => m.type === "fs");
  check("fs listing works", Array.isArray(fsMsg.items));

  send({ type: "create", harness: "node", cwd: os.tmpdir() });
  const created = await next((m) => m.type === "created" || m.type === "error");
  check("session created", created.type === "created");
  if (created.type !== "created") throw new Error(created.message);

  send({ type: "attach", id: created.id });
  const replay = await next((m) => m.type === "replay");
  check("attach replays scrollback", replay.id === created.id);

  send({ type: "in", id: created.id, data: Buffer.from('console.log("smoke-" + (40 + 2))\r').toString("base64") });
  let got = "", exited = null;
  while (!got.includes("smoke-42") && exited === null) {
    const m = await next((x) => x.type === "out" || x.type === "exit" || x.type === "error", 15000);
    if (m.type === "out") got += Buffer.from(m.data, "base64").toString("utf8");
    if (m.type === "exit") exited = m.code;
    if (m.type === "error") throw new Error(m.message);
  }
  check("input reaches PTY and output streams back", got.includes("smoke-42"));

  send({ type: "resize", id: created.id, cols: 120, rows: 40 });
  send({ type: "kill", id: created.id });
  const exit = await next((m) => m.type === "exit", 10000);
  check("kill produces exit event", exit.id === created.id);

  ws.close();
} catch (e) {
  console.error("SMOKE ERROR:", e.message);
  failures.push(e.message);
} finally {
  daemon.kill();
}
}
await run();
console.log(failures.length ? `\n${failures.length} FAILURE(S)` : "\nALL PASS");
process.exit(failures.length ? 1 : 0);
