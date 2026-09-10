// Session monitor absorption test — exercises the monitor_* protocol surface
// (c9watch inspiration): live process discovery, stats, history, and
// monitor_event broadcasts. Uses the real OS process list (tasklist/ps), so
// the discovery check asserts something genuinely observed, not mocked.
import { check, connectRaw, finish, makeTmp, openAndHello, startDaemon, teardown } from "./helpers.mjs";
import { spawn } from "node:child_process";

const tmp = makeTmp("rh-t-");

const PORT = 8810;
const TOKEN = "testtoken";
const CLI_PORT = 46810;

async function main() {
  const d = startDaemon(PORT, CLI_PORT, { token: TOKEN, manifests: tmp });
  await d.ready;
  const c = await openAndHello(PORT, TOKEN);

  // The monitor's initial scan runs at start(); the daemon itself is a node
  // process, so at least one discovery is guaranteed on any OS.
  c.send({ type: "monitor_list" });
  const list = await c.next((m) => m.type === "monitor_list", 20000);
  check("monitor_list discovers processes", Array.isArray(list.items) && list.items.length >= 1);
  check("discovered session shape", list.items.every((s) => typeof s.pid === "number" && typeof s.processName === "string" && s.status === "active"));

  c.send({ type: "monitor_stats" });
  const stats = await c.next((m) => m.type === "monitor_stats");
  check("monitor_stats counts active", stats.activeCount >= 1 && stats.historyCount >= 0);

  // monitor_history: seed one terminated entry by spawning + killing a node child.
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  const pid = child.pid;
  // Wait for the monitor's next scan to pick it up (scan interval 5s).
  const discovered = await c.next((m) => m.type === "monitor_event" && m.event === "discovered" && m.session.pid === pid, 20000).catch(() => null);
  check("monitor_event discovered broadcast", !!discovered);

  child.kill("SIGKILL");
  // Next scan notices the death.
  const terminated = await c.next((m) => m.type === "monitor_event" && m.event === "terminated" && m.session.pid === pid, 20000).catch(() => null);
  check("monitor_event terminated broadcast", !!terminated);

  c.send({ type: "monitor_history" });
  const hist = await c.next((m) => m.type === "monitor_history", 20000);
  check("monitor_history records the crash", hist.items.some((s) => s.pid === pid && s.status === "terminated"));

  c.send({ type: "monitor_stats" });
  const stats2 = await c.next((m) => m.type === "monitor_stats");
  check("history count grows", stats2.historyCount >= 1);

  await c.close();
  await teardown(tmp);
  try { fs.rmSync(path.join(os.homedir(), ".pocketdesk-test", "session_history.json"), { force: true }); } catch {}

  finish();
}

main().catch((err) => { console.error("TEST ERROR:", err); process.exit(1); });
