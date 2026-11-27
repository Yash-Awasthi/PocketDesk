// Fails when an area of daemon/src drops below its floor in coverage-floors.json.
//
// Reads what `c8 --reporter=json-summary` wrote (so `npm run coverage` must have run), prints
// every area, and exits non-zero naming the areas that slipped. Floors only ever go up: see the
// note in coverage-floors.json and test/coverage-floors.test.mjs.
import fs from "node:fs";
import { areas } from "./coverage-areas.mjs";

const floorsFile = new URL("../coverage-floors.json", import.meta.url);
const summaryFile = new URL("../coverage/coverage-summary.json", import.meta.url);

if (!fs.existsSync(summaryFile)) {
  console.error("coverage/coverage-summary.json is missing — run `npm run coverage` first.");
  process.exit(2);
}

const { areas: floors } = JSON.parse(fs.readFileSync(floorsFile, "utf8"));
const measured = areas(summaryFile);
const missed = [];

for (const a of measured) {
  const f = floors[a.name];
  if (!f) {
    missed.push(`${a.name}: no floor declared (add it to coverage-floors.json)`);
    continue;
  }
  const line = `${a.name.padEnd(12)} st ${a.statements.toFixed(1).padStart(5)}%  br ${a.branches.toFixed(1).padStart(5)}%  fn ${a.functions.toFixed(1).padStart(5)}%`;
  const under = ["statements", "branches", "functions"].filter((k) => a[k] < f.floor[k]);
  console.log(
    `${under.length ? "FAIL" : "PASS"}  ${line}${under.length ? `  under floor: ${under.map((k) => `${k} ${f.floor[k]}%`).join(", ")}` : ""}`,
  );
  for (const k of under) missed.push(`${a.name}: ${k} ${a[k].toFixed(1)}% < floor ${f.floor[k]}%`);
}

// An area that vanished from src/ (deleted or renamed) must not keep a stale floor.
for (const name of Object.keys(floors)) {
  if (!measured.some((a) => a.name === name))
    missed.push(`${name}: floor declared but the area no longer exists in src/`);
}

if (missed.length) {
  console.error(`\n${missed.length} coverage problem(s):`);
  for (const m of missed) console.error("  " + m);
  process.exit(1);
}
console.log("\nall coverage floors met");
