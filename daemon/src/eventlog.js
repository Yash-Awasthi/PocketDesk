// PocketDesk's decisions in the Windows Application log, under the source "PocketDesk": start, stop
// and (from the policy work) refusals. A machine owner or an integrity client can then read what
// happened without guessing at our file layout. Best effort by design — a machine that refuses the
// write must not take the daemon down, and the failure is reported once, not on every event.
import { execFile, execFileSync } from "node:child_process";

const IS_WIN = process.platform === "win32";

/** Event ids are part of the published contract for anyone reading the log (docs/SETUP-PC.md). */
export const EVENT_IDS = { start: 1000, stop: 1001, policy: 1002, refused: 1003 };

let failed = false;

/** The argv for `eventcreate`, with the message flattened and bounded (the tool caps it, not nicely). */
export function eventArguments(id, message) {
  const text = String(message ?? "").replace(/\s+/g, " ").trim().slice(0, 900) || "PocketDesk event";
  return ["/L", "APPLICATION", "/T", "INFORMATION", "/SO", "PocketDesk", "/ID", String(id), "/D", text];
}

function note(error) {
  if (failed) return;
  failed = true;
  console.warn(`  eventlog  cannot write to the Application log (${error?.code || error?.message || error}); events go unrecorded`);
}

/**
 * Writes one event. Resolves true when it landed, false when this machine cannot take it.
 * `run` is injectable so the test can assert the call without touching the real log.
 */
export function logEvent(id, message, run = defaultRun) {
  if (!IS_WIN || failed) return Promise.resolve(false);
  return run(id, message);
}

/** The same write, synchronous: a stop is about to exit, so the event has to land first. */
export function logEventSync(id, message) {
  if (!IS_WIN || failed) return false;
  try {
    execFileSync("eventcreate", eventArguments(id, message), { stdio: "ignore", windowsHide: true, timeout: 4000 });
    return true;
  } catch (e) {
    note(e);
    return false;
  }
}

function defaultRun(id, message) {
  return new Promise((resolve) => {
    execFile("eventcreate", eventArguments(id, message), { windowsHide: true, timeout: 4000 }, (error) => {
      if (error) note(error);
      resolve(!error);
    });
  });
}
