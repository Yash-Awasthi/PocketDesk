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
  if (!persisted && !fromEnv("RH_PORT") && !fromEnv("RH_TOKEN")) saveConfig(cfg);
  return cfg;
}

export function saveConfig(cfg) {
  fs.writeFileSync(
    file,
    JSON.stringify({ port: cfg.port, token: cfg.token, tls: { enabled: cfg.tls.enabled, cert: cfg.tls.cert, key: cfg.tls.key } }, null, 2),
  );
}

export const configDir = dir;
export const configPath = file;
