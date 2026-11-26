// `pocketdesk --status`: what is running, as whom, on which ports, from which folder, and what
// happens when it dies. Every line is measured on this machine right now — a status that guesses is
// worse than no status, because it is what a person checks before handing the PC to someone else.
import fs from "node:fs";
import os from "node:os";
import net from "node:net";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const DATA_DIR = process.env.RH_HOME || path.join(os.homedir(), ".pocketdesk");

/** A daemon port from the config, the environment, or the documented default. */
export function daemonPort() {
  if (process.env.RH_PORT) return Number(process.env.RH_PORT);
  try {
    return Number(JSON.parse(fs.readFileSync(path.join(DATA_DIR, "config.json"), "utf8")).port) || 8765;
  } catch {
    return 8765;
  }
}

/** True while something is listening on the loopback port. */
export function listening(port) {
  return new Promise((resolve) => {
    const s = net.connect({ host: "127.0.0.1", port });
    const done = (v) => {
      s.destroy();
      resolve(v);
    };
    s.setTimeout(500);
    s.once("connect", () => done(true));
    s.once("timeout", () => done(false));
    s.once("error", () => done(false));
  });
}

/** The scheduled task's XML, or "" when there is no such task (not installed, or not Windows). */
export function taskXml(name = "PocketDesk") {
  if (process.platform !== "win32") return "";
  try {
    return execFileSync("schtasks", ["/Query", "/TN", name, "/XML"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      windowsHide: true,
    });
  } catch {
    return "";
  }
}

/** The parts of a task definition that decide whether a stop is a stop. Exported for the test. */
export function parseTaskXml(xml) {
  if (!xml) return null;
  const level = /<RunLevel>(\w+)<\/RunLevel>/i.exec(xml)?.[1] || "";
  const count = /<RestartOnFailure>[\s\S]*?<Count>(\d+)<\/Count>/i.exec(xml)?.[1];
  const interval = /<RestartOnFailure>[\s\S]*?<Interval>([^<]+)<\/Interval>/i.exec(xml)?.[1] || "";
  // "Highest" and "HighestAvailable" both mean the task may hold a full token.
  return {
    elevated: /highest/i.test(level),
    runLevel: level,
    restarts: count ? Number(count) : 0,
    interval: humanInterval(interval),
  };
}

/** ISO-8601 (PT1M, PT1H30M) to what a person reads. */
function humanInterval(iso) {
  const m = /^P(?:(\d+)D)?T(?:(\d+)H)?(?:(\d+)M)?/i.exec(iso || "");
  if (!m) return iso;
  const parts = [m[1] && `${m[1]} d`, m[2] && `${m[2]} h`, m[3] && `${m[3]} min`].filter(Boolean);
  return parts.length ? parts.join(" ") : iso;
}

/** True when this process holds a full (elevated) token: the high mandatory level on Windows. */
export function isElevated() {
  if (process.platform !== "win32") return typeof process.getuid === "function" && process.getuid() === 0;
  try {
    return /S-1-16-12288/.test(
      execFileSync("whoami", ["/groups"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        windowsHide: true,
      }),
    );
  } catch {
    return false;
  }
}

function autoStart() {
  if (process.platform === "win32") return parseTaskXml(taskXml());
  if (
    process.platform === "darwin" &&
    fs.existsSync(path.join(os.homedir(), "Library", "LaunchAgents", "com.pocketdesk.daemon.plist"))
  )
    return { runLevel: "launchd", elevated: false, restarts: 0, interval: "" };
  if (
    process.platform === "linux" &&
    fs.existsSync(path.join(os.homedir(), ".config", "systemd", "user", "pocketdesk.service"))
  )
    return { runLevel: "systemd", elevated: false, restarts: 0, interval: "" };
  return null;
}

/** The five lines `--status` promises, in order, plus whether anything is running. */
export async function statusLines() {
  const port = daemonPort();
  const task = autoStart();
  const elevated = task ? task.elevated : isElevated();
  const lines = [
    `elevated: ${elevated ? "yes — ordinary programs cannot stop the daemon" : "no — the daemon runs with your rights"}`,
    task
      ? `auto-start: yes — ${process.platform === "win32" ? `scheduled task 'PocketDesk' (${task.runLevel})` : task.runLevel}`
      : "auto-start: no — no autostart entry is installed",
    task && task.restarts
      ? `restart policy: ${task.restarts} restart${task.restarts === 1 ? "" : "s"}${task.interval ? ", " + task.interval + " apart" : ""}`
      : "restart policy: none — a stop stays stopped",
    `ports: ${port} daemon, ${port + 10} loopback page, ${Number(process.env.RH_CLI_PORT) || 4679} cli`,
    `data: ${DATA_DIR}`,
  ];
  const up = await listening(port);
  lines.push(`running: ${up ? "yes" : "no"}`);
  return lines;
}
