import crypto from "node:crypto";
import { saveConfig } from "./config.js";

/**
 * Per-connection password and the control gate. The password is checked by the daemon on every
 * hello, so a leaked token or pairing QR alone cannot open a session — the phone must also prove
 * the password. The control gate forces every viewer to view-only when the PC owner turns it off.
 */
export function createAccess(cfg) {
  function hashPassword(plain) {
    const salt = crypto.randomBytes(16);
    const key = crypto.scryptSync(String(plain), salt, 32);
    return { salt: salt.toString("hex"), key: key.toString("hex") };
  }
  return {
    get hasPassword() {
      return Boolean(cfg.connPassword);
    },
    get controlAllowed() {
      return cfg.controlAllowed !== false;
    },
    /** The PC owner's master switch: off refuses every phone and browser, LAN and iroh alike. */
    get remoteOn() {
      return cfg.remoteOn !== false;
    },
    /** Set by the server to drop every connected client when remote access is switched off. */
    onRemoteChange: null,
    setRemoteOn(on) {
      const next = Boolean(on);
      const changed = next !== (cfg.remoteOn !== false);
      cfg.remoteOn = next;
      saveConfig(cfg);
      if (changed) this.onRemoteChange?.(next);
    },
    /** Set by the remote handlers to drop live controllers to view-only when control is paused. */
    onControlChange: null,
    setControlAllowed(on) {
      const next = Boolean(on);
      const changed = next !== (cfg.controlAllowed !== false);
      cfg.controlAllowed = next;
      saveConfig(cfg);
      if (changed) this.onControlChange?.(next);
    },
    /** Replace or clear (null/"") the connection password. */
    setPassword(plain) {
      cfg.connPassword = plain ? hashPassword(plain) : null;
      saveConfig(cfg);
    },
    /** Timing-safe check against the stored scrypt record. */
    verifyPassword(plain) {
      const rec = cfg.connPassword;
      if (!rec) return true;
      if (typeof plain !== "string" || !plain) return false;
      const want = Buffer.from(rec.key, "hex");
      const got = crypto.scryptSync(plain, Buffer.from(rec.salt, "hex"), 32);
      return got.length === want.length && crypto.timingSafeEqual(got, want);
    },
  };
}
