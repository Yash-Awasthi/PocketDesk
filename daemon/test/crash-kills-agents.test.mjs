// A daemon that crashes skips its graceful shutdown; the processes its agents
// started must still go with it, or every tray restart leaves more behind.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { REPO, check, connect, failureCount, failureNames, makeTmp } from "./helpers.mjs";

const PORT = 8814;
const tmp = makeTmp("rh-crash-");
const agent = path.join(tmp, "agent.js");
fs.writeFileSync(agent, `
const c = require("child_process").spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { stdio: "ignore" });
console.log("GRANDCHILD " + c.pid);
setInterval(() => {}, 1e6);
`);

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

// Closing stdin throws inside the daemon: an uncaught exception, as a real bug would cause.
// Main thread only: node-pty's worker threads load the same preload.
const crash = "data:text/javascript,import{isMainThread}from'node:worker_threads';" +
  "if(isMainThread){process.stdin.on('end',()=>{throw new Error('test crash')});process.stdin.resume();}";
const d = spawn(process.execPath, ["--import", crash, "src/index.js"], {
  cwd: REPO + "/daemon",
  env: {
    ...process.env, RH_PORT: String(PORT), RH_CLI_PORT: String(PORT + 1), RH_TOKEN: "testtoken", RH_MANIFESTS: tmp,
    POCKETDESK_DATA: ".pocketdesk-test", RH_HOME: path.join(os.tmpdir(), "rh-home-" + PORT),
  },
  stdio: ["pipe", "pipe", "pipe"],
});
d.stderr.on("data", () => {});
let grandchild = 0;
try {
  await new Promise((resolve, reject) => {
    d.stdout.on("data", (x) => { if (String(x).includes("registry scanned")) resolve(); });
    d.on("exit", () => reject(new Error("daemon exited early")));
  });
  const c = connect(PORT);
  await new Promise((r) => c.ws.on("open", r));
  c.send({ type: "hello", token: "testtoken" });
  await c.next((m) => m.type === "welcome");
  c.send({ type: "create", harness: "node", cwd: tmp, args: [agent] });
  const created = await c.next((m) => m.type === "created" || m.type === "error");
  check("agent session created", created.type === "created");
  c.send({ type: "attach", id: created.id });
  let out = "";
  await c.next((m) => {
    if (m.type === "out" && m.id === created.id) out += Buffer.from(m.data, "base64").toString();
    const hit = /GRANDCHILD (\d+)/.exec(out);
    if (hit) grandchild = Number(hit[1]);
    return grandchild > 0;
  });
  check("agent started a child process", alive(grandchild));

  const exited = new Promise((r) => d.on("exit", r));
  d.stdin.end();
  const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r("timeout"), 15000))]);
  check("daemon crashed", code !== "timeout" && code !== 0);
  await new Promise((r) => setTimeout(r, 500));
  check("agent's child process is gone", !alive(grandchild));
} catch (e) {
  check(`no error (${e.message})`, false);
} finally {
  try { d.kill("SIGKILL"); } catch {}
  if (grandchild && alive(grandchild)) try { process.kill(grandchild); } catch {}
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
console.log(failureCount() ? `\nFAILURES: ${failureNames()}` : "\nALL PASS");
process.exit(failureCount() ? 1 : 0);
