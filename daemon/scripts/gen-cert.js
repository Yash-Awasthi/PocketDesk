import fs from "node:fs";
import path from "node:path";
import { loadConfig, saveConfig, configDir } from "../src/config.js";
import { generateSelfSignedCert } from "../src/tls-gen.js";

// `npm run setup-tls` always writes a fresh cert — same call loadConfig()
// makes on an auto-generating first run, run again here deliberately so
// rotating an existing cert works too.
const cfg = loadConfig();

if (!generateSelfSignedCert(cfg.tls, configDir)) {
  console.error("certificate generation failed: openssl.exe not found; install Git for Windows or add openssl to PATH");
  process.exit(1);
}

cfg.tls.enabled = true;
saveConfig(cfg);

const fp = fs.readFileSync(path.join(configDir, "tls", "fingerprint.txt"), "utf8").trim();
console.log("self-signed certificate written to " + path.dirname(cfg.tls.cert));
console.log("tls enabled in config; daemon will serve wss:// on next start");
console.log("sha-256 fingerprint (pin this in the app if you want strict checking):");
console.log("  " + fp);
