// The newest error the daemon saw, kept in memory so /health can name it.
// No disk I/o: one restart forgets it, and a health probe never waits on a file.
import { redact } from "./logbook.js";

export const MAX_CHARS = 200;

/** @type {{ message: string, scope: string, at: string } | null} */
let current = null;

/** Keep the newest error only: [message] scrubbed of tokens and this machine's home folder first, then cut to MAX_CHARS. */
export function recordLastError(scope, message, now = Date.now()) {
  if (typeof message !== "string") return null;
  const text = message.trim();
  if (!text) return null;
  const scrubbed = /** @type {string} */ (redact(text));
  current = {
    message: scrubbed.slice(0, MAX_CHARS),
    scope: typeof scope === "string" && scope ? scope : "daemon",
    at: new Date(now).toISOString(),
  };
  return current;
}

/** The newest error as { message, scope, at }, or null after a clean start. */
export function lastError() {
  return current ? { ...current } : null;
}
