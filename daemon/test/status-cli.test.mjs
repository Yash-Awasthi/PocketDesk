// `pocketdesk --status` is the first thing a person (or an invigilator) reads before handing the PC
// over, so every line has to come from a measurement: the task that is really registered, the ports
// that are really configured, the folder that is really used.
import path from "node:path";
import { execFileSync } from "node:child_process";
import { REPO, check, finish, makeTmp, startDaemon } from "./helpers.mjs";
import { parseTaskXml, taskXml } from "../src/status.js";

// 1. The task definition is read, not assumed.
const limited = parseTaskXml("<Task><Principals><Principal><RunLevel>LeastPrivilege</RunLevel></Principal></Principals><Settings><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings></Task>");
check("an unelevated task with a restart policy is read as such", limited.elevated === false && limited.restarts === 3 && limited.interval === "1 min");
const highest = parseTaskXml("<Task><Settings><RestartOnFailure><Interval>PT1M</Interval><Count>3</Count></RestartOnFailure></Settings><Principals><Principal><RunLevel>HighestAvailable</RunLevel></Principal></Principals></Task>");
check("HighestAvailable counts as elevated", highest.elevated === true);
check("no task means no autostart", parseTaskXml("") === null);

const manifests = makeTmp("rh-status-");
const home = path.join(process.env.TEMP || "/tmp", "rh-status-home-" + process.pid);
const PORT = 8866;
const run = (env) => execFileSync(process.execPath, ["src/cli.js", "--status"], {
  cwd: path.join(REPO, "daemon"), encoding: "utf8", env: { ...process.env, RH_HOME: home, RH_PORT: String(PORT), ...env },
});

// 2. Every promised line is there, in order, with the values this machine actually has.
const out = run({});
const lines = out.trim().split("\n");
const order = ["elevated:", "auto-start:", "restart policy:", "ports:", "data:"];
check(`all five promised lines are printed${out.includes("elevated:") ? "" : ": " + out}`,
  order.every((label, i) => lines[i]?.startsWith(label)));
check("ports are the configured daemon port, its loopback page and the cli port",
  lines[3].includes(`${PORT} daemon, ${PORT + 10} loopback page, 4679 cli`));
check("the data folder is the one in use", lines[4] === `data: ${home}`);
check("a daemon that is not running is reported as not running", lines[5] === "running: no");
if (process.platform === "win32") {
  const task = parseTaskXml(taskXml());
  check("the elevated line matches the registered task", lines[0].startsWith(`elevated: ${task?.elevated ? "yes" : "no"}`));
  check("the restart line matches the registered task", task?.restarts
    ? lines[2].startsWith(`restart policy: ${task.restarts} restart`)
    : lines[2].startsWith("restart policy: none"));
} else {
  console.log("SKIP  task-policy cross-check needs Windows Task Scheduler");
}

// 3. A running daemon is seen, not guessed.
const d = startDaemon(PORT, PORT + 1, { home, manifests, dataDir: ".pocketdesk-test-" + PORT });
try {
  await d.ready;
  const live = run({ RH_CLI_PORT: String(PORT + 1) }).trim().split("\n");
  check(`a running daemon is reported${live[5] ? "" : ": no line"}`, live[5] === "running: yes");
} catch (e) {
  check(`no error (${e.message})`, false);
} finally {
  try { d.kill("SIGKILL"); } catch {}
}
finish();
