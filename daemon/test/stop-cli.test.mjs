// `pocketdesk stop` has to be a real stop: the daemon, the terminals it hosted and the helper
// processes it left in the data folder all go, and nothing comes back on its own. The lockdown
// oracle (a native client that kills PocketDesk) depends on exactly this.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import net from "node:net";
import { spawn } from "node:child_process";
import { REPO, check, finish, makeTmp, startDaemon, connect } from "./helpers.mjs";

const PORT = 8836, CLI = 8837;
const manifests = makeTmp("rh-stop-");
const home = path.join(os.tmpdir(), "rh-home-stop-" + process.pid);
fs.mkdirSync(path.join(home, "helpers"), { recursive: true });

const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const listening = (p) => new Promise((resolve) => {
  const s = net.connect({ host: "127.0.0.1", port: p });
  const done = (v) => { s.destroy(); resolve(v); };
  s.setTimeout(500);
  s.once("connect", () => done(true));
  s.once("timeout", () => done(false));
  s.once("error", () => done(false));
});

// A process shaped like a capture helper: started from the data folder, not a child of the daemon.
const helperPath = path.join(home, "helpers", "capture.ps1");
fs.writeFileSync(helperPath, "");
const helper = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)", helperPath], { detached: true, stdio: "ignore" });

const d = startDaemon(PORT, CLI, { home, manifests, dataDir: ".pocketdesk-test-" + PORT });
try {
  await d.ready;
  // A terminal with a child of its own: a stop must take both.
  const c = connect(PORT);
  await new Promise((r) => c.ws.on("open", r));
  c.send({ type: "hello", token: "testtoken" });
  await c.next((m) => m.type === "welcome");
  const dir = path.join(home, "term");
  fs.mkdirSync(dir, { recursive: true });
  const script = path.join(dir, "child.js");
  fs.writeFileSync(script, "const c=require('child_process').spawn(process.execPath,['-e','setInterval(()=>{},1e6)'],{stdio:'ignore'});console.log('CHILD '+c.pid);setInterval(()=>{},1e6);");
  c.send({ type: "create", harness: "node", cwd: dir, args: [script] });
  const created = await c.next((m) => m.type === "created" || m.type === "error");
  check(`a terminal session exists${created.message ? ": " + created.message : ""}`, created.type === "created");
  let child = 0;
  c.send({ type: "attach", id: created.id });
  await c.next((m) => {
    const hit = m.type === "out" && /CHILD (\d+)/.exec(Buffer.from(m.data, "base64").toString());
    if (hit) child = Number(hit[1]);
    return child > 0;
  });
  check("the terminal started a child process", child > 0 && alive(child));
  check("a capture helper is running from the data folder", alive(helper.pid));

  const daemonExit = new Promise((r) => d.on("exit", () => r(true)));
  const stopped = spawn(process.execPath, ["src/cli.js", "stop"], {
    cwd: path.join(REPO, "daemon"),
    env: { ...process.env, RH_PORT: String(PORT), RH_CLI_PORT: String(CLI), RH_TOKEN: "testtoken", RH_HOME: home },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let out = "";
  stopped.stdout.on("data", (x) => (out += x));
  stopped.stderr.on("data", (x) => (out += x));
  const code = await new Promise((r) => stopped.on("exit", r));
  check(`pocketdesk stop exits 0${code ? ": " + out.trim() : ""}`, code === 0);
  check("stop reports what it verified", /stopped: .*nothing listening, nothing restarted/.test(out));

  const exited = await Promise.race([daemonExit, new Promise((r) => setTimeout(() => r(false), 10000))]);
  check("the daemon process is gone", exited);
  check("nothing listens on the daemon port", !(await listening(PORT)));
  check("nothing listens on the CLI port", !(await listening(CLI)));
  check("the terminal's child process is gone", !alive(child));
  if (process.platform === "win32") check("the capture helper process is gone", !alive(helper.pid));
  else console.log("SKIP  the capture helper sweep is Windows-only (PowerShell/CIM)");

  await new Promise((r) => setTimeout(r, 3000));
  check("nothing re-armed after the stop", !(await listening(PORT)) && !(await listening(CLI)));
} catch (e) {
  check(`no error (${e.message})`, false);
} finally {
  try { d.kill("SIGKILL"); } catch {}
  try { process.kill(helper.pid); } catch {}
  try { fs.rmSync(home, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(manifests, { recursive: true, force: true }); } catch {}
}
finish();
