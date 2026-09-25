// Tools tab backing surface — the exact messages the browser client's Git,
// Doctor and Installed-apps sections send, checked against a live daemon and
// this repository as the git subject.
import path from "node:path";
import { execFileSync } from "node:child_process";
import { check, finish, makeTmp, openAndHello, REPO, startDaemon, teardown } from "./helpers.mjs";

const tmp = makeTmp("rh-ui-");

const PORT = 8831;
const CLI_PORT = 46831;
const TOKEN = "uitoken";

async function main() {
  const d = startDaemon(PORT, CLI_PORT, { token: TOKEN, manifests: tmp });
  await d.ready;
  const c = await openAndHello(PORT, TOKEN);

  c.send({ type: "git_status", cwd: REPO });
  const st = await c.next((m) => m.type === "git_status", 20000);
  check("git_status reports a branch", st.ok === true && typeof st.branch === "string" && Array.isArray(st.files));

  c.send({ type: "git_log", cwd: REPO, limit: 5 });
  const lg = await c.next((m) => m.type === "git_log");
  check("git_log returns parsed commits", lg.ok === true && lg.commits.length === 5 && !!lg.commits[0].hash && !!lg.commits[0].subject);

  c.send({ type: "git_branches", cwd: REPO });
  const br = await c.next((m) => m.type === "git_branches");
  check("git_branches marks the checked-out branch", br.ok === true && br.branches.some((b) => b.current));

  c.send({ type: "git_diff", cwd: REPO });
  const df = await c.next((m) => m.type === "git_diff");
  check("git_diff answers", df.ok === true && typeof df.out === "string");

  // The panel shows this error instead of an empty table.
  c.send({ type: "git_status", cwd: path.join(tmp, "not-a-repo") });
  const bad = await c.next((m) => m.type === "git_status");
  check("a non-repository reports an error", bad.ok === false && !!bad.error);

  c.send({ type: "doctor" });
  const doc = await c.next((m) => m.type === "doctor_report", 30000);
  check("doctor returns named checks", Array.isArray(doc.checks) && doc.checks.length > 0
    && doc.checks.every((x) => typeof x.name === "string" && typeof x.ok === "boolean"));

  c.send({ type: "apps_discover", q: "" });
  const apps = await c.next((m) => m.type === "apps", 60000);
  check("apps_discover returns entries the panel can act on", apps.items.length > 0
    && apps.items.every((a) => a.name && a.path && (a.kind === "gui" || a.kind === "cli")));
  // Windows Server (the CI runner) ships no Store apps, so compare against what Windows lists.
  const storeName = process.platform === "win32" && execFileSync("powershell.exe", ["-NoProfile", "-Command",
    "(Get-StartApps | Where-Object AppID -like '*!*' | Select-Object -First 1).Name"], { encoding: "utf8" }).trim();
  if (storeName) {
    c.send({ type: "apps_discover", q: storeName });
    const store = await c.next((m) => m.type === "apps", 60000);
    check("Store apps are discovered", store.items.some((a) => a.path.startsWith("shell:AppsFolder\\")));
  }

  // Only a discovered path may be launched — the panel never invents one.
  c.send({ type: "create", path: "C:/not/discovered.exe", cwd: tmp });
  const refused = await c.next((m) => m.type === "error");
  check("undiscovered path refused", /not a discovered tool/.test(refused.message));

  await c.close();
  await teardown(tmp);

  finish();
}

main().catch((err) => { console.error("TEST ERROR:", err); process.exit(1); });
