/**
 * GUI application manifests — the IDE entries the phone launches.
 *
 * A GUI app has no `--version` probe and no PTY, so it is detected by the
 * presence of its executable and started detached. These checks cover path
 * expansion, detection, the adapter guard, and the `gui_open` round trip,
 * without touching a real IDE.
 *
 * The registry reads RH_MANIFESTS when its module is evaluated, so it is
 * imported dynamically after the fixture directory is in place.
 */
import fs from "node:fs";
import path from "node:path";
import { check, failureCount, failureNames, makeTmp, openAndHello, REPO, startDaemon, teardown } from "./helpers.mjs";

const tmp = makeTmp("rh-gui-");
const MANIFESTS_SRC = path.join(REPO, "daemon", "manifests");

function writeManifest(name, obj) {
  fs.writeFileSync(path.join(tmp, name), JSON.stringify(obj));
}

async function main() {
  const fakeDir = fs.mkdtempSync(path.join(tmp, "apps-"));
  const fakeExe = path.join(fakeDir, "FakeIde.exe");
  fs.writeFileSync(fakeExe, "");

  writeManifest("fake-ide.json", {
    id: "fake-ide",
    name: "Fake IDE",
    adapter: "gui",
    paths: { [process.platform]: fakeExe },
  });
  writeManifest("absent-ide.json", {
    id: "absent-ide",
    name: "Absent IDE",
    adapter: "gui",
    paths: { [process.platform]: path.join(fakeDir, "NotThere.exe") },
  });

  // Must be set before the registry module is evaluated.
  process.env.RH_MANIFESTS = tmp;
  const { guiPath, launchGui, list, scanAll } = await import("../src/registry.js");

  await scanAll(() => {});
  const byId = Object.fromEntries(list().map((r) => [r.manifest.id, r]));

  check("gui app with an existing path is installed", byId["fake-ide"].installed === true);
  check("gui app records its path as the version", byId["fake-ide"].version === fakeExe);
  check("gui app with a missing path is not installed", byId["absent-ide"].installed === false);

  const guiShipped = fs
    .readdirSync(MANIFESTS_SRC)
    .filter((f) => f.endsWith(".json"))
    .map((f) => JSON.parse(fs.readFileSync(path.join(MANIFESTS_SRC, f), "utf8")))
    .filter((m) => m.adapter === "gui");

  check("at least one gui manifest ships", guiShipped.length >= 1);
  check(
    "every gui manifest declares per-platform paths",
    guiShipped.every((m) => m.paths && typeof m.paths === "object"),
  );
  check(
    "every gui manifest names at least one platform",
    guiShipped.every((m) => ["win32", "darwin", "linux", "default"].some((k) => m.paths?.[k])),
  );
  // A mistyped %VAR% expands to the empty string, which reads as "not
  // installed" rather than as a manifest error.
  check(
    "declared paths on this platform survive expansion",
    guiShipped
      .map((m) => m.paths?.[process.platform])
      .filter(Boolean)
      .every((p) => (guiPath({ paths: { [process.platform]: p } }) || "").length > 0),
  );
  check("no gui manifest advertises a package install", guiShipped.every((m) => !m.install));
  check(
    "every gui manifest has an id and a name",
    guiShipped.every((m) => typeof m.id === "string" && m.id && typeof m.name === "string" && m.name),
  );

  if (process.platform === "win32") {
    check(
      "windows env vars expand in manifest paths",
      guiPath({ paths: { win32: "%LOCALAPPDATA%\\Programs\\antigravity\\Antigravity.exe" } }) ===
        `${process.env.LOCALAPPDATA}\\Programs\\antigravity\\Antigravity.exe`,
    );
  }
  check("a manifest with no paths yields no path", guiPath({ id: "x" }) === null);
  check("an unlisted platform with no default yields no path", guiPath({ paths: { plan9: "/x" } }) === null);

  writeManifest("cli-agent.json", {
    id: "cli-agent",
    name: "CLI Agent",
    adapter: "terminal",
    bin: process.execPath,
    install: {},
  });
  await scanAll(() => {});
  check("launchGui refuses an unknown id", launchGui("nope-not-real").ok === false);
  const cli = launchGui("cli-agent");
  check(
    "launchGui refuses a terminal harness",
    cli.ok === false && cli.reason === "not a gui app",
  );
  const r = launchGui("absent-ide");
  check("launchGui refuses an app that is not installed", r.ok === false && r.reason === "not installed");

  // Node stands in for the IDE and reports that it ran by touching a file, so
  // the launch is proved without opening a window.
  const marker = path.join(fakeDir, "launched.txt");
  writeManifest("scripted-ide.json", {
    id: "scripted-ide",
    name: "Scripted IDE",
    adapter: "gui",
    paths: { [process.platform]: process.execPath },
    openArgs: ["-e", `require("fs").writeFileSync(${JSON.stringify(marker)}, "ran")`],
  });
  await scanAll(() => {});
  const launched = launchGui("scripted-ide");
  check("launchGui reports success for an installed app", launched.ok === true);
  const deadline = Date.now() + 10000;
  while (!fs.existsSync(marker) && Date.now() < deadline) {
    await new Promise((res) => setTimeout(res, 100));
  }
  check("launchGui starts the app detached", fs.existsSync(marker));

  // A project folder must reach the IDE: as its last argument (how every IDE
  // here is told which directory to open) and as the process's own cwd.
  const argvMarker = path.join(fakeDir, "argv.txt");
  writeManifest("folder-ide.json", {
    id: "folder-ide",
    name: "Folder IDE",
    adapter: "gui",
    paths: { [process.platform]: process.execPath },
    openArgs: [
      "-e",
      `require("fs").writeFileSync(${JSON.stringify(argvMarker)}, process.argv.slice(1).join("|") + "||" + process.cwd())`,
    ],
  });
  await scanAll(() => {});
  const projectDir = fs.mkdtempSync(path.join(tmp, "project-"));
  check("launchGui accepts a project folder", launchGui("folder-ide", projectDir).ok === true);
  const argvDeadline = Date.now() + 10000;
  while (!fs.existsSync(argvMarker) && Date.now() < argvDeadline) {
    await new Promise((res) => setTimeout(res, 100));
  }
  const [argv, cwdSeen] = fs.readFileSync(argvMarker, "utf8").split("||");
  check("the project folder is the app's last argument", argv.split("|").pop() === projectDir);
  check("the project folder is the app's working directory", fs.realpathSync(cwdSeen) === fs.realpathSync(projectDir));
  check(
    "launchGui refuses a folder that does not exist",
    launchGui("folder-ide", path.join(tmp, "no-such-project")).reason === "no such folder",
  );

  // Discovery is the allowlist for launching by path: the string reaches a
  // shell (`cmd /c start`, the PTY's `cmd /c`), so it cannot be free-form.
  const { discover, find, search } = await import("../src/app_discovery.js");
  const found = discover();
  check("discovery finds applications on this machine", found.length > 0);
  check("every discovered app names a path and a kind", found.every((a) => a.path && (a.kind === "gui" || a.kind === "cli")));
  check("find round-trips a discovered path", find(found[0].path)?.path === found[0].path);
  check("find rejects a path discovery never reported", find(path.join(tmp, "not-an-app.exe")) === null);
  check("search filters by name", search(found[0].name).some((a) => a.path === found[0].path));
  check("search caps its result", search("", 5).length <= 5);

  // The phone must be told the outcome: the window opens where it cannot see.
  const port = 8831;
  const daemon = startDaemon(port, port + 1, { manifests: tmp });
  await daemon.ready;
  const c = await openAndHello(port);
  c.send({ type: "gui_open", harness: "scripted-ide" });
  const opened = await c.next((m) => m.type === "gui_opened");
  check("gui_open acks a launch", opened.ok === true && opened.harness === "scripted-ide");
  c.send({ type: "gui_open", harness: "absent-ide" });
  const refused = await c.next((m) => m.type === "gui_opened");
  check("gui_open reports a refusal", refused.ok === false && refused.reason === "not installed");

  const bogus = path.join(tmp, "not-an-app.exe");
  c.send({ type: "gui_open", path: bogus });
  const rejected = await c.next((m) => m.type === "gui_opened");
  check("gui_open refuses a path discovery never reported", rejected.ok === false && rejected.reason === "not a discovered app");
  c.send({ type: "apps_discover", q: found[0].name });
  const apps = await c.next((m) => m.type === "apps");
  check("apps_discover answers with matching applications", apps.items.some((a) => a.path === found[0].path));
  c.send({ type: "create", path: bogus });
  const createErr = await c.next((m) => m.type === "error");
  check("create refuses a path discovery never reported", createErr.message.startsWith("not a discovered tool"));
  await c.close();
  await teardown(tmp);

  if (failureCount()) {
    console.error(`FAILED: ${failureCount()} — ${failureNames()}`);
    process.exit(1);
  }
  console.log("gui-manifests: done");
}

main().catch(async (e) => {
  console.error(e);
  await teardown(tmp);
  process.exit(1);
});
