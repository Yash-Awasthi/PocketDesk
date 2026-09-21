import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const dir = path.join(os.homedir(), ".pocketdesk");
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
  cfg.port = Number(process.env.RH_PORT || cfg.port || 8765);
  cfg.token = process.env.RH_TOKEN || cfg.token || crypto.randomBytes(24).toString("hex");
  const tlsDir = path.join(dir, "tls");
  cfg.tls = {
    enabled: Boolean(cfg.tls?.enabled),
    cert: cfg.tls?.cert || path.join(tlsDir, "cert.pem"),
    key: cfg.tls?.key || path.join(tlsDir, "key.pem"),
  };
  // Off-LAN access: outbound relay link (dial OUT to a relay server — works
  // from any network with no port forwarding) and/or hosting one ourselves.
  // Explicit env vars win; RH_RELAY_PORT=0 (or empty) disables file config.
  const hasRelayUrl = "RH_RELAY_URL" in process.env;
  const hasRelayChannel = "RH_RELAY_CHANNEL" in process.env;
  const hasRelayPort = "RH_RELAY_PORT" in process.env;
  // A fully env-driven launch (both RH_PORT and RH_TOKEN set — the test/CI
  // pattern) must NOT inherit relay settings from the interactive config
  // file, or every spawned test daemon fights the live one for the port.
  const envDriven = fromEnv("RH_PORT") && fromEnv("RH_TOKEN");
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
