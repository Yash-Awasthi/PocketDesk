// Single source of the release version: the daemon, the APK and the native helpers read it.
// Keep it in step with app/app/build.gradle.kts and native/Cargo.toml.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const VERSION = fs.readFileSync(path.join(here, "..", "..", "VERSION"), "utf8").trim();

// The wire protocol version is declared once, by the compatibility baseline beside daemon/src.
// The server, the generated compat file and the contract test all read this export, so a
// second literal cannot drift from what the README promises.
/** @type {number} */
export const PROTOCOL_VERSION = JSON.parse(
  fs.readFileSync(path.join(here, "..", "protocol", "compat.json"), "utf8"),
).protocolVersion;
