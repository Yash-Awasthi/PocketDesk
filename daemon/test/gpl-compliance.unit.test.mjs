// GPL-3.0-or-later only holds if the source travels with the binaries, so these checks read the
// licence texts, the release procedure and the per-dependency inventory instead of trusting prose.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, finish, REPO } from "./helpers.mjs";

const rel = (p) => path.join(REPO, p);
const read = (p) => fs.readFileSync(rel(p), "utf8");
const exists = (p) => fs.existsSync(rel(p));

// 1. The licence text and the notice that names the copyright holders.
check("LICENSE is present", exists("LICENSE"));
const licence = exists("LICENSE") ? read("LICENSE") : "";
check("LICENSE is the GNU GPL", /GNU GENERAL PUBLIC LICENSE/.test(licence) && /Version 3/.test(licence));
const notice = exists("NOTICE") ? read("NOTICE") : "";
check("NOTICE states GPL-3.0-or-later", /GPL-3\.0-or-later/.test(notice));
check("NOTICE names the adapted projects", /NectarLink/.test(notice) && /TwinDesk/.test(notice));

// 2. The source offer, which is the release procedure's side of the licence.
const releasing = read("docs/RELEASING.md");
const offerAt = releasing.search(/^## Source offer/m);
check("docs/RELEASING.md has a source-offer section", offerAt >= 0);
const offer = offerAt >= 0 ? releasing.slice(offerAt).split(/^## /m)[1] || "" : "";
check("the offer names the release tag as the source", /vX\.Y\.Z/.test(offer) && /tag/.test(offer));
check("the offer ships LICENSE and NOTICE with the binaries", /LICENSE/.test(offer) && /NOTICE/.test(offer));
check("the offer covers a patched downstream build", /patch/i.test(offer));
check("the offer points at the per-dependency inventory", /docs\/LICENCES\.md/.test(offer));

// 3. A release workflow, once one exists, has to carry that source archive.
const workflows = rel(".github/workflows");
const releaseWorkflows = fs.existsSync(workflows)
  ? fs.readdirSync(workflows).filter((f) => /release/i.test(f))
  : [];
const carriesSource = releaseWorkflows.every((f) =>
  /archive\/refs\/tags|git archive|source archive/i.test(fs.readFileSync(path.join(workflows, f), "utf8")),
);
check(
  `a release workflow, when one exists, carries the source (${releaseWorkflows.length} found)`,
  carriesSource,
);

// 4. Every direct dependency is inventoried, and the npm licences are the installed ones.
const inventory = read("docs/LICENCES.md");
const body = (heading) => {
  const at = inventory.search(new RegExp("^## " + heading + "\\s*$", "m"));
  if (at < 0) return "";
  return inventory.slice(at).split(/^## /m)[1] || "";
};
const npmBody = body("Daemon \\(npm\\)");
const npmCells = new Map();
for (const line of npmBody.split("\n")) {
  const m = /^\| `([^`]+)` \| ([^|]+) \|/.exec(line);
  if (m) npmCells.set(m[1], m[2].trim());
}
const pkg = JSON.parse(read("daemon/package.json"));
const direct = [
  ...Object.keys(pkg.dependencies || {}),
  ...Object.keys(pkg.optionalDependencies || {}),
  ...Object.keys(pkg.devDependencies || {}),
];
for (const name of direct) {
  const installed = path.join(REPO, "daemon", "node_modules", name, "package.json");
  let declared = "";
  if (fs.existsSync(installed)) {
    const p = JSON.parse(fs.readFileSync(installed, "utf8"));
    declared =
      typeof p.license === "string"
        ? p.license
        : (p.license || p.licenses || []).map((l) => l.type).join(" OR ");
  }
  const listed = npmCells.get(name) || "";
  check(
    `LICENCES.md lists ${name}${listed ? ` as ${listed}` : " (missing)"}`,
    listed !== "" && (declared === "" || listed === declared),
  );
}

// 5. Every native and Android dependency name is listed too.
const DEP_SECTION = /^(?:target\..+\.)?(?:build-)?dependencies$/;
function cargoDeps(file) {
  const found = new Set();
  let section = "";
  for (const line of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const head = /^\s*\[(.+)\]\s*$/.exec(line);
    if (head) {
      section = head[1].trim();
      continue;
    }
    if (!DEP_SECTION.test(section)) continue;
    const m = /^([A-Za-z0-9_-]+)\s*(?:\.|=)/.exec(line.trim());
    if (m) found.add(m[1]);
  }
  return found;
}
const cargoNames = new Set(cargoDeps(rel("native/Cargo.toml")));
for (const dir of fs.readdirSync(rel("native"), { withFileTypes: true })) {
  if (!dir.isDirectory()) continue;
  const manifest = rel(path.join("native", dir.name, "Cargo.toml"));
  if (fs.existsSync(manifest)) for (const n of cargoDeps(manifest)) cargoNames.add(n);
}
for (const name of [...cargoNames].sort()) {
  check(`LICENCES.md lists the crate ${name}`, inventory.includes("`" + name + "`"));
}

const catalog = read("app/gradle/libs.versions.toml").split(/\r?\n/);
let inLibraries = false;
const libraries = [];
for (const line of catalog) {
  const head = /^\s*\[([^\]]+)\]\s*$/.exec(line);
  if (head) {
    inLibraries = head[1].trim() === "libraries";
    continue;
  }
  if (!inLibraries) continue;
  const m = /^([A-Za-z0-9_.-]+)\s*=\s*\{\s*module\s*=\s*"([^"]+)"/.exec(line.trim());
  if (m) libraries.push({ alias: m[1], module: m[2] });
}
check(`the Gradle catalog has library aliases (${libraries.length})`, libraries.length > 10);
const gradleCells = new Map();
for (const line of body("Android \\(Gradle\\)").split("\n")) {
  const m = /^\| `([^`]+)` \| `([^`]+)` \| ([^|]+) \| ([^|]+) \|/.exec(line);
  if (m) gradleCells.set(m[1], { module: m[2], version: m[3].trim(), licence: m[4].trim() });
}
for (const { alias, module } of libraries) {
  const row = gradleCells.get(alias);
  check(
    `LICENCES.md lists the Gradle alias ${alias}${row ? ` as ${row.module}` : " (missing)"}`,
    !!row && row.module === module,
  );
}

// 6. Where a Gradle cache exists, the recorded version and licence are re-read from its POM.
const cache = path.join(os.homedir(), ".gradle", "caches", "modules-2", "files-2.1");
if (fs.existsSync(cache)) {
  const pomFor = (module) => {
    const [group, artifact] = module.split(":");
    const dir = path.join(cache, group, artifact);
    if (!fs.existsSync(dir)) return null;
    const versions = fs.readdirSync(dir).filter((v) => fs.statSync(path.join(dir, v)).isDirectory());
    for (const v of versions.sort((a, b) => a.localeCompare(b, undefined, { numeric: true })).reverse()) {
      const stack = [path.join(dir, v)];
      while (stack.length) {
        const d = stack.pop();
        for (const e of fs.readdirSync(d, { withFileTypes: true })) {
          const p = path.join(d, e.name);
          if (e.isDirectory()) stack.push(p);
          else if (e.name.endsWith(".pom")) return { version: v, file: p };
        }
      }
    }
    return null;
  };
  let resolved = 0;
  for (const { alias, module } of libraries) {
    const row = gradleCells.get(alias);
    const hit = pomFor(module);
    if (!hit) {
      check(
        `${alias} is marked unverified when the cache has no POM`,
        /not resolved/.test(row?.licence || ""),
      );
      continue;
    }
    resolved += 1;
    const pom = fs.readFileSync(hit.file, "utf8");
    const m = /<licenses>[\s\S]*?<license>[\s\S]*?<name>([^<]+)<\/name>/.exec(pom);
    if (!m) {
      // A POM without a <licenses> block proves nothing, so the row has to say so.
      check(
        `${alias} is marked unverified when the POM carries no licence`,
        /not resolved/.test(row?.licence || ""),
      );
      continue;
    }
    const licenceName = m[1].trim();
    check(
      `${alias} records the POM licence ${licenceName} at ${hit.version}`,
      row?.version === hit.version && row?.licence === licenceName,
    );
  }
  check(`re-read ${resolved} of ${libraries.length} Gradle POMs`, resolved > 0);
}

finish();
