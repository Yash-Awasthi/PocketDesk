import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { loadConfig, saveConfig, configDir } from "../src/config.js";

const CANDIDATES = [
  ...process.env.PATH?.split(";") ?? [],
  "C:\\Program Files\\Git\\usr\\bin",
  "C:\\Program Files\\Git\\mingw64\\bin",
].map((d) => path.join(d, "openssl.exe"));

function findOpenssl() {
  for (const p of CANDIDATES) if (fs.existsSync(p)) return p;
  throw new Error("openssl.exe not found; install Git for Windows or add openssl to PATH");
}

function lanAddresses() {
  const out = [];
  for (const list of Object.values(os.networkInterfaces())) {
    for (const ni of list ?? []) {
      if (ni.family === "IPv4" && !ni.internal) out.push(`IP:${ni.address}`);
    }
  }
  return out;
}

const cfg = loadConfig();
fs.mkdirSync(path.dirname(cfg.tls.cert), { recursive: true });
const openssl = findOpenssl();
const host = os.hostname();
const san = ["DNS:localhost", "IP:127.0.0.1", ...lanAddresses(), `DNS:${host}`].join(",");

const r = spawnSync(openssl, [
  "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "3650", "-nodes",
  "-keyout", cfg.tls.key, "-out", cfg.tls.cert,
  "-subj", "/CN=pocketdesk",
  "-addext", `subjectAltName=${san}`,
], { stdio: "ignore" });

if (r.status !== 0) {
  console.error("certificate generation failed");
  process.exit(1);
}

cfg.tls.enabled = true;
saveConfig(cfg);

const pem = fs.readFileSync(cfg.tls.cert, "utf8");
const fp = new crypto.X509Certificate(pem).fingerprint256.replace(/:/g, "").toLowerCase();
fs.writeFileSync(path.join(configDir, "tls", "fingerprint.txt"), fp + "\n");

console.log("self-signed certificate written to " + path.dirname(cfg.tls.cert));
console.log("tls enabled in config; daemon will serve wss:// on next start");
console.log("sha-256 fingerprint (pin this in the app if you want strict checking):");
console.log("  " + fp);
