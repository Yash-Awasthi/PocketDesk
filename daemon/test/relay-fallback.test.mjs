// Relay fallback: the docs explain direct-only operation, and config.json
// "relays": "off" reaches the direct-only bind in iroh_link.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { check, finish, REPO } from "./helpers.mjs";

const daemon = path.join(REPO, "daemon");

// 1. The docs carry a fallback section with every supported escape hatch.
const relayDoc = fs.readFileSync(path.join(REPO, "docs", "RELAY.md"), "utf8");
const heading = relayDoc.indexOf("## When the relay is unreachable");
check("docs/RELAY.md has a \"When the relay is unreachable\" section", heading >= 0);
const section = heading >= 0 ? relayDoc.slice(heading) : "";
check("the section mentions \"relays\": \"off\"", section.includes('"relays": "off"'));
check("the section mentions direct connections", section.includes("direct"));
check("the section mentions RH_IROH=local", section.includes("RH_IROH=local"));

// 2. loadConfig reads "relays": "off" from config.json (env-driven, no TLS run).
const home = fs.mkdtempSync(path.join(os.tmpdir(), "rh-relay-off-"));
try {
  fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ iroh: { enabled: true, relays: "off" } }));
  const env = { ...process.env, RH_HOME: home, RH_PORT: "18765", RH_TOKEN: "relay-token" };
  delete env.RH_IROH;
  delete env.RH_IROH_RELAYS;
  const out = execFileSync(process.execPath, [
    "--input-type=module",
    "-e",
    'const c=await import("./src/config.js"); process.stdout.write(JSON.stringify(c.loadConfig().iroh))',
  ], { cwd: daemon, env, encoding: "utf8" });
  const iroh = JSON.parse(out);
  check("loadConfig parses config.json relays \"off\" as direct-only", iroh.relays === "off");

  // 3. saveConfig writes the setting back, keeps arrays, and drops junk to [].
  process.env.RH_HOME = home;
  const { saveConfig } = await import("../src/config.js");
  const tls = { enabled: false, cert: path.join(home, "cert.pem"), key: path.join(home, "key.pem") };
  saveConfig({ port: 18765, token: "relay-token", tls, iroh: { enabled: true, relays: "off" } });
  const saved = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  check("saveConfig round-trips relays \"off\"", saved.iroh.relays === "off");

  saveConfig({ port: 18765, token: "relay-token", tls, iroh: { enabled: true, relays: ["https://relay.example.com"] } });
  const savedArray = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  check("saveConfig preserves a relay URL array", Array.isArray(savedArray.iroh.relays)
    && savedArray.iroh.relays[0] === "https://relay.example.com");

  saveConfig({ port: 18765, token: "relay-token", tls, iroh: { enabled: true, relays: "nope" } });
  const savedJunk = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
  check("saveConfig turns an unknown relay value into []", Array.isArray(savedJunk.iroh.relays)
    && savedJunk.iroh.relays.length === 0);
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}

// 4. The documented setting reaches the direct-only bind.
const link = fs.readFileSync(path.join(daemon, "src", "iroh_link.js"), "utf8");
check("iroh_link branches on relays === \"off\"", link.includes('relays === "off"'));
check("the direct-only branch disables the relay mode", link.includes("RelayMode.disabled()"));

finish();
