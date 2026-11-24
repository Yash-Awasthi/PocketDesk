// Keeps coverage-floors.json honest, without needing a coverage run.
//
// The floors are only useful if they are (a) complete, (b) not set above what the suite actually
// reached, and (c) tightened when coverage improves — otherwise a floor quietly rots into a
// number nobody would notice. This test is the cheap half; `npm run coverage` runs c8 and
// scripts/check-coverage.mjs does the measuring.
import fs from "node:fs";
import path from "node:path";
import { REPO, check, finish } from "./helpers.mjs";

const daemon = path.join(REPO, "daemon");
const { areas: floors } = JSON.parse(fs.readFileSync(path.join(daemon, "coverage-floors.json"), "utf8"));
const metrics = ["statements", "branches", "functions"];

// Every folder of src/ and every loose src/*.js must have a floor; a new subfolder is an unlisted
// area and would otherwise be silently uncovered.
const srcDir = path.join(daemon, "src");
const areas = fs.readdirSync(srcDir, { withFileTypes: true })
  .filter((e) => e.isDirectory())
  .map((e) => e.name)
  .concat("src");
for (const a of areas) check(`an area has a floor: ${a}`, Boolean(floors[a]), JSON.stringify(Object.keys(floors)));

for (const [name, f] of Object.entries(floors)) {
  check(`${name}: every metric has a floor and a measurement`, metrics.every((k) => Number.isFinite(f.floor?.[k]) && Number.isFinite(f.measured?.[k])), JSON.stringify(f));
  for (const k of metrics) {
    // A floor above reality would fail every run; a floor far below lets coverage rot.
    const gap = f.measured[k] - f.floor[k];
    check(`${name}: ${k} floor ${f.floor[k]}% sits under the measured ${f.measured[k]}%`, gap >= 0, `gap ${gap}`);
    check(`${name}: ${k} floor is within 6 points of the measured ${f.measured[k]}%`, gap <= 6, `gap ${gap} — raise the floor to match`);
  }
}

// The floors file must not shrink: every metric of every known area is present and non-negative.
const total = Object.values(floors).flatMap((f) => metrics.map((k) => f.floor[k]));
check(`the floor table is populated (${total.length} numbers)`, total.length === Object.keys(floors).length * 3 && total.every((n) => n >= 0 && n <= 100));

finish();
