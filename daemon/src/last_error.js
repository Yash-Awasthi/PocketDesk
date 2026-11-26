// The newest error the daemon saw, kept in memory so /health can name it.
// No disk I/o: one restart forgets it, and a health probe never waits on a file.
import { redact } from "./logbook.js";

export const MAX_CHARS = 200;

/** @type {{ message: string, scope: string, at: string } | null} */
let current = null;

/** Keep the newest error only: [message] cut to MAX_CHARS first, then scrubbed of tokens and this machine's home folder. */
export function recordLastError(scope, message, now = Date.now()) {
  if (typeof message !== "string") return null;
  const text = message.trim();
  if (!text) return null;
  const short = text.length > MAX_CHARS ? text.slice(0, MAX_CHARS) : text;
  current = {
    message: /** @type {string} */ (redact(short)),
    scope: typeof scope === "string" && scope ? scope : "daemon",
    at: new Date(now).toISOString(),
  };
  return current;
}

/** The newest error as { message, scope, at }, or null after a clean start. */
export function lastError() {
  return current ? { ...current } : null;
}
