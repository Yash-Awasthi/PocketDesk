// The Windows install leaves nothing on screen: Start Menu entry only, and the SYSTEM daemon
// named for Task Manager. Read statically, since CI cannot run the installer.
import fs from "node:fs";
import path from "node:path";
import { check, finish, REPO } from "./helpers.mjs";

const install = fs.readFileSync(path.join(REPO, "daemon", "scripts", "install-service.ps1"), "utf8");
const consoleCs = fs.readFileSync(path.join(REPO, "daemon", "scripts", "console", "PocketDeskConsole.cs"), "utf8");
const launcherCs = fs.readFileSync(path.join(REPO, "daemon", "scripts", "PocketDeskLauncher.cs"), "utf8");

check("no shortcut is created on the desktop", !/CreateShortcut\([^)]*Desktop/.test(install));
check("a Start Menu shortcut is created", /CreateShortcut\(\(Join-Path \(\[Environment\]::GetFolderPath\("Programs"\)\)/.test(install));
check("an older desktop shortcut is removed", /Remove-Item \(Join-Path \(\[Environment\]::GetFolderPath\("Desktop"\)\) "PocketDesk.lnk"\)/.test(install));
check("the SYSTEM daemon gets its own exe name", install.includes("PocketDeskConsoleDaemon.exe") && consoleCs.includes("PocketDeskConsoleDaemon.exe"));
check("the launcher has no tray icon or window", !/NotifyIcon|Application\.Run|new Form/.test(launcherCs) && launcherCs.includes("CreateNoWindow = true"));
finish();
