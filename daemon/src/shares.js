/**
 * Session Shares — share a live terminal/chat session via a one-time token URL.
 *
 * Absorbed from ttyd/gotty (read-only spectators + N-viewer broadcast),
 * termpair (--read-only), tmate (ro/rw keys), tty-share (share URLs).
 *
 * A share is { token, sessionId, mode, expiresAt, maxViewers }.
 * mode "readonly" drops all client input for that socket; "readwrite" allows it.
 * The daemon enforces this server-side — spectators cannot inject keystrokes.
 */

import crypto from "node:crypto";

export function createShareManager({ defaultTtlMinutes = 60 } = {}) {
  const shares = new Map(); // token -> share

  function sweep() {
    const now = Date.now();
    for (const [token, s] of shares) {
      if (s.expiresAt && now > s.expiresAt) shares.delete(token);
    }
  }

  function create({ sessionId, mode = "readonly", ttlMinutes, maxViewers = 8 }) {
    sweep();
    const token = crypto.randomBytes(16).toString("base64url");
    const ttl = (Number(ttlMinutes) > 0 ? Number(ttlMinutes) : defaultTtlMinutes) * 60_000;
    const share = {
      token,
      sessionId,
      mode: mode === "readwrite" ? "readwrite" : "readonly",
      maxViewers: Math.max(1, Number(maxViewers) || 8),
      createdAt: Date.now(),
      expiresAt: Date.now() + ttl,
    };
    shares.set(token, share);
    return share;
  }

  function resolve(token) {
    sweep();
    return shares.get(String(token || "")) || null;
  }

  function revoke(token) {
    return shares.delete(String(token || ""));
  }

  function revokeSession(sessionId) {
    for (const [token, s] of shares) if (s.sessionId === sessionId) shares.delete(token);
  }

  function list() {
    sweep();
    return [...shares.values()].map(({ token, ...rest }) => ({
      token: token.slice(0, 6) + "…",
      ...rest,
    }));
  }

  return { create, resolve, revoke, revokeSession, list };
}
