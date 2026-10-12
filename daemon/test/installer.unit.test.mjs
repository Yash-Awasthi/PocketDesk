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
check("starting the daemon asks UAC, and No leaves it stopped", launcherCs.includes('Verb = "runas"') && launcherCs.includes("--elevated")
  && /catch \(Win32Exception\) \{ return false; \}/.test(launcherCs) && launcherCs.includes("if (!DaemonRunning(port) && !StartElevated()) return;"));
check("installers ask a running daemon to stop before killing it", ["install.ps1", "uninstall.ps1", path.join("daemon", "scripts", "install-service.ps1")]
  .every((f) => fs.readFileSync(path.join(REPO, f), "utf8").includes("127.0.0.1:4679/shutdown")));
check("the SYSTEM daemon leaves CLI port 4679 to the user daemon", /RH_CLI_PORT=(?!4679)\d+/.test(consoleCs));
// The daemon runs elevated, so nothing it executes may come from a folder or variable the user's programs can change.
check("the elevated launcher runs from an admin-only Program Files copy", /\$protected = Join-Path \$env:ProgramFiles/.test(install)
  && install.includes('$exe = Join-Path $protected "PocketDeskLauncher.exe"') && /-Name "PocketDesk" -Value "`"\$exe`" --daemon"/.test(install));
check("the launcher never takes node or ffmpeg from PATH", !/: "node"/.test(launcherCs) && launcherCs.includes('Path.Combine(ExeDir, "ffmpeg", "ffmpeg.exe")'));
check("the launcher drops NODE_* variables before starting node", launcherCs.includes('StartsWith("NODE_"'));
check("the console install takes ownership of ProgramData\\PocketDesk", install.includes('icacls $pdRoot /setowner "*S-1-5-32-544"'));
check("the launcher has no tray icon or window", !/NotifyIcon|Application\.Run|new Form/.test(launcherCs) && launcherCs.includes("CreateNoWindow = true"));

// macOS and Linux follow the same rule: a hidden service, an app entry that opens the settings page.
const sh = fs.readFileSync(path.join(REPO, "install.sh"), "utf8");
const scripts = path.join(REPO, "daemon", "scripts");
check("macOS has no menu-bar tray", !fs.existsSync(path.join(scripts, "mac", "PocketDeskTray.swift")) && !/swiftc/.test(sh));
check("macOS runs the daemon as a LaunchAgent", /<string>__NODE__<\/string><string>src\/index.js<\/string>/.test(fs.readFileSync(path.join(scripts, "mac", "com.pocketdesk.daemon.plist"), "utf8")));
check("Linux adds an app-menu entry that opens pairing", /Exec="__BIN__" pair/.test(fs.readFileSync(path.join(scripts, "linux", "pocketdesk.desktop"), "utf8")));
check("services get the installing shell's PATH", sh.includes('s#__PATH__#$SVC_PATH#') && fs.readFileSync(path.join(scripts, "linux", "pocketdesk.service"), "utf8").includes("PATH=__PATH__"));
check("the program never clones into the config dir", /APP_DIR="\$INSTALL_DIR\/app"/.test(sh) && !sh.includes("heads/main"));
finish();
