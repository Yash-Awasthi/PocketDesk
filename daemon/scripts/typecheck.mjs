// Type-checks daemon/src as plain JavaScript with JSDoc, via tsc --checkJs --noEmit. No
// --experimental-strip-types, no .ts files: Node runs the sources untouched.
//
// Files that are not clean yet are listed in typecheck-allowlist.json. The gate fails on any
// error in a file that is not listed, and also fails when a listed file has become clean (its
// entry is stale) or no longer exists, so the list can only shrink. The cap in that file must
// equal the number of entries, so adding one is a visible, deliberate edit.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DAEMON = path.dirname(HERE);
const SRC = path.join(DAEMON, "src");
const ALLOW = path.join(DAEMON, "typecheck-allowlist.json");

/** Every .js file under dir, as slash paths relative to the daemon directory. */
function walk(dir) {
  const out = [];
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) out.push(...walk(p));
    else if (e.isFile() && e.name.endsWith(".js"))
      out.push(path.relative(DAEMON, p).split(path.sep).join("/"));
  }
  return out.sort();
}

const allow = JSON.parse(fs.readFileSync(ALLOW, "utf8"));
const allowlisted = new Set(allow.files);
const sources = walk(SRC);
const tsc = path.join(DAEMON, "node_modules", "typescript", "bin", "tsc");
if (!fs.existsSync(tsc)) {
  console.error("typescript is not installed; run npm install first");
  process.exit(2);
}

const args = [
  tsc,
  "--pretty",
  "false",
  "--noEmit",
  "--allowJs",
  "--checkJs",
  "--target",
  "es2023",
  "--module",
  "nodenext",
  "--moduleResolution",
  "nodenext",
  "--skipLibCheck",
  "--types",
  "node",
  ...sources,
];
const run = spawnSync(process.execPath, args, {
  cwd: DAEMON,
  encoding: "utf8",
  maxBuffer: 128 * 1024 * 1024,
});
if (run.error) {
  console.error(`could not run tsc: ${run.error.message}`);
  process.exit(2);
}

const errors = new Map();
const global = [];
for (const line of `${run.stdout || ""}${run.stderr || ""}`.split(/\r?\n/)) {
  const m = /^(src\/[^()]+)\(\d+,\d+\): error TS\d+: (.*)$/.exec(line);
  if (m) {
    if (!errors.has(m[1])) errors.set(m[1], []);
    errors.get(m[1]).push(m[2]);
  } else if (/error TS\d+:/.test(line)) global.push(line.trim());
}

const problems = [];
for (const [file, list] of errors) {
  if (!allowlisted.has(file)) for (const msg of list) problems.push(`${file}: ${msg}`);
}
for (const file of allow.files) {
  if (!sources.includes(file)) problems.push(`${file}: allowlisted file is gone; drop its entry`);
  else if (!errors.has(file))
    problems.push(`${file}: allowlisted but now clean; drop its entry and lower maxFiles`);
}
if (allow.files.length !== allow.maxFiles) {
  problems.push(
    `typecheck-allowlist.json lists ${allow.files.length} files but maxFiles is ${allow.maxFiles}`,
  );
}
problems.push(...global);

const known = [...errors.values()].reduce((n, list) => n + list.length, 0);
const clean = sources.length - [...errors.keys()].length;
console.log(
  `typecheck: ${clean} of ${sources.length} files clean, ` +
    `${allow.files.length} allowlisted with ${known} known errors`,
);
if (problems.length) {
  console.error(`\n${problems.length} problem(s):`);
  for (const p of problems) console.error(`  ${p}`);
  process.exit(1);
}
console.log("all other files type-check; allowlist is up to date");
