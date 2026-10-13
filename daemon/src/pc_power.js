// Lock, sign out, sleep, restart and shut down the PC from the phone.
import { execFile } from "node:child_process";

const COMMANDS = {
  win32: {
    lock: ["rundll32.exe", ["user32.dll,LockWorkStation"]],
    signout: ["shutdown.exe", ["/l"]],
    sleep: ["rundll32.exe", ["powrprof.dll,SetSuspendState", "0,1,0"]],
    restart: ["shutdown.exe", ["/r", "/t", "5"]],
    shutdown: ["shutdown.exe", ["/s", "/t", "5"]],
  },
  linux: {
    lock: ["loginctl", ["lock-session"]],
    signout: ["loginctl", ["terminate-user", process.env.USER || ""]],
    sleep: ["systemctl", ["suspend"]],
    restart: ["systemctl", ["reboot"]],
    shutdown: ["systemctl", ["poweroff"]],
  },
  darwin: {
    lock: ["pmset", ["displaysleepnow"]],
    signout: ["osascript", ["-e", 'tell application "System Events" to log out']],
    sleep: ["pmset", ["sleepnow"]],
    restart: ["osascript", ["-e", 'tell application "System Events" to restart']],
    shutdown: ["osascript", ["-e", 'tell application "System Events" to shut down']],
  },
};

export function command(action, platform = process.platform) {
  return COMMANDS[platform]?.[action] || null;
}

/**
 * Resolves { ok, error? }. RH_POWER_DRY answers without touching the PC, for tests.
 * lockMac locks a Mac through the desktop helper: pmset only sleeps the display, which
 * locks nothing unless the Mac asks for a password straight after sleep.
 */
export async function run(action, { platform = process.platform, lockMac } = {}) {
  const cmd = command(String(action), platform);
  if (!cmd) return { ok: false, error: `unsupported: ${action}` };
  const realLock = platform === "darwin" && action === "lock" && lockMac;
  if (process.env.RH_POWER_DRY) return { ok: true, dry: realLock ? "helper" : cmd[0] };
  if (realLock && (await lockMac().catch(() => null))?.ok) return { ok: true };
  return new Promise((resolve) => {
    execFile(cmd[0], cmd[1], { windowsHide: true, timeout: 15000 }, (err, _out, stderr) =>
      resolve(err ? { ok: false, error: String(stderr).trim() || err.message } : { ok: true }));
  });
}
