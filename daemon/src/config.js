import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const dir = path.join(os.homedir(), ".pocketdesk");
const file = path.join(dir, "config.json");

export function loadConfig() {
  fs.mkdirSync(dir, { recursive: true });
  let cfg = {};
  if (fs.existsSync(file)) {
    try {
      cfg = JSON.parse(fs.readFileSync(file, "utf8"));
    } catch {
      cfg = {};
    }
  }
  cfg.port = Number(process.env.RH_PORT || cfg.port || 8765);
  cfg.token = process.env.RH_TOKEN || cfg.token || crypto.randomBytes(24).toString("hex");
  if (!fs.existsSync(file) || !JSON.parse(fs.readFileSync(file, "utf8")).token) {
    fs.writeFileSync(file, JSON.stringify({ port: cfg.port, token: cfg.token }, null, 2));
  }
  return cfg;
}

export const configPath = file;
