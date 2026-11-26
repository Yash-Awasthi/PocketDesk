// The regression oracle for "be closeable": a native lockdown / remote-management client enumerates
// PocketDesk, kills every process it owns with ordinary unelevated rights, and requires that nothing
// is left and nothing comes back. Against an install whose task runs Highest with RestartCount 3 this
// fails, because the killed daemon is back within a minute.
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { spawn } from "node:child_process";
import { REPO, check, finish, makeTmp, startDaemon } from "./helpers.mjs";

const PORT = 8844,
  CLI = 8845;
const manifests = makeTmp("rh-lockdown-");
const home = path.join(os.tmpdir(), "rh-home-lockdown-" + process.pid);
fs.mkdirSync(path.join(home, "helpers"), { recursive: true });

const WIN = process.platform === "win32";
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};
const listening = (p) =>
  new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port: p });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(500);
    s.once("connect", () => done(true));
    s.once("timeout", () => done(false));
    s.once("error", () => done(false));
  });
const treeKill = (pid) => {
  try {
    WIN
      ? execFileSync("taskkill", ["/T", "/F", "/PID", String(pid)], { stdio: "ignore" })
      : process.kill(pid, "SIGKILL");
  } catch {}
};

/** Every process this machine still attributes to PocketDesk: by name, by data-folder helper path. */
function pocketdeskProcesses() {
  if (!WIN) {
    // Portable fallback: the pids this test knows about.
    return [d.pid, helper.pid].filter(alive);
  }
  const script =
    `$h='${path.join(home, "helpers")}';` +
    "Get-CimInstance Win32_Process | Where-Object {" +
    " $_.Name -like 'PocketDesk*' -or $_.Name -eq 'PocketDesk.exe'" +
    ` -or ($_.CommandLine -and $_.CommandLine.IndexOf($h, [StringComparison]::OrdinalIgnoreCase) -ge 0) } |` +
    " Select-Object -ExpandProperty ProcessId;" +
    // A client does not have to know the exe name: whoever listens on the port is the daemon.
    `Get-NetTCPConnection -State Listen -LocalPort ${PORT},${CLI} -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess`;
  try {
    return execFileSync("powershell", ["-NoProfile", "-NonInteractive", "-Command", script], {
      encoding: "utf8",
    })
      .split(/\r?\n/)
      .map((s) => Number(s.trim()))
      .filter((n) => n > 0);
  } catch {
    return [];
  }
}

// The autostart policy the default install registers. A client can kill a process; it cannot kill a
// task that puts it back, which is why this is part of the oracle and not a separate nicety.
const installer = fs.readFileSync(path.join(REPO, "daemon", "scripts", "install-service.ps1"), "utf8");
const DEFAULT = installer.slice(installer.indexOf("# Default install:"));
check("the default autostart runs at the user's own level", DEFAULT.includes("-RunLevel Limited"));
check(
  "the default autostart has no restart policy, so a kill is final",
  !/-RestartCount/.test(DEFAULT) && !/RestartInterval/.test(DEFAULT),
);

// A process shaped like a capture helper: started from the data folder, not a child of the daemon.
const helper = spawn(
  process.execPath,
  ["-e", "setInterval(() => {}, 1e6)", path.join(home, "helpers", "input.ps1")],
  { detached: true, stdio: "ignore" },
);
const d = startDaemon(PORT, CLI, { home, manifests, dataDir: ".pocketdesk-test-" + PORT });
try {
  await d.ready;
  check("the daemon is running with a helper beside it", alive(d.pid) && alive(helper.pid));
  check("the client can see the daemon", pocketdeskProcesses().includes(d.pid));

  // 1. Enumerate and kill, unelevated — the whole client story.
  const found = pocketdeskProcesses();
  for (const pid of found) treeKill(pid);
  // Wait for the processes to actually go, instead of sleeping a fixed 1.5 s: on a loaded
  // machine a killed tree takes longer than that to stop answering (measured 2026-11-24).
  for (let i = 0; i < 40 && !(alive(d.pid) === false && alive(helper.pid) === false); i++) {
    await new Promise((r) => setTimeout(r, 250));
  }

  // 2. Nothing is left.
  const left = pocketdeskProcesses().filter((pid) => alive(pid));
  check(`nothing is left${left.length ? ": " + left.join(", ") : ""}`, left.length === 0);
  check("the daemon is gone", !alive(d.pid));
  check("the helper is gone", !alive(helper.pid));

  // 3. Nothing comes back on its own.
  await new Promise((r) => setTimeout(r, 4000));
  const back = pocketdeskProcesses().filter((pid) => alive(pid));
  check(`nothing came back${back.length ? ": " + back.join(", ") : ""}`, back.length === 0);
  check("the daemon port stays closed", !(await listening(PORT)));
} catch (e) {
  check(`no error (${e.message})`, false);
} finally {
  try {
    d.kill("SIGKILL");
  } catch {}
  try {
    process.kill(helper.pid);
  } catch {}
  try {
    fs.rmSync(home, { recursive: true, force: true });
  } catch {}
  try {
    fs.rmSync(manifests, { recursive: true, force: true });
  } catch {}
}
finish();
