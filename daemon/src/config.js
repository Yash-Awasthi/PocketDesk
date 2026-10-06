import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { execSync } from "node:child_process";
import { generateSelfSignedCert } from "./tls-gen.js";

// RH_HOME relocates every piece of daemon state (config, TLS, SSH keys) —
// tests set it so a run never touches the real profile.
const dir = process.env.RH_HOME || path.join(os.homedir(), ".pocketdesk");
const file = path.join(dir, "config.json");

export function loadConfig() {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  // Holds tokens, keys, transcripts and recordings; mkdir's mode is ignored when the dir already exists.
  if (process.platform !== "win32") try { fs.chmodSync(dir, 0o700); } catch { /* not ours to change */ }
  // The console endpoint's token opens a SYSTEM daemon, so only Administrators (S-1-5-32-544)
  // and SYSTEM (S-1-5-18) may read its folder. Well-known SIDs keep this locale-independent.
  if (process.env.RH_CONSOLE && process.platform === "win32") {
    try {
      execSync(`icacls "${dir}" /inheritance:r /grant *S-1-5-32-544:(OI)(CI)F /grant *S-1-5-18:(OI)(CI)F`, { stdio: "ignore", windowsHide: true });
    } catch { /* best effort, like the chmod below */ }
  }
  let cfg = {};
  let persisted = null;
  if (fs.existsSync(file)) {
    try {
      persisted = JSON.parse(fs.readFileSync(file, "utf8"));
      cfg = persisted;
    } catch {
      cfg = {};
    }
  }
  const fromEnv = (key) => key in process.env;
  // A fully env-driven launch (both RH_PORT and RH_TOKEN set — the test/CI
  // pattern) must NOT inherit TLS or iroh settings from the interactive config
  // file, or every spawned test daemon fights the live one for the port, or
  // picks up wss:// when the test harness expects plain http.
  const envDriven = fromEnv("RH_PORT") && fromEnv("RH_TOKEN");
  cfg.port = Number(process.env.RH_PORT || cfg.port || 8765);
  cfg.token = process.env.RH_TOKEN || cfg.token || crypto.randomBytes(24).toString("hex");
  const tlsDir = path.join(dir, "tls");
  cfg.tls = {
    enabled: envDriven ? false : Boolean(cfg.tls?.enabled),
    cert: cfg.tls?.cert || path.join(tlsDir, "cert.pem"),
    key: cfg.tls?.key || path.join(tlsDir, "key.pem"),
  };
  // Token crosses the LAN in the clear until TLS is on, so a self-signed cert
  // is made on first run; only a failed write leaves plaintext, and warns.
  if (!envDriven && !cfg.tls.enabled && !fs.existsSync(cfg.tls.cert)) {
    if (generateSelfSignedCert(cfg.tls, dir)) {
      cfg.tls.enabled = true;
      saveConfig(cfg);
    } else if (process.env.RH_CONSOLE) {
      throw new Error("console endpoint needs TLS: its token opens a SYSTEM daemon. Certificate generation failed; see the warning above.");
    } else {
      console.warn("[pocketdesk] TLS not enabled and no certificate found — the pairing token is crossing the LAN in plaintext.");
      console.warn("[pocketdesk] run `npm run setup-tls` to fix this.");
    }
  }
  // iroh: reach this PC by key from any network. RH_IROH=0 disables, RH_IROH=local
  // keeps it direct-only (tests), RH_IROH_RELAYS takes comma-separated relay URLs.
  const irohEnv = process.env.RH_IROH;
  cfg.iroh = {
    enabled: irohEnv !== undefined ? irohEnv !== "0" : envDriven ? false : cfg.iroh?.enabled !== false,
    relays: irohEnv === "local" ? "off"
      : "RH_IROH_RELAYS" in process.env ? process.env.RH_IROH_RELAYS.split(",").map((s) => s.trim()).filter(Boolean)
      : Array.isArray(cfg.iroh?.relays) ? cfg.iroh.relays : [],
  };
  // Per-connection password (scrypt record) and the control gate survive restarts.
  cfg.connPassword = cfg.connPassword ?? null;
  cfg.controlAllowed = cfg.controlAllowed !== false;
  // No password means the pairing token alone is full remote control forever: worth a loud nudge
  // every start, since nothing else in the flow forces one (the pair page can set it, see /access).
  if (!envDriven && !cfg.connPassword) {
    console.warn("[pocketdesk] no connection password set — anyone with the pairing token (QR, console, token file) gets full control.");
    console.warn("[pocketdesk] set one from the pairing page (the lock icon) or POST /access/password.");
  }
  if (!persisted && !fromEnv("RH_PORT") && !fromEnv("RH_TOKEN")) saveConfig(cfg);
  return cfg;
}

export function saveConfig(cfg) {
  // 0600: this file holds the pairing token.
  fs.writeFileSync(
    file,
    JSON.stringify({
      port: cfg.port,
      token: cfg.token,
      tls: { enabled: cfg.tls.enabled, cert: cfg.tls.cert, key: cfg.tls.key },
      iroh: { enabled: cfg.iroh?.enabled !== false, relays: Array.isArray(cfg.iroh?.relays) ? cfg.iroh.relays : [] },
      connPassword: cfg.connPassword ?? null,
      controlAllowed: cfg.controlAllowed !== false,
    }, null, 2),
    { mode: 0o600 },
  );
  try { fs.chmodSync(file, 0o600); } catch { /* Windows ACLs: best effort */ }
}

export const configDir = dir;
export const configPath = file;
