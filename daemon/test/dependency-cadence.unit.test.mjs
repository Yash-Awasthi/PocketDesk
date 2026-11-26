// Guards that the dependency pass stays documented and that every direct
// dependency is listed. Files only: no network, no daemon, no spawn.
import { REPO, check, finish } from "./helpers.mjs";
import fs from "node:fs";
import path from "node:path";

const docsFile = path.join(REPO, "docs/DEPENDENCIES.md");
const logFile = path.join(REPO, "docs/dependency-log.md");

const read = (p) => fs.readFileSync(p, "utf8");

// 1. Both docs exist.
check("docs/DEPENDENCIES.md exists", fs.existsSync(docsFile));
check("docs/dependency-log.md exists", fs.existsSync(logFile));
const docs = read(docsFile);
const log = read(logFile);

// 2. Every direct daemon dependency name is listed.
const pkg = JSON.parse(read(path.join(REPO, "daemon/package.json")));
const daemonNames = [
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.optionalDependencies || {}),
  ...Object.keys(pkg.devDependencies || {}),
];
for (const name of daemonNames) {
  check(`daemon dependency ${name} is listed`, docs.includes(name));
}

// 3. Every native direct dependency name is listed.
const DEP_SECTION = /^(?:target\..+\.)?(?:build-)?dependencies$/;
function cargoDeps(file, heading) {
  const lines = read(file).split(/\r?\n/);
  const names = new Set();
  let section = "";
  for (const line of lines) {
    const head = /^\s*\[(.+)\]\s*$/.exec(line);
    if (head) {
      section = head[1].trim();
      continue;
    }
    if (!DEP_SECTION.test(section)) continue;
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const m = /^([A-Za-z0-9_-]+)\s*(?:\.|=)/.exec(line);
    if (m) names.add(m[1]);
  }
  for (const name of names) check(`${heading} dependency ${name} is listed`, docs.includes(name));
}

cargoDeps(path.join(REPO, "native/Cargo.toml"), "native workspace");
for (const crate of fs.readdirSync(path.join(REPO, "native"), { withFileTypes: true })) {
  if (!crate.isDirectory()) continue;
  const manifest = path.join(REPO, "native", crate.name, "Cargo.toml");
  if (fs.existsSync(manifest)) cargoDeps(manifest, `native ${crate.name}`);
}

// 4. Every version alias in the Gradle catalog is listed.
const catalog = read(path.join(REPO, "app/gradle/libs.versions.toml")).split(/\r?\n/);
let inVersions = false;
const aliases = [];
for (const line of catalog) {
  const head = /^\s*\[(.+)\]\s*$/.exec(line);
  if (head) {
    inVersions = head[1].trim() === "versions";
    continue;
  }
  if (!inVersions) continue;
  const m = /^([A-Za-z0-9_.-]+)\s*=\s*"/.exec(line);
  if (m) aliases.push(m[1]);
}
check("Gradle catalog has version aliases", aliases.length > 0);
for (const alias of aliases) check(`Android alias ${alias} is listed`, docs.includes(alias));

// 5. The doc names the three manifests, and they exist.
const manifests = ["daemon/package.json", "native/Cargo.toml", "app/gradle/libs.versions.toml"];
for (const rel of manifests) {
  check(`doc names ${rel}`, docs.includes(rel));
  check(`${rel} exists`, fs.existsSync(path.join(REPO, rel)));
}

// 6. Cadence and the log path are stated.
check("cadence is monthly", /monthly/i.test(docs));
check("doc names docs/dependency-log.md", docs.includes("docs/dependency-log.md"));

// 7. Rollback covers each artifact path.
const rollbackAt = docs.search(/^## Rollback\s*$/m);
check("rollback section exists", rollbackAt >= 0);
const rollback = rollbackAt >= 0 ? docs.slice(rollbackAt) : "";
check("rollback uses install.ps1 -Ref", rollback.includes("-Ref"));
check("rollback mentions versionCode", rollback.includes("versionCode"));
check("rollback mentions PocketDesk-native", rollback.includes("PocketDesk-native"));

// 8. The log has a dated entry with the commands and a result marker.
const dateHeads = [...log.matchAll(/^## (\d{4})-(\d{2})-(\d{2})\s*$/gm)];
check("log has a dated entry", dateHeads.length > 0);
for (const m of dateHeads) {
  const [whole, y, mo, d] = m;
  const dt = new Date(Date.UTC(Number(y), Number(mo) - 1, Number(d)));
  const real =
    dt.getUTCFullYear() === Number(y) && dt.getUTCMonth() === Number(mo) - 1 && dt.getUTCDate() === Number(d);
  check(`log date ${y}-${mo}-${d} is a real calendar date`, real);
  const start = m.index + whole.length;
  const nextHead = log.slice(start).search(/^## /m);
  const entry = nextHead >= 0 ? log.slice(start, start + nextHead) : log.slice(start);
  check(`log entry ${y}-${mo}-${d} records npm outdated`, entry.includes("npm outdated"));
  check(`log entry ${y}-${mo}-${d} records npm audit`, entry.includes("npm audit"));
  check(`log entry ${y}-${mo}-${d} records a result marker`, entry.includes("->"));
}

finish();
