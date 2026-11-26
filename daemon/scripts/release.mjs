// Release gate: the one version a tag names, and the checksums published beside the binaries.
//
//   node scripts/release.mjs check [--tag vX.Y.Z]     default tag is GITHUB_REF_NAME
//   node scripts/release.mjs sums --out SHA256SUMS <files...>
//
// Every artefact of a release is built from the tag, so the tag has to agree with the version
// files before a byte is uploaded. The checksums are the list the download page publishes, in
// sha256sum order and form, so a user can check what they downloaded in one command.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const repo = path.resolve(here, "..", "..");

const read = (rel) => fs.readFileSync(path.join(repo, rel), "utf8");
const grab = (rel, re) => (re.exec(read(rel)) || [])[1] || "";

/** Every place a release version is written, keyed by what a reader calls it. */
export function versions() {
  return {
    VERSION: read("VERSION").trim(),
    "package.json": JSON.parse(read("daemon/package.json")).version || "",
    versionName: grab("app/app/build.gradle.kts", /versionName\s*=\s*"([^"]+)"/),
    "native workspace": grab("native/Cargo.toml", /\[workspace\.package\][\s\S]*?^version\s*=\s*"([^"]+)"/m),
    "newest CHANGELOG heading": grab("CHANGELOG.md", /^## (\d+\.\d+\.\d+)$/m),
  };
}

/** Why [tag] cannot name this tree, or [] when it can. */
export function tagProblems(tag, all = versions()) {
  const m = /^v(\d+\.\d+\.\d+)$/.exec(String(tag || ""));
  if (!m) return [`tag ${tag || "(none)"} is not vX.Y.Z`];
  const bad = [];
  for (const [where, value] of Object.entries(all)) {
    if (value !== m[1]) bad.push(`tag ${tag} is ${m[1]}, ${where} is ${value || "(missing)"}`);
  }
  return bad;
}

function fail(message) {
  console.error(`release: ${message}`);
  process.exit(1);
}

function check(args) {
  const at = args.indexOf("--tag");
  const tag = at >= 0 ? args[at + 1] : process.env.GITHUB_REF_NAME;
  if (!tag) fail("no tag: pass --tag vX.Y.Z or set GITHUB_REF_NAME");
  const bad = tagProblems(tag);
  if (bad.length) fail(bad.join("; "));
  console.log(`release: ${tag} matches VERSION, package.json, versionName and the native workspace`);
}

function sums(args) {
  const at = args.indexOf("--out");
  const out = at >= 0 ? args[at + 1] : "";
  const files = args.filter((_, i) => i !== at && i !== at + 1);
  if (!out) fail("sums needs --out <file>");
  if (!files.length) fail("sums needs at least one artefact");
  const rows = [];
  for (const file of files) {
    if (!fs.existsSync(file) || !fs.statSync(file).isFile()) fail(`no such file: ${file}`);
    const name = path.basename(file);
    if (rows.some((r) => r.name === name)) fail(`two artefacts share the name ${name}`);
    const digest = crypto.createHash("sha256").update(fs.readFileSync(file)).digest("hex");
    rows.push({ name, line: `${digest}  ${name}` });
  }
  rows.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  fs.writeFileSync(out, rows.map((r) => r.line).join("\n") + "\n");
  console.log(`release: ${rows.length} checksums in ${out}`);
}
const [cmd, ...rest] = process.argv.slice(2);
if (cmd === "check") check(rest);
else if (cmd === "sums") sums(rest);
else fail("usage: release.mjs check [--tag vX.Y.Z] | sums --out <file> <files...>");
