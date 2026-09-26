import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const testDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "test");
const files = fs.readdirSync(testDir)
  .filter((f) => f !== "helpers.mjs" && f.endsWith(".mjs"))
  .sort();

for (const f of files) {
  console.log(`\n--- ${f} ---`);
  // A throwaway home: modules that read the config at import must never touch the real profile.
  const env = { ...process.env, RH_HOME: process.env.RH_HOME || path.join(os.tmpdir(), "pocketdesk-test-home") };
  const r = spawnSync(process.execPath, [path.join(testDir, f)], { stdio: "inherit", env });
  if (r.status !== 0) {
    console.error(`\nFAILED: ${f}`);
    process.exit(r.status ?? 1);
  }
}

console.log(`\nAll ${files.length} test files passed.`);
