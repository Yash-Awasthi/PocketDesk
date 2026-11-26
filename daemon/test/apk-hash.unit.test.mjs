// The reproducible-build fingerprint has to be stable and has to refuse things that
// are not zips, otherwise the release check in docs/REPRODUCIBLE-BUILD.md is noise.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { REPO, check, makeTmp, finish } from "./helpers.mjs";

const script = path.join(REPO, "app", "scripts", "apk-content-hash.mjs");
check("apk-content-hash.mjs exists", fs.existsSync(script));

function run(args) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [script, ...args], { encoding: "utf8" }).trim() };
  } catch (e) {
    return { code: e.status ?? -1, out: `${e.stdout || ""}${e.stderr || ""}`.trim() };
  }
}

const tmp = makeTmp("apk-hash");
const notZip = path.join(tmp, "not-an-apk.apk");
fs.writeFileSync(notZip, "this is not a zip file\n");
const bad = run([notZip]);
check("a non-zip is rejected with a reason", bad.code === 1 && /not a zip/.test(bad.out));

const empty = run([]);
check("a missing argument prints usage", empty.code === 2 && /usage:/.test(empty.out));

// A real zip, built twice with the same contents, must fingerprint the same.
const srcDir = path.join(tmp, "src");
fs.mkdirSync(srcDir, { recursive: true });
fs.writeFileSync(path.join(srcDir, "a.txt"), "alpha\n");
fs.writeFileSync(path.join(srcDir, "b.txt"), "beta\n");

const zips = [];
for (const n of [1, 2]) {
  const z = path.join(tmp, `pack${n}.zip`);
  execFileSync(
    "powershell",
    [
      "-NoProfile",
      "-Command",
      `Compress-Archive -Path '${path.join(srcDir, "*")}' -DestinationPath '${z}' -Force`,
    ],
    { stdio: "ignore" },
  );
  zips.push(z);
}

const h1 = run([zips[0]]);
const h2 = run([zips[1]]);
check("a real zip fingerprints cleanly", h1.code === 0 && /^[0-9a-f]{64}\s+\d+ entries/.test(h1.out), h1.out);
check(
  "two zips with the same content fingerprint the same",
  h1.out.split(/\s+/)[0] === h2.out.split(/\s+/)[0],
  `${h1.out} | ${h2.out}`,
);
check("the entry count is reported, not implied", /2 entries/.test(h1.out), h1.out);

// Changing one byte of content must change the fingerprint.
fs.writeFileSync(path.join(srcDir, "a.txt"), "alpha!\n");
const changed = path.join(tmp, "pack3.zip");
execFileSync(
  "powershell",
  [
    "-NoProfile",
    "-Command",
    `Compress-Archive -Path '${path.join(srcDir, "*")}' -DestinationPath '${changed}' -Force`,
  ],
  { stdio: "ignore" },
);
const h3 = run([changed]);
check(
  "a content change moves the fingerprint",
  h3.out.split(/\s+/)[0] !== h1.out.split(/\s+/)[0],
  `${h1.out} | ${h3.out}`,
);

finish();
