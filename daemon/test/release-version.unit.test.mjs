// Release identity: VERSION is the one number the daemon, the APK and the native helpers share.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { REPO, check, finish } from "./helpers.mjs";

const versionFile = path.join(REPO, "VERSION");
const hasVersion = fs.existsSync(versionFile);
check("VERSION exists at the repo root", hasVersion);

const version = hasVersion ? fs.readFileSync(versionFile, "utf8").trim() : "";
check(`VERSION is semver (${version || "missing"})`, /^\d+\.\d+\.\d+$/.test(version));

// The APK carries the same version, and its build number only ever moves forward.
const gradle = fs.readFileSync(path.join(REPO, "app/app/build.gradle.kts"), "utf8");
const versionName = /versionName\s*=\s*"([^"]+)"/.exec(gradle)?.[1];
const versionCode = Number(/versionCode\s*=\s*(\d+)/.exec(gradle)?.[1]);
check(`android versionName matches VERSION (${versionName})`, versionName === version);
check(
  `android versionCode is a positive integer (${versionCode})`,
  Number.isInteger(versionCode) && versionCode > 0,
);

const cargo = fs.readFileSync(path.join(REPO, "native/Cargo.toml"), "utf8");
const workspacePackage = /\[workspace\.package\]([\s\S]*?)(?:\n\[|$)/.exec(cargo)?.[1] || "";
const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(workspacePackage)?.[1];
check(`native workspace version matches VERSION (${cargoVersion})`, cargoVersion === version);

// CHANGELOG headings are the release list: semver, unique, strictly descending, newest first.
const changelog = fs.readFileSync(path.join(REPO, "CHANGELOG.md"), "utf8").split(/\r?\n/);
const headings = changelog
  .map((line, i) => (/^## /.test(line) ? { i, name: line.slice(3).trim() } : null))
  .filter(Boolean);
check(
  `CHANGELOG has version headings (${headings.map((h) => h.name).join(", ") || "none"})`,
  headings.length > 0,
);

// An unreleased section may sit on top of the release list; it carries no version.
const unreleased = headings.filter((h) => h.name === "Unreleased");
check("at most one Unreleased heading", unreleased.length <= 1, headings.map((h) => h.name).join(", "));
check(
  "Unreleased is the first heading when present",
  unreleased.length === 0 || headings[0].name === "Unreleased",
  headings.map((h) => h.name).join(", "),
);
const releases = headings.filter((h) => h.name !== "Unreleased");
const names = releases.map((h) => h.name);
check(
  "every CHANGELOG heading is semver",
  names.every((n) => /^\d+\.\d+\.\d+$/.test(n)),
  names.join(", "),
);
check("CHANGELOG headings are unique", new Set(names).size === names.length, names.join(", "));

const parts = names.map((n) => n.split(".").map(Number));
const older = (a, b) => {
  for (let k = 0; k < 3; k++) if (a[k] !== b[k]) return a[k] < b[k];
  return false;
};
check(
  "CHANGELOG headings strictly descend",
  parts.every((p, i) => i === 0 || older(p, parts[i - 1])),
  names.join(", "),
);
check(`newest CHANGELOG section matches VERSION (${names[0]})`, names[0] === version);

const sections = headings.map((h, k) => ({
  name: h.name,
  body: changelog.slice(h.i + 1, k + 1 < headings.length ? headings[k + 1].i : changelog.length),
}));
for (const s of sections) {
  check(
    `CHANGELOG ${s.name} lists at least one change`,
    s.body.some((line) => line.startsWith("- ")),
  );
}

// The shipped command reads the file without a daemon or a network.
let printed;
let childCode = 0;
try {
  printed = execFileSync(process.execPath, ["src/index.js", "--version"], {
    cwd: path.join(REPO, "daemon"),
    encoding: "utf8",
    timeout: 30_000,
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (e) {
  childCode = e.status ?? 1;
  printed = `${e.stdout || ""}${e.stderr || ""}`;
}
check(`pocketdesk --version exits 0 (${childCode})`, childCode === 0);
check("pocketdesk --version prints only VERSION", printed.trim() === version, JSON.stringify(printed));

const mod = await import(pathToFileURL(path.join(REPO, "daemon/src/version.js")).href);
check(`daemon/src/version.js exports VERSION (${mod.VERSION})`, mod.VERSION === version);

// A release publishes checksums, and the tag must name the same version as every file that
// carries one. The gate is the same script the release workflow runs, so a local run proves it.
const pkgVersion = JSON.parse(fs.readFileSync(path.join(REPO, "daemon/package.json"), "utf8")).version;
check(`daemon/package.json mirrors VERSION (${pkgVersion})`, pkgVersion === version);

const releaseScript = path.join(REPO, "daemon/scripts/release.mjs");
const runRelease = (...args) => {
  try {
    const out = execFileSync(process.execPath, [releaseScript, ...args], {
      cwd: path.join(REPO, "daemon"),
      encoding: "utf8",
      timeout: 30_000,
      stdio: ["ignore", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (e) {
    return { code: e.status ?? 1, out: `${e.stdout || ""}${e.stderr || ""}` };
  }
};

const goodTag = runRelease("check", "--tag", `v${version}`);
check(`the release gate accepts v${version} (${goodTag.code})`, goodTag.code === 0, goodTag.out.trim());

const wrongTag = runRelease("check", "--tag", "v9.9.9");
check(
  "the release gate refuses a tag that names another version",
  wrongTag.code === 1 && /v9\.9\.9/.test(wrongTag.out) && /VERSION/.test(wrongTag.out),
  wrongTag.out.trim(),
);

const bareTag = runRelease("check", "--tag", version);
check(
  "the release gate wants the v prefix",
  bareTag.code === 1 && /not vX\.Y\.Z/.test(bareTag.out),
  bareTag.out.trim(),
);

const noTag = runRelease("check");
check("the release gate needs a tag", noTag.code === 1 && /no tag/.test(noTag.out), noTag.out.trim());

const dist = fs.mkdtempSync(path.join(os.tmpdir(), "pd-sums-"));
fs.writeFileSync(path.join(dist, "b.bin"), "second\n");
fs.writeFileSync(path.join(dist, "a.bin"), "first\n");
const sumsFile = path.join(dist, "SHA256SUMS");
const hash = (text) => crypto.createHash("sha256").update(text).digest("hex");
const expected = `${hash("first\n")}  a.bin\n${hash("second\n")}  b.bin\n`;
const sums = runRelease("sums", "--out", sumsFile, path.join(dist, "b.bin"), path.join(dist, "a.bin"));
check(
  `the sums command writes sha256sum lines in name order (${sums.code})`,
  sums.code === 0 && fs.readFileSync(sumsFile, "utf8") === expected,
  sums.out.trim(),
);

runRelease("sums", "--out", sumsFile, path.join(dist, "a.bin"), path.join(dist, "b.bin"));
check("the same artefacts give byte-identical checksums", fs.readFileSync(sumsFile, "utf8") === expected);

const missing = runRelease("sums", "--out", sumsFile, path.join(dist, "gone.bin"));
check(
  "a missing artefact fails the sums step",
  missing.code === 1 && /no such file/.test(missing.out),
  missing.out.trim(),
);
fs.rmSync(dist, { recursive: true, force: true });

// The workflow is what runs the gate on a tag; it must point at this script and publish the sums.
const workflow = fs.readFileSync(path.join(REPO, ".github/workflows/release.yml"), "utf8");
check("the release workflow runs on v tags", /tags: \["v\*"\]/.test(workflow));
check("the release workflow runs the version gate", /node scripts\/release\.mjs check/.test(workflow));
check("the release workflow publishes SHA256SUMS", /release\.mjs sums --out dist\/SHA256SUMS/.test(workflow));
check("the release workflow uploads the checksums", /upload-artifact/.test(workflow));
finish();
