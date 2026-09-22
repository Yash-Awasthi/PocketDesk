import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";

const CANDIDATES = [
  ...process.env.PATH?.split(path.delimiter) ?? [],
  "C:\\Program Files\\Git\\usr\\bin",
  "C:\\Program Files\\Git\\mingw64\\bin",
].map((d) => path.join(d, process.platform === "win32" ? "openssl.exe" : "openssl"));

function findOpenssl() {
  for (const p of CANDIDATES) if (fs.existsSync(p)) return p;
  return null;
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

// Self-signed cert generation shared by `npm run setup-tls` and the daemon's
// own first-run auto-generation. Returns true on success, false if openssl
// isn't available (caller falls back to plaintext + a warning).
export function generateSelfSignedCert(tls, configDir) {
  const openssl = findOpenssl();
  if (!openssl) return false;

  fs.mkdirSync(path.dirname(tls.cert), { recursive: true });
  const host = os.hostname();
  const san = ["DNS:localhost", "IP:127.0.0.1", ...lanAddresses(), `DNS:${host}`].join(",");

  const r = spawnSync(openssl, [
    "req", "-x509", "-newkey", "rsa:2048", "-sha256", "-days", "3650", "-nodes",
    "-keyout", tls.key, "-out", tls.cert,
    "-subj", "/CN=pocketdesk",
    "-addext", `subjectAltName=${san}`,
  ], { stdio: "ignore" });

  if (r.status !== 0) return false;

  const pem = fs.readFileSync(tls.cert, "utf8");
  const fp = new crypto.X509Certificate(pem).fingerprint256.replace(/:/g, "").toLowerCase();
  fs.mkdirSync(path.join(configDir, "tls"), { recursive: true });
  fs.writeFileSync(path.join(configDir, "tls", "fingerprint.txt"), fp + "\n");
  return true;
}
