// Release identity: VERSION is the one number the daemon, the APK and the native helpers share.
import fs from "node:fs";
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
check(`android versionCode is a positive integer (${versionCode})`, Number.isInteger(versionCode) && versionCode > 0);

const cargo = fs.readFileSync(path.join(REPO, "native/Cargo.toml"), "utf8");
const workspacePackage = /\[workspace\.package\]([\s\S]*?)(?:\n\[|$)/.exec(cargo)?.[1] || "";
const cargoVersion = /^version\s*=\s*"([^"]+)"/m.exec(workspacePackage)?.[1];
check(`native workspace version matches VERSION (${cargoVersion})`, cargoVersion === version);

// CHANGELOG headings are the release list: semver, unique, strictly descending, newest first.
const changelog = fs.readFileSync(path.join(REPO, "CHANGELOG.md"), "utf8").split(/\r?\n/);
const headings = changelog
  .map((line, i) => (/^## /.test(line) ? { i, name: line.slice(3).trim() } : null))
  .filter(Boolean);
check(`CHANGELOG has version headings (${headings.map((h) => h.name).join(", ") || "none"})`, headings.length > 0);

const names = headings.map((h) => h.name);
check("every CHANGELOG heading is semver", names.every((n) => /^\d+\.\d+\.\d+$/.test(n)), names.join(", "));
check("CHANGELOG headings are unique", new Set(names).size === names.length, names.join(", "));

const parts = names.map((n) => n.split(".").map(Number));
const older = (a, b) => {
  for (let k = 0; k < 3; k++) if (a[k] !== b[k]) return a[k] < b[k];
  return false;
};
check("CHANGELOG headings strictly descend", parts.every((p, i) => i === 0 || older(p, parts[i - 1])), names.join(", "));
check(`newest CHANGELOG section matches VERSION (${names[0]})`, names[0] === version);

const sections = headings.map((h, k) => ({
  name: h.name,
  body: changelog.slice(h.i + 1, k + 1 < headings.length ? headings[k + 1].i : changelog.length),
}));
for (const s of sections) {
  check(`CHANGELOG ${s.name} lists at least one change`, s.body.some((line) => line.startsWith("- ")));
}

// The shipped command reads the file without a daemon or a network.
let printed = "";
let childCode = 0;
try {
  printed = execFileSync(process.execPath, ["src/index.js", "--version"], {
    cwd: path.join(REPO, "daemon"), encoding: "utf8", timeout: 30_000, stdio: ["ignore", "pipe", "pipe"],
  });
} catch (e) {
  childCode = e.status ?? 1;
  printed = `${e.stdout || ""}${e.stderr || ""}`;
}
check(`pocketdesk --version exits 0 (${childCode})`, childCode === 0);
check("pocketdesk --version prints only VERSION", printed.trim() === version, JSON.stringify(printed));

const mod = await import(pathToFileURL(path.join(REPO, "daemon/src/version.js")).href);
check(`daemon/src/version.js exports VERSION (${mod.VERSION})`, mod.VERSION === version);

finish();
