// A signing keystore, and the properties file that unlocks it, must never become a tracked file:
// the release APK is signed in CI from secrets, so a copy on disk is only ever local.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { check, finish, REPO } from "./helpers.mjs";

const tracked = execFileSync("git", ["ls-files", "-z"], { cwd: REPO, encoding: "utf8" })
  .split("\0")
  .filter(Boolean);

check(`git ls-files answers (${tracked.length} files)`, tracked.length > 100);

const FORBIDDEN = [
  ["a keystore.properties", /(^|\/)keystore\.properties$/i],
  ["a *.keystore file", /\.keystore$/i],
  ["a *.jks file", /\.jks$/i],
  ["a pocketdesk.ini", /(^|\/)pocketdesk\.ini$/i],
];

for (const [what, re] of FORBIDDEN) {
  const hits = tracked.filter((f) => re.test(f));
  check(`no tracked ${what}${hits.length ? ` (found: ${hits.join(", ")})` : ""}`, hits.length === 0);
}

// The ignores are the other half: a keystore that is untracked today is one "git add ." away
// from the history, so every name the test bans is ignored as well.
const ignored = fs
  .readFileSync(path.join(REPO, ".gitignore"), "utf8")
  .split("\n")
  .map((l) => l.trim());
for (const pattern of ["*.jks", "*.keystore", "keystore.properties", "pocketdesk.ini"]) {
  check(`.gitignore keeps ${pattern} out`, ignored.includes(pattern));
}

// The scan itself runs in CI: it walks the full history, which a checkout-less run cannot.
const workflow = path.join(REPO, ".github", "workflows", "secrets.yml");
check("the secret scan workflow exists", fs.existsSync(workflow));
if (fs.existsSync(workflow)) {
  const wf = fs.readFileSync(workflow, "utf8");
  check("it runs on push and pull_request", /^\s{2}push:/m.test(wf) && /^\s{2}pull_request:/m.test(wf));
  check("it runs gitleaks over the full history", /gitleaks/.test(wf) && /fetch-depth:\s*0/.test(wf));
}

// The history scan flags four fixture strings and one vendored bundle; the config must name those
// exactly rather than switch rules off, so a red scan can never be silenced with a blanket ignore.
const configPath = path.join(REPO, ".gitleaks.toml");
check("the gitleaks config exists", fs.existsSync(configPath));
if (fs.existsSync(configPath)) {
  const cfg = fs.readFileSync(configPath, "utf8");
  check("it keeps the default rules", /\[extend\][\s\S]*useDefault = true/.test(cfg));
  for (const fixture of [
    "abcdef1234567890",
    "0123456789abcdef",
    "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ",
    "MFRGGZDFMZTWQ2LKNNWG23TPOBYXE43U",
  ]) {
    check(`it allowlists the fixture ${fixture}`, cfg.includes(fixture));
  }
  check(
    "it allowlists the vendored xterm bundle by path",
    /\^app\/app\/src\/main\/assets\/vendor\//.test(cfg),
  );
  check("nothing is allowlisted wholesale", !/regexes = \[\s*''''\s*,?\s*\]/.test(cfg));
}

finish();
