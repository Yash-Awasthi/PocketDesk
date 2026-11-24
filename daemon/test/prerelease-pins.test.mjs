// Release-path gate: a pre-release toolchain or dependency may only be pinned on
// purpose, and the reason has to sit next to the pin. This walks the two files that
// decide what users actually install — the Android toolchain pins and the daemon's
// npm manifest — and fails any pre-release entry that carries no note.
//
//   libs.versions.toml  -> `# prerelease: <why>` on the pin line or the line above it
//   package.json        -> a top-level "prerelease": { "<dep>": "<why>" } entry
//
// M1.4.3 in plan.md.
import fs from "node:fs";
import path from "node:path";
import { REPO, check, finish } from "./helpers.mjs";

const PRERELEASE = /-(?:alpha|beta|rc|m\d|preview|dev|snapshot|eap)|-(?:alpha|beta|rc)\.?\d*\b/i;

function jsonBlock(text, key) {
  // Pull a top-level JSON object body by brace matching (package.json has no comments).
  const at = text.indexOf(`"${key}"`);
  if (at < 0) return null;
  const start = text.indexOf("{", at);
  if (start < 0) return null;
  let depth = 0;
  for (let i = start; i < text.length; i++) {
    if (text[i] === "{") depth++;
    else if (text[i] === "}") {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

function tomlPins(text) {
  // Every `name = "value"` line with its line number and the line above it.
  const lines = text.split(/\r?\n/);
  const out = [];
  lines.forEach((line, i) => {
    const m = /^\s*([A-Za-z0-9_.-]+)\s*=\s*"([^"]+)"\s*(#.*)?$/.exec(line);
    if (m) out.push({ name: m[1], version: m[2], note: m[3] || "", above: lines[i - 1] || "", line: i + 1 });
  });
  return out;
}

// --- app/gradle/libs.versions.toml -----------------------------------------
const tomlPath = path.join(REPO, "app", "gradle", "libs.versions.toml");
check("libs.versions.toml exists", fs.existsSync(tomlPath));
const toml = fs.readFileSync(tomlPath, "utf8");
const pins = tomlPins(toml);
check("libs.versions.toml parsed into pins", pins.length > 10);

// The note counts only on the pin's own line, or as the whole line above it (a sentence that merely
// mentions `# prerelease:` further up must not silence a later pin).
const notedLine = (p) => /#\s*prerelease:/i.test(p.note) || /^\s*#\s*prerelease:/i.test(p.above);
const bareToml = pins.filter((p) => PRERELEASE.test(p.version) && !notedLine(p));
check(
  bareToml.length === 0
    ? "no un-noted pre-release in libs.versions.toml"
    : `no un-noted pre-release in libs.versions.toml (offenders: ${bareToml.map((p) => `${p.name}=${p.version} line ${p.line}`).join(", ")})`,
  bareToml.length === 0,
);

// A note that is present must say something, not just the tag word.
const thinToml = pins.filter((p) => PRERELEASE.test(p.version) && /#\s*prerelease:\s*$/i.test(p.note));
check("every pre-release note in libs.versions.toml explains itself", thinToml.length === 0);

// --- daemon/package.json ----------------------------------------------------
const pkgPath = path.join(REPO, "daemon", "package.json");
check("daemon/package.json exists", fs.existsSync(pkgPath));
const pkgText = fs.readFileSync(pkgPath, "utf8");
const pkg = JSON.parse(pkgText);
const deps = { ...(pkg.dependencies || {}), ...(pkg.devDependencies || {}), ...(pkg.optionalDependencies || {}) };
const notes = pkg.prerelease && typeof pkg.prerelease === "object" ? pkg.prerelease : {};

const bare = Object.entries(deps).filter(([name, v]) => PRERELEASE.test(String(v)) && !(typeof notes[name] === "string" && notes[name].trim().length > 0));
check(
  bare.length === 0 ? "no un-noted pre-release dependency in daemon/package.json" : `no un-noted pre-release dependency in daemon/package.json (offenders: ${bare.map(([n, v]) => `${n}@${v}`).join(", ")})`,
  bare.length === 0,
);

// The note map itself must not rot: every note has to point at a dependency that is still a pre-release.
const staleNotes = Object.keys(notes).filter((name) => !deps[name] || !PRERELEASE.test(String(deps[name])));
check(
  staleNotes.length === 0 ? "prerelease notes point at live pre-release pins" : `prerelease notes point at live pre-release pins (stale: ${staleNotes.join(", ")})`,
  staleNotes.length === 0,
);

// --- the gate must be able to see a pre-release at all ----------------------
// If the patterns ever stop matching, the checks above pass vacuously.
check("the pre-release pattern recognises the tags we have used", ["9.5.0-alpha09", "2.5.0-Beta1", "1.2.0-beta.15", "1.12.0-RC", "9.6.0-M1"].every((v) => PRERELEASE.test(v)));
check("the pre-release pattern ignores ordinary stable versions", !["9.5.2", "2.4.21", "2026.11.01", "1.13.0", "1.1.0", "5.5.0"].some((v) => PRERELEASE.test(v)));

finish();
