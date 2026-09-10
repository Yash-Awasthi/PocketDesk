import { loadConfig } from "./config.js";
import { start } from "./server.js";
import { killAll, liveIds, stopReaper } from "./sessions.js";

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

  const ids = liveIds();
  console.log(`\n[shutdown] ${signal} received — cleaning up ${ids.length} live session(s)`);

  const killed = killAll();
  if (killed > 0) {
    console.log(`[shutdown] killed ${killed} PTY session(s)`);
  }

  stopReaper();

  console.log("[shutdown] clean exit");
  process.exit(0);
}

process.on("SIGTERM", () => gracefulShutdown("SIGTERM"));
process.on("SIGINT", () => gracefulShutdown("SIGINT"));

start(loadConfig());
