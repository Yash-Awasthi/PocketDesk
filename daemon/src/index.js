import { loadConfig, saveConfig } from "./config.js";
import { start, closeClients } from "./server.js";
import { killAll, liveIds, stopReaper } from "./sessions.js";
import * as chat from "./chat.js";

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

  console.log("[shutdown] clean exit");
  // Gives the close frames a moment to leave before the sockets die with the process.
  setTimeout(() => process.exit(0), 500);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));
// Windows has no SIGTERM for a windowless child: the tray asks for a clean stop by closing stdin,
// which also happens when the tray itself dies, so the daemon never outlives it.
if (process.env.RH_STOP_ON_STDIN_EOF === "1") {
  process.stdin.on("end", () => gracefulShutdown("stdin closed"));
  process.stdin.resume();
}

const cfg = loadConfig();
start(cfg, {
  onTokenRotated(token) {
    cfg.token = token;
    if (!("RH_TOKEN" in process.env)) saveConfig(cfg);
  },
});
