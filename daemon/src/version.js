// Single source of the release version: the daemon, the APK and the native helpers read it.
// Keep it in step with app/app/build.gradle.kts and native/Cargo.toml.
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const VERSION = fs.readFileSync(path.join(here, "..", "..", "VERSION"), "utf8").trim();
