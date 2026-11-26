// Keeps typecheck-allowlist.json honest.
//
// The allowlist only pays for itself if it shrinks: an entry that is stale (its file is clean or
// gone) hides nothing and must be dropped, and the cap must match the entry count so growing the
// list is a deliberate edit, not a side effect. scripts/typecheck.mjs does the actual type-check
// and enforces the same rules; this test pins the file's shape and runs the gate once.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { REPO, check, finish } from "./helpers.mjs";

const daemon = path.join(REPO, "daemon");
const allow = JSON.parse(fs.readFileSync(path.join(daemon, "typecheck-allowlist.json"), "utf8"));
const listed = allow.files;

check(
  "the allowlist is an array of strings",
  Array.isArray(listed) && listed.every((f) => typeof f === "string"),
);
check(
  "no file is listed twice",
  new Set(listed).size === listed.length,
  listed.filter((f, i) => listed.indexOf(f) !== i).join(", "),
);
check(
  "every entry is a src/ .js path",
  listed.every((f) => /^src\/[A-Za-z0-9_./-]+\.js$/.test(f)),
);
check(
  "maxFiles is a whole number matching the entry count",
  Number.isInteger(allow.maxFiles) && allow.maxFiles === listed.length,
  `maxFiles ${allow.maxFiles}, ${listed.length} entries`,
);
for (const f of listed)
  check(`listed file exists: ${f}`, fs.existsSync(path.join(daemon, f)), "drop the entry and lower maxFiles");
check(
  "the allowlist is not the whole of src/",
  listed.length > 0 && listed.length < 93,
  `${listed.length} entries`,
);

// The gate itself, on this checkout: exits 0 only when everything outside the list is clean, the
// list has no stale entries, and the cap matches.
const run = spawnSync(process.execPath, [path.join(daemon, "scripts", "typecheck.mjs")], {
  cwd: daemon,
  encoding: "utf8",
  maxBuffer: 32 * 1024 * 1024,
});
const output = `${run.stdout || ""}${run.stderr || ""}`.trim();
check("scripts/typecheck.mjs exits 0", run.status === 0, output.split("\n").slice(-6).join("\n"));
check("the gate reports how many files are clean", /\d+ of \d+ files clean/.test(output), output);

finish();
