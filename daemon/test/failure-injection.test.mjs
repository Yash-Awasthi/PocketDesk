// Failure injection: a PTY killed mid-stream, a socket dropped mid-transfer and a corrupted
// chunked read must each produce a documented answer and leave no process behind.
import fs from "node:fs";
import path from "node:path";
import { check, finish, makeTmp, openAndHello, startDaemon, teardown, waitForHealth } from "./helpers.mjs";

const PORT = 8891;
const CLI_PORT = 8892;
const TOKEN = "failinj";
const CHUNK = 256 * 1024;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };

const tmp = makeTmp("rh-failinj-");
const agent = path.join(tmp, "agent.js");
fs.writeFileSync(agent, `
const { spawn } = require("child_process");
const g = spawn(process.execPath, ["-e", "setInterval(() => {}, 1e6)"], { stdio: "ignore" });
console.log("AGENT " + process.pid);
console.log("GRANDCHILD " + g.pid);
setInterval(() => console.log("tick " + Date.now()), 50);
`);

const d = startDaemon(PORT, CLI_PORT, { manifests: tmp, token: TOKEN });
let agentPid = 0;
let grandchildPid = 0;
try {
  await d.ready;
  await waitForHealth(PORT);

  // 1. kill a PTY child while its output is still streaming
  const c = await openAndHello(PORT, TOKEN);
  c.send({ type: "create", harness: "node", cwd: tmp, args: [agent] });
  const created = await c.next((m) => m.type === "created" || m.type === "error");
  check(`agent session created${created.message ? ": " + created.message : ""}`, created.type === "created");
  c.send({ type: "attach", id: created.id });
  // Attach answers with a replay of the scrollback, then live out messages; both carry the id.
  let text = "";
  let ticks = 0;
  await c.next((m) => {
    if ((m.type === "out" || m.type === "replay") && m.id === created.id && m.data) text += Buffer.from(m.data, "base64").toString();
    ticks = (text.match(/tick /g) || []).length;
    const a = /AGENT (\d+)/.exec(text);
    const g = /GRANDCHILD (\d+)/.exec(text);
    if (a) agentPid = Number(a[1]);
    if (g) grandchildPid = Number(g[1]);
    return ticks >= 2 && agentPid > 0 && grandchildPid > 0;
  });
  check("the PTY is mid-stream before the kill", ticks >= 2);
  check("the agent and its child are alive before the kill", alive(agentPid) && alive(grandchildPid));

  c.send({ type: "kill", id: created.id });
  const exit = await c.next((m) => m.type === "exit" && m.id === created.id, 15000);
  check("the kill is reported to the client as an exit with a code", Number.isInteger(exit.code));

  let gone = false;
  for (let i = 0; i < 40 && !gone; i++) { gone = !alive(agentPid) && !alive(grandchildPid); if (!gone) await sleep(125); }
  check("no process survives the kill: the agent and its child are gone", gone);

  c.send({ type: "attach", id: created.id });
  const dead = await c.next((m) => m.type === "error", 15000);
  check("attaching to the killed session answers the documented error", String(dead.message).includes(created.id) && /no live session/.test(dead.message));

  // 2. drop the socket halfway through a multi-chunk transfer
  const big = path.join(tmp, "big.bin");
  const body = Buffer.alloc(700 * 1024);
  for (let i = 0; i < body.length; i++) body[i] = i & 0xff;
  fs.writeFileSync(big, body);

  const t = await openAndHello(PORT, TOKEN);
  t.send({ type: "fread", path: big, offset: 0 });
  const first = await t.next((m) => m.type === "fchunk" && m.path === big);
  check("the first chunk of the large transfer arrives", !first.error && Buffer.from(first.data || "", "base64").length === CHUNK);
  check("the transfer is unfinished when the socket drops", first.eof === false);

  const closed = new Promise((r) => t.ws.once("close", () => r(true)));
  t.ws.terminate();
  check("the dropped socket is visible to the client as a close", (await Promise.race([closed, sleep(5000).then(() => false)])) === true);

  const resumed = await openAndHello(PORT, TOKEN);
  resumed.send({ type: "fread", path: big, offset: CHUNK });
  const second = await resumed.next((m) => m.type === "fchunk" && m.path === big);
  check("the transfer resumes at the offset the client asks for", Buffer.from(second.data || "", "base64").equals(body.subarray(CHUNK, CHUNK * 2)));
  resumed.send({ type: "fread", path: big, offset: CHUNK * 2 });
  const last = await resumed.next((m) => m.type === "fchunk" && m.path === big);
  check("the tail chunk completes the transfer after the reconnect", last.eof === true && Buffer.from(last.data || "", "base64").equals(body.subarray(CHUNK * 2)));

  // 3. corrupt the chunked read: bad paths, then a file that shrinks between chunks
  const missing = path.join(tmp, "nope.bin");
  resumed.send({ type: "fread", path: missing, offset: 0 });
  const miss = await resumed.next((m) => m.type === "fchunk" && m.path === missing);
  check("a missing file answers with an error instead of data", Boolean(miss.error) && !miss.data);

  resumed.send({ type: "fread", path: tmp, offset: 0 });
  const dir = await resumed.next((m) => m.type === "fchunk" && m.path === tmp);
  check("a directory is refused as a file", dir.error === "not a file");

  const outside = process.platform === "win32" ? "C:/Windows/System32/drivers/etc/hosts" : "/etc/hostname";
  resumed.send({ type: "fread", path: outside, offset: 0 });
  const trav = await resumed.next((m) => m.type === "fchunk" && m.path === outside);
  check("a path outside the allowed roots is refused", /Path traversal not allowed/.test(String(trav.error || "")));

  fs.truncateSync(big, 1024);
  resumed.send({ type: "fread", path: big, offset: CHUNK });
  const short = await resumed.next((m) => m.type === "fchunk" && m.path === big);
  check("past the new end of a shrunk file the answer is a clean eof", short.eof === true && short.data === "" && short.size === 1024);

  resumed.send({ type: "fread", path: big, offset: 0 });
  const again = await resumed.next((m) => m.type === "fchunk" && m.path === big);
  check("the same socket still serves reads after every corrupted one", Buffer.from(again.data || "", "base64").equals(body.subarray(0, 1024)));

  const health = await waitForHealth(PORT);
  check("the daemon is still healthy after every injected failure", health.status === "healthy");
  check("the daemon did not restart", d.exitCode === null);
} catch (e) {
  check(`no error (${e.message})`, false);
} finally {
  if (agentPid && alive(agentPid)) try { process.kill(agentPid); } catch {}
  if (grandchildPid && alive(grandchildPid)) try { process.kill(grandchildPid); } catch {}
  await teardown(tmp);
}
finish();
