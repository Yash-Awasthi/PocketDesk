import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Daemons under test keep data in ~/.pocketdesk-<name>test*; every run starts and ends clean.
function wipeTestData() {
  for (const d of fs.readdirSync(os.homedir())) {
    if (/^\.pocketdesk-.*test/.test(d)) fs.rmSync(path.join(os.homedir(), d), { recursive: true, force: true });
  }
}

export function globalSetup() {
  // A throwaway home: modules that read the config at import must never touch the real profile.
  process.env.RH_HOME ||= path.join(os.tmpdir(), "pocketdesk-test-home");
  wipeTestData();
}

export { wipeTestData as globalTeardown };
