import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { generateSelfSignedCert } from "./tls-gen.js";

// RH_HOME relocates every piece of daemon state (config, TLS, SSH keys) —
// tests set it so a run never touches the real profile.
const dir = process.env.RH_HOME || path.join(os.homedir(), ".pocketdesk");
const file = path.join(dir, "config.json");

export function loadConfig() {
  fs.mkdirSync(dir, { recursive: true });
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
  // pattern) must NOT inherit relay/TLS settings from the interactive config
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
  // Token crosses the LAN in the clear until TLS is on. Try to stand up a
  // self-signed cert on first run so wss:// is the default; if openssl isn't
  // around, stay on plaintext and warn loudly instead of silently exposing it.
  if (!envDriven && !cfg.tls.enabled && !fs.existsSync(cfg.tls.cert)) {
    if (generateSelfSignedCert(cfg.tls, dir)) {
      cfg.tls.enabled = true;
      saveConfig(cfg);
    } else {
      console.warn("[pocketdesk] TLS not enabled and no certificate found — the pairing token is crossing the LAN in plaintext.");
      console.warn("[pocketdesk] install openssl and restart, or run `npm run setup-tls`, to fix this.");
    }
  }
  // Off-LAN access: outbound relay link (dial OUT to a relay server — works
  // from any network with no port forwarding) and/or hosting one ourselves.
  // Explicit env vars win; RH_RELAY_PORT=0 (or empty) disables file config.
  const hasRelayUrl = "RH_RELAY_URL" in process.env;
  const hasRelayChannel = "RH_RELAY_CHANNEL" in process.env;
  const hasRelayPort = "RH_RELAY_PORT" in process.env;
  cfg.relay = {
    url: hasRelayUrl ? process.env.RH_RELAY_URL : envDriven ? "" : cfg.relay?.url || "",
    channel: hasRelayChannel ? process.env.RH_RELAY_CHANNEL : envDriven ? "" : cfg.relay?.channel || "",
    hostPort: hasRelayPort ? Number(process.env.RH_RELAY_PORT) || 0 : envDriven ? 0 : Number(cfg.relay?.hostPort) || 0,
  };
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
      relay: { url: cfg.relay?.url || "", channel: cfg.relay?.channel || "", hostPort: cfg.relay?.hostPort || 0 },
    }, null, 2),
    { mode: 0o600 },
  );
  try { fs.chmodSync(file, 0o600); } catch { /* Windows ACLs: best effort */ }
}

export const configDir = dir;
export const configPath = file;
