// The implicit shell option hands the platform one command string to re-parse, which is how
// an allowlist gets bypassed. daemon/scripts/ is the exempt area: its build and service
// scripts predate the rule, so the walk counts them instead of failing on them.
import fs from "node:fs";
import path from "node:path";
import { check, finish, REPO } from "./helpers.mjs";

// Assembled from parts so this file never trips over its own needle.
const FLAG = "shell" + ":" + "true";
const NEEDLE = new RegExp("shell" + "\\s*:\\s*" + "true");
const SKIP_DIRS = new Set(["node_modules", ".git"]);
const SCANNED = [".js", ".mjs"];

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (!SKIP_DIRS.has(e.name) && !e.name.startsWith(".")) walk(p, out);
    } else if (SCANNED.some((x) => e.name.endsWith(x))) out.push(p);
  }
  return out;
}

function scan(dir) {
  const found = [];
  for (const file of walk(dir)) {
    const rel = path.relative(REPO, file).replace(/\\/g, "/");
    fs.readFileSync(file, "utf8").split("\n").forEach((line, i) => {
      if (NEEDLE.test(line)) found.push(`${rel}:${i + 1}`);
    });
  }
  return found;
}

const guarded = [...walk(path.join(REPO, "daemon/src")), ...walk(path.join(REPO, "daemon/test"))];
check(`walked daemon/src and daemon/test (${guarded.length} files)`, guarded.length > 40);

const offenders = scan(path.join(REPO, "daemon/src")).concat(scan(path.join(REPO, "daemon/test")));
check(`no ${FLAG} outside daemon/scripts/${offenders.length ? " — hit " + offenders.join(" | ") : ""}`, offenders.length === 0);

// Explicit exemption: daemon/scripts/ is scanned and counted, never failed on.
const exempt = scan(path.join(REPO, "daemon/scripts"));
console.log(`note  daemon/scripts/ exempt area: ${exempt.length} hit(s)${exempt.length ? " — " + exempt.join(", ") : ""}`);
check("daemon/scripts/ exists and is scanned as the exempt area", fs.existsSync(path.join(REPO, "daemon/scripts")) && Array.isArray(exempt));

finish();
