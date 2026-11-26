// The Windows install leaves nothing on screen: Start Menu entry only, and the SYSTEM daemon
// named for Task Manager. Read statically, since CI cannot run the installer.
import fs from "node:fs";
import path from "node:path";
import { check, finish, REPO } from "./helpers.mjs";

const install = fs.readFileSync(path.join(REPO, "daemon", "scripts", "install-service.ps1"), "utf8");
const consoleCs = fs.readFileSync(
  path.join(REPO, "daemon", "scripts", "console", "PocketDeskConsole.cs"),
  "utf8",
);
const launcherCs = fs.readFileSync(path.join(REPO, "daemon", "scripts", "PocketDeskLauncher.cs"), "utf8");

check("no shortcut is created on the desktop", !/CreateShortcut\([^)]*Desktop/.test(install));
check(
  "a Start Menu shortcut is created",
  /CreateShortcut\(\(Join-Path \(\[Environment\]::GetFolderPath\("Programs"\)\)/.test(install),
);
check(
  "an older desktop shortcut is removed",
  /Remove-Item \(Join-Path \(\[Environment\]::GetFolderPath\("Desktop"\)\) "PocketDesk.lnk"\)/.test(install),
);
check(
  "the SYSTEM daemon gets its own exe name",
  install.includes("PocketDeskConsoleDaemon.exe") && consoleCs.includes("PocketDeskConsoleDaemon.exe"),
);
// Closing the daemon is the point: the default install is an ordinary unelevated per-user task, and
// elevation is an explicit -Protected flag that states what it costs.
const DEFAULT = install.slice(install.indexOf("# Default install:"));
check("the installer offers -Protected as an explicit flag", install.includes("$Protected"));
check("the default install registers an unelevated per-user task", DEFAULT.includes("-RunLevel Limited"));
check(
  "the default install never asks for elevation",
  !/-Verb RunAs/.test(DEFAULT) && !/-RunLevel Highest/.test(DEFAULT),
);
check(
  "a stop stays stopped: the default task does not restart itself",
  !/-RestartCount/.test(DEFAULT) && !/RestartInterval/.test(DEFAULT),
);
check(
  "the protected install warns that it cannot be stopped by ordinary programs",
  /cannot be stopped by ordinary programs/i.test(install),
);
check(
  "the launcher reads the protected marker, so only -Protected installs elevate",
  launcherCs.includes("IsProtectedInstall") &&
    launcherCs.includes('Path.Combine(ExeDir, "PocketDesk.ini")') &&
    /if \(!IsProtectedInstall\) \{ StartDaemonDetached\(\); return true; \}/.test(launcherCs) &&
    /Verb = "runas"/.test(launcherCs) &&
    /catch \(Win32Exception\) \{ return false; \}/.test(launcherCs),
);
check(
  "installers ask a running daemon to stop before killing it",
  ["install.ps1", "uninstall.ps1", path.join("daemon", "scripts", "install-service.ps1")].every((f) =>
    fs.readFileSync(path.join(REPO, f), "utf8").includes("127.0.0.1:4679/shutdown"),
  ),
);
check("the SYSTEM daemon leaves CLI port 4679 to the user daemon", /RH_CLI_PORT=(?!4679)\d+/.test(consoleCs));
// Only a -Protected install lives in Program Files and runs elevated; the default one runs from the
// user's own folder and needs no admin rights at all.
check(
  "the protected launcher runs from an admin-only Program Files copy",
  /\$protected = Join-Path \$env:ProgramFiles/.test(install) &&
    install.includes('New-ScheduledTaskAction -Execute $exe -Argument "--supervise"'),
);
check(
  "the launcher never takes node or ffmpeg from PATH",
  !/: "node"/.test(launcherCs) && launcherCs.includes('Path.Combine(ExeDir, "ffmpeg", "ffmpeg.exe")'),
);
check("the launcher drops NODE_* variables before starting node", launcherCs.includes('StartsWith("NODE_"'));
check(
  "the console install takes ownership of ProgramData\\PocketDesk",
  install.includes('icacls $pdRoot /setowner "*S-1-5-32-544"'),
);
// The pairing URL carries the master token, so it only goes to a listener proven to be this install.
check(
  "the launcher checks the daemon's certificate before opening pairing",
  launcherCs.includes("if (tls && !IsOurDaemon(port)) return;"),
);
check(
  "install.ps1 opens pairing through the launcher",
  !/Start-Process "\$\{scheme\}:\/\/localhost/.test(fs.readFileSync(path.join(REPO, "install.ps1"), "utf8")),
);

// What an uninstall must take with it, and the one thing it must ask about first.
const uninstall = fs.readFileSync(path.join(REPO, "uninstall.ps1"), "utf8");
check("uninstall removes the autostart task", /Unregister-ScheduledTask -TaskName \$task/.test(uninstall));
check(
  "uninstall removes the Start Menu shortcut",
  /GetFolderPath\("Programs"\)/.test(uninstall) && /PocketDesk\.lnk/.test(uninstall),
);
check(
  "uninstall removes the firewall rule",
  /Remove-NetFirewallRule -DisplayName "PocketDesk \(daemon\)"/.test(uninstall),
);
check("uninstall removes the machine policy file", /policy\.json/.test(uninstall));
check(
  "uninstall asks before deleting settings and paired phones",
  /Read-Host/.test(uninstall) && /\$KeepData/.test(uninstall) && /\$removeData = \$answer/.test(uninstall),
);
check(
  "the data folder is deleted only in the confirmed branch",
  uninstall
    .slice(0, uninstall.indexOf("if ($removeData)"))
    .indexOf('Join-Path $env:USERPROFILE ".pocketdesk"') < 0 &&
    uninstall
      .slice(uninstall.indexOf("if ($removeData)"))
      .includes('Join-Path $env:USERPROFILE ".pocketdesk"'),
);
check(
  "the console install checks who holds port 8766",
  install.includes("(Get-Process -Id $listener.OwningProcess).Path -ne"),
);
const trayCs = fs.readFileSync(path.join(REPO, "daemon", "scripts", "PocketDeskTray.cs"), "utf8");
check(
  "the launcher keeps no main window",
  !/new Form\(|ShowDialog\(/.test(launcherCs) && launcherCs.includes("CreateNoWindow = true"),
);
check(
  "the tray offers open, stop and uninstall",
  ["Open PocketDesk", "Stop PocketDesk", "Uninstall PocketDesk"].every((s) => trayCs.includes(s)),
);
check(
  "the tray disappears with the daemon, so it cannot claim a dead daemon",
  trayCs.includes("HasExited") && trayCs.includes("icon.Visible = false"),
);
check(
  "the first logon after install shows the notice once",
  trayCs.includes("tray-notified") && trayCs.includes("ShowBalloonTip"),
);
check(
  "the installer compiles the tray into the launcher",
  install.includes("PocketDeskTray.cs") && install.includes("/r:System.Windows.Forms.dll"),
);

// macOS and Linux follow the same rule: a hidden service, an app entry that opens the settings page.
const sh = fs.readFileSync(path.join(REPO, "install.sh"), "utf8");
const scripts = path.join(REPO, "daemon", "scripts");
check(
  "macOS has no menu-bar tray",
  !fs.existsSync(path.join(scripts, "mac", "PocketDeskTray.swift")) && !/swiftc/.test(sh),
);
check(
  "macOS runs the daemon as a LaunchAgent",
  /<string>__NODE__<\/string><string>src\/index.js<\/string>/.test(
    fs.readFileSync(path.join(scripts, "mac", "com.pocketdesk.daemon.plist"), "utf8"),
  ),
);
check(
  "Linux adds an app-menu entry that opens pairing",
  /Exec="__BIN__" pair/.test(fs.readFileSync(path.join(scripts, "linux", "pocketdesk.desktop"), "utf8")),
);
check(
  "services get the installing shell's PATH",
  sh.includes("s#__PATH__#$SVC_PATH#") &&
    fs.readFileSync(path.join(scripts, "linux", "pocketdesk.service"), "utf8").includes("PATH=__PATH__"),
);
check(
  "the program never clones into the config dir",
  /APP_DIR="\$INSTALL_DIR\/app"/.test(sh) && !sh.includes("heads/main"),
);
finish();
