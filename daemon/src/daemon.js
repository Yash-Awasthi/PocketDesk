import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { loadConfig, saveConfig } from "./config.js";
import { start, closeClients } from "./server.js";
import { killAll, liveIds, stopReaper } from "./sessions.js";
import * as chat from "./chat.js";
import { EVENT_IDS, logEvent, logEventSync } from "./eventlog.js";

// ps, Activity Monitor and system monitors list the daemon by this name instead of "node".
process.title = process.env.RH_CONSOLE ? "PocketDeskConsole" : "PocketDesk";

/**
 * The installer ships ffmpeg beside the daemon (<root>\ffmpeg), but the video stream, the recorder,
 * the webcam and PC audio all read the binary from PATH. Point them at the bundled copy when nobody
 * chose one, so a PC without ffmpeg installed still gets the H.264 stream instead of slow JPEG
 * frames. FFMPEG_PATH from the environment (or a service manager) always wins.
 */
function useBundledFfmpeg() {
  if (process.env.FFMPEG_PATH) return;
  const exe = process.platform === "win32" ? "ffmpeg.exe" : "ffmpeg";
  const daemonDir = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const candidates = [
    path.join(path.dirname(daemonDir), "ffmpeg", exe), // <install root>\ffmpeg, normal and protected copy
    path.join(daemonDir, "ffmpeg", exe),
    path.join(process.env.LOCALAPPDATA || "", "PocketDesk", "ffmpeg", exe),
  ];
  for (const p of candidates) {
    try {
      if (fs.existsSync(p)) {
        process.env.FFMPEG_PATH = p;
        return;
      }
    } catch {
      /* try the next */
    }
  }
}
useBundledFfmpeg();

// Surviving a stray rejection keeps the unsupervised user daemon alive; uncaughtException is left
// to crash on purpose so an agent's child processes die with it (see crash-kills-agents test).
// ponytail: a crash exits non-zero, so the task's failure restart brings it back; a deliberate
// stop exits 0, so the task does not restart it.
process.on("unhandledRejection", (e) =>
  console.error(`[warn] unhandled rejection (kept alive): ${e?.stack || e}`),
);

// ── Graceful shutdown ───────────────────────────────────────────────────────
// On SIGTERM/SIGINT: kill all live PTY sessions (no orphaned children), stop
// the session reaper, and exit cleanly. Synchronous so the signal doesn't
// terminate the process before cleanup completes. A second signal forces
// an immediate exit.
let _shuttingDown = false;

function gracefulShutdown(signal) {
  if (_shuttingDown) {
    process.exit(1);
  }
  _shuttingDown = true;

  // 4100 tells the phone the PC stopped on purpose, so it shows why and does not keep retrying.
  closeClients(4100, "PocketDesk was stopped on the PC");
  const ids = liveIds();
  console.log(`\n[shutdown] ${signal} received — cleaning up ${ids.length} live session(s)`);

  const killed = killAll();
  if (killed > 0) {
    console.log(`[shutdown] killed ${killed} PTY session(s)`);
  }

  chat.killAll();
  stopReaper();

  // Synchronous: the process exits in 500 ms, and a stop the machine owner can read afterwards is
  // the whole point of writing it down.
  logEventSync(EVENT_IDS.stop, `PocketDesk stopped (${signal}); ${killed} terminal session(s) closed`);

  console.log("[shutdown] clean exit");
  // Gives the close frames a moment to leave before the sockets die with the process.
  setTimeout(() => process.exit(0), 500);
}

// A crash skips gracefulShutdown; "exit" still runs, and both kills are synchronous and idempotent.
process.on("exit", () => {
  killAll();
  chat.killAll();
});

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
// Windows has no SIGTERM for a windowless child: a launcher asks for a clean stop by closing
// stdin, which also happens when that launcher dies, so the daemon never outlives it.
if (process.env.RH_STOP_ON_STDIN_EOF === "1") {
  process.stdin.on("end", () => gracefulShutdown("stdin closed"));
  process.stdin.resume();
}

const cfg = loadConfig();
logEvent(
  EVENT_IDS.start,
  `PocketDesk started: port ${cfg.port}${process.env.RH_CONSOLE ? ", console endpoint" : ""}, pid ${process.pid}`,
);
start(cfg, {
  onTokenRotated(token) {
    cfg.token = token;
    if (!("RH_TOKEN" in process.env)) saveConfig(cfg);
  },
});
