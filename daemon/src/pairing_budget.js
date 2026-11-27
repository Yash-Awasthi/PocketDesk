// Wrong-token budget for the pre-auth hello: a slow guesser is throttled, not locked out forever.
// Keyed by client IP; state lives only as long as the daemon process.

const FREE = 10;
const FORGET_MS = 15 * 60 * 1000;
const CAP_MS = 300 * 1000;
const MAX_KEYS = 1000;
const entries = new Map();

function live(key, now) {
  const e = entries.get(key);
  if (!e) return null;
  if (now - e.lastFail > FORGET_MS) {
    entries.delete(key);
    return null;
  }
  return e;
}

/** False while this key sits in a backoff window after too many wrong tokens. */
export function allowed(key, now = Date.now()) {
  const e = live(key, now);
  return !e || now >= e.lockedUntil;
}

/** Count one wrong token and, past the free attempts, extend the lock. */
export function fail(key, now = Date.now()) {
  const e = live(key, now) || { failures: 0, lastFail: now, lockedUntil: 0 };
  entries.set(key, e);
  e.failures += 1;
  e.lastFail = now;
  // 10th failure locks for 1s, then 2s, 4s, ... capped at 5 minutes.
  if (e.failures >= FREE) e.lockedUntil = now + Math.min(CAP_MS, 1000 * 2 ** (e.failures - FREE));
  prune(now);
  return state(key, now);
}

/** A correct token wipes the key's history. */
export function succeed(key) {
  entries.delete(key);
}

export function reset() {
  entries.clear();
}

/** Snapshot for tests: failure count, lock expiry, and time left on the lock. */
export function state(key, now = Date.now()) {
  const e = live(key, now);
  if (!e) return { failures: 0, lockedUntil: 0, retryIn: 0 };
  return { failures: e.failures, lockedUntil: e.lockedUntil, retryIn: Math.max(0, e.lockedUntil - now) };
}

function prune(now) {
  if (entries.size <= MAX_KEYS) return;
  // Stale and unlocked keys go first so a locked attacker is not evicted by fresh noise.
  for (const [k, e] of entries) {
    if (entries.size <= MAX_KEYS) return;
    if (now - e.lastFail > FORGET_MS || now >= e.lockedUntil) entries.delete(k);
  }
  while (entries.size > MAX_KEYS) entries.delete(entries.keys().next().value);
}
