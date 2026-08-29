import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import WebSocket from "ws";

const PORT = 8796;
const TOKEN = "chattoken";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rh-chat-"));
const agentJs = path.join(tmp, "fakeagent.js");
fs.writeFileSync(agentJs, `
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  const line = (o) => process.stdout.write(JSON.stringify(o) + "\\n");
  line({ type: "system", subtype: "init" });
  const prompt = input.trim();
  if (!prompt) { line({ type: "result", is_error: true, result: "empty" }); return; }
  line({ type: "assistant", message: { content: [{ type: "text", text: "echo: " + prompt }] } });
  line({ type: "assistant", message: { content: [{ type: "tool_use", name: "Bash", input: { command: "dir" } }] } });
  line({ type: "result", is_error: false, result: "" });
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
  id: "fakechat",
  name: "Fake Chat",
  adapter: "terminal",
  bin: "node",
  install: {},
  chat: { args: [agentJs], format: "claude-stream-json", resumeArgs: [agentResumeJs] },
}));

const daemon = spawn(process.execPath, ["src/index.js"], {
  env: { ...process.env, RH_PORT: String(PORT), RH_TOKEN: TOKEN, RH_MANIFESTS: tmp },
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
function next(pred, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("timeout waiting for message")), timeoutMs);
    waiters.push({ pred, resolve, timer: t });
  });
}
function send(o) {
  ws.send(JSON.stringify(o));
}
async function collect(preds, timeoutMs = 15000) {
  // resolves when every pred has matched at least once; returns array of first matches
  const got = new Array(preds.length).fill(null);
  const deadline = Date.now() + timeoutMs;
  while (got.some((g) => g === null)) {
    if (Date.now() > deadline) throw new Error("timeout collecting chat events");
    const m = await Promise.race([
      next((x) => preds.some((p, i) => p(x)), 2000).catch(() => null),
    ]);
    if (!m) continue;
    for (let i = 0; i < preds.length; i++) {
      if (got[i] === null && preds[i](m)) got[i] = m;
    }
  }
  return got;
}

async function run() {
  try {
    await new Promise((r) => setTimeout(r, 1200));
    ws = new WebSocket(`ws://localhost:${PORT}/ws`);
    await new Promise((res) => ws.on("open", res));
    ws.on("message", (raw) => {
      const m = JSON.parse(raw.toString());
      const i = waiters.findIndex((w) => w.pred(m));
      if (i >= 0) {
        const [w] = waiters.splice(i, 1);
        clearTimeout(w.timer);
        w.resolve(m);
      }
    });

    send({ type: "hello", token: TOKEN });
    await next((m) => m.type === "welcome");

    send({ type: "detect" });
    const mans = await next((m) => m.type === "manifests");
    check("fake chat tool detected", mans.items.some((i) => i.manifest.id === "fakechat" && i.installed));

    send({ type: "chatsession", harness: "fakechat", cwd: tmp, prompt: "hello world" });
    const created = await next((m) => m.type === "created" || m.type === "error");
    check("chat session created", created.type === "created");
    const id = created.id;

    const [userEv, deltaEv, toolEv, doneEv] = await collect([
      (m) => m.type === "chatuser" && m.id === id,
      (m) => m.type === "chatdelta" && m.text?.includes("echo: hello world"),
      (m) => m.type === "chartool" && m.name === "Bash",
      (m) => m.type === "chatstate" && m.id === id && m.state === "idle",
    ]);
    check("prompt echoed to transcript", Boolean(userEv));
    check("stream-json parsed into assistant text", Boolean(deltaEv));
    check("tool_use surfaced as chartool", Boolean(toolEv));
    check("result flips state to idle", Boolean(doneEv));

    send({ type: "attach", id });
    const replay = await next((m) => m.type === "chatreplay");
    check(
      "attach replays full transcript",
      replay.id === id && replay.items.some((i) => i.role === "user") && replay.items.some((i) => i.role === "tool"),
    );

    send({ type: "chatmsg", id, text: "second turn" });
    const resumedDelta = await next((m) => m.type === "chatdelta" && m.text?.includes("resumed: second turn"));
    check("follow-up uses resume adapter", Boolean(resumedDelta));
    await next((m) => m.type === "chatstate" && m.state === "idle");

    send({ type: "detach", id });
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
