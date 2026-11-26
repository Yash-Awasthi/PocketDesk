// M2.2: no shell-string child processes. daemon/src passes an argv array to
// execFile/execFileSync/spawn/spawnSync, never a command string to exec/execSync,
// so a value from a message can never become shell syntax.
import fs from "node:fs";
import path from "node:path";
import { check, finish, REPO } from "./helpers.mjs";

const SRC = path.join(REPO, "daemon", "src");
// Each file this guard was added with must keep an argv-form call, so deleting
// the feature cannot make the scan pass by having nothing left to check.
const CHANGED = [
  "daemon/src/config.js",
  "daemon/src/doctor.js",
  "daemon/src/freebuff_control.js",
  "daemon/src/power_manager.js",
  "daemon/src/handlers/agents.js",
];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.isDirectory()) walk(path.join(dir, e.name), out);
    else if (e.name.endsWith(".js")) out.push(path.join(dir, e.name));
  }
  return out;
}

const files = walk(SRC);
check(`scanned daemon/src (${files.length} files)`, files.length > 20);

const offenders = [];
const argvCalls = new Map();
for (const file of files) {
  const rel = path.relative(REPO, file).replace(/\\/g, "/");
  const text = fs.readFileSync(file, "utf8");
  text.split("\n").forEach((line, i) => {
    const at = `${rel}:${i + 1}`;
    const code = line.trim();
    // A bare `exec(` here declares a method (`async exec(sessionId, command)`), it does not call out.
    const isMethod = /^(async\s+)?exec\s*\(\s*\w+\s*,/.test(code);
    if (/(?<![\w.])execSync?\s*\(/.test(line) && !isMethod) offenders.push(`${at} ${code.slice(0, 100)}`);
    if (/^import\b.*\bexecSync?\b.*from\s*["'](?:node:)?child_process["']/.test(code))
      offenders.push(`${at} ${code.slice(0, 100)}`);
    if (/require\s*\(\s*["'](?:node:)?child_process["']\s*\)/.test(line))
      offenders.push(`${at} ${code.slice(0, 100)}`);
    if (/(?<![\w.])(execFile|execFileSync|spawn|spawnSync)\s*\(/.test(line))
      argvCalls.set(rel, (argvCalls.get(rel) || 0) + 1);
  });
}

check(
  `no daemon/src file imports or calls exec/execSync${offenders.length ? ": " + offenders.join(" | ") : ""}`,
  offenders.length === 0,
);

for (const rel of CHANGED) {
  const n = argvCalls.get(rel) || 0;
  check(`${rel} still uses an argv-array child process call (${n})`, n > 0);
}

finish();
