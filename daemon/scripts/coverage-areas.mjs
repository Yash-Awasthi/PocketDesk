// What the daemon suite covers, per area of src/.
//
// `c8 --reporter=json-summary` writes coverage/coverage-summary.json; this groups it the way the
// plan asks for ("a floor per src/ area") and prints a table. Used ad hoc and by
// `scripts/check-coverage.mjs`, which applies the floors.
import fs from "node:fs";
import { pathToFileURL } from "node:url";

/** Areas are the two-level folders under src/; loose files are one group each. */
export function areas(summaryFile = new URL("../coverage/coverage-summary.json", import.meta.url)) {
  const summary = JSON.parse(fs.readFileSync(summaryFile, "utf8"));
  const out = new Map();
  for (const [file, v] of Object.entries(summary)) {
    if (file === "total") continue;
    const rel = file.split(/[\\/]/).join("/");
    const at = rel.lastIndexOf("/src/");
    if (at < 0) continue; // tests, scripts
    const parts = rel.slice(at + 5).split("/");
    const area = parts.length > 1 ? parts[0] : "src";
    const a = out.get(area) || {
      statements: 0,
      stTotal: 0,
      branches: 0,
      brTotal: 0,
      functions: 0,
      fnTotal: 0,
      files: 0,
    };
    a.statements += v.statements.covered;
    a.stTotal += v.statements.total;
    a.branches += v.branches.covered;
    a.brTotal += v.branches.total;
    a.functions += v.functions.covered;
    a.fnTotal += v.functions.total;
    a.files += 1;
    out.set(area, a);
  }
  const pct = (a, b) => (b === 0 ? 100 : Number(((a / b) * 100).toFixed(1)));
  return [...out]
    .map(([name, a]) => ({
      name,
      files: a.files,
      statements: pct(a.statements, a.stTotal),
      stTotal: a.stTotal,
      branches: pct(a.branches, a.brTotal),
      functions: pct(a.functions, a.fnTotal),
    }))
    .sort((x, y) => y.stTotal - x.stTotal);
}

const runDirectly = process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url;
if (runDirectly) {
  for (const a of areas()) {
    console.log(
      `${a.statements.toFixed(1).padStart(6)}% st  ${a.branches.toFixed(1).padStart(6)}% br  ${a.functions.toFixed(1).padStart(6)}% fn  ${String(a.files).padStart(3)} files  ${a.name}`,
    );
  }
}
