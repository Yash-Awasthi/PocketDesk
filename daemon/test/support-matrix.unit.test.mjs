// Checks the support matrix doc against ci.yml and the Android build file.
// No network and no daemon spawn: this is a static consistency test.
import fs from "node:fs";
import path from "node:path";
import { REPO, check, finish } from "./helpers.mjs";

const docPath = path.join(REPO, "docs", "SUPPORT-MATRIX.md");
const ciPath = path.join(REPO, ".github", "workflows", "ci.yml");
const buildPath = path.join(REPO, "app", "app", "build.gradle.kts");

const docExists = fs.existsSync(docPath);
check("docs/SUPPORT-MATRIX.md exists", docExists);
const doc = docExists ? fs.readFileSync(docPath, "utf8") : "";
const ci = fs.readFileSync(ciPath, "utf8");
const build = fs.readFileSync(buildPath, "utf8");

// 1. The doc names every supported platform family.
for (const name of ["Windows", "macOS", "Linux", "Android"]) {
  check(`doc mentions ${name}`, new RegExp(name, "i").test(doc));
}

// 2. The CI workflow covers the three desktop runner families.
for (const runner of ["windows-latest", "ubuntu-latest", "macos-latest"]) {
  check(`ci.yml contains ${runner}`, ci.includes(runner));
}

// 3. Both SDK levels are in the emulator matrix.
const minSdk = Number((build.match(/minSdk\s*=\s*(\d+)/) || [])[1]);
const targetSdk = Number((build.match(/targetSdk\s*=\s*(\d+)/) || [])[1]);
check("minSdk parsed from build.gradle.kts", Number.isInteger(minSdk) && minSdk > 0);
check("targetSdk parsed from build.gradle.kts", Number.isInteger(targetSdk) && targetSdk > 0);

const apiMatch = ci.match(/api-level:\s*\[([^\]]+)\]/);
const apiLevels = apiMatch ? apiMatch[1].split(",").map((s) => Number(s.trim())).filter(Number.isInteger) : [];
check("ci.yml has an api-level matrix", apiLevels.length > 0);
check(`emulator matrix contains minSdk ${minSdk}`, apiLevels.includes(minSdk));
check(`emulator matrix contains targetSdk ${targetSdk}`, apiLevels.includes(targetSdk));

// 4. Four platform rows, each with four non-empty data cells.
// A row starts with "|"; its split keeps the leading empty cell and an optional trailing one.
function rowCells(line) {
  const cells = line.split("|").map((s) => s.trim());
  if (cells.length && cells[cells.length - 1] === "") cells.pop();
  return cells;
}

const tableLines = doc.split(/\r?\n/).filter((line) => line.trimStart().startsWith("|"));
const platformRows = tableLines.filter((line) => {
  const cells = rowCells(line);
  const label = cells[1] || "";
  return label && !/^platform$/i.test(label) && !/^-+$/.test(label);
});

check("doc table has exactly four platform rows", platformRows.length === 4);
for (const line of platformRows) {
  const cells = rowCells(line);
  const label = cells[1] || "unknown";
  check(`${label} row has five cells`, cells.length === 5);
  check(`${label} row has four non-empty data cells`, cells.filter((c) => c.length > 0).length === 4);
}

const findRow = (re) => platformRows.find((line) => re.test(rowCells(line)[1] || "")) || "";
const windowsRow = findRow(/windows/i);
const macRow = findRow(/macos/i);
const linuxRow = findRow(/linux/i);
const androidRow = findRow(/android/i);
for (const [name, row] of [["Windows", windowsRow], ["macOS", macRow], ["Linux", linuxRow], ["Android", androidRow]]) {
  check(`found ${name} platform row`, row.length > 0);
}

// 5. Android floor is API 30 and Android 8-10 are explicitly unsupported.
const androidText = rowCells(androidRow).join(" ");
check("Android row states API 30", /API\s*30/i.test(androidText));
check("doc states Android 8-10 are not supported", /Android\s*8\s*-\s*10\b[^.]*\b(?:not|unsupported)/i.test(doc));
check("doc does not claim Android 8+ is supported", !/Android\s*8\s*\+\s*(?:is\s+|are\s+)?supported/i.test(doc));

// 6. The native helpers are Windows only.
const windowsText = rowCells(windowsRow).join(" ");
check("Windows row says the native helpers are Windows only", /windows only/i.test(windowsText));
check("Windows row names the virtual camera", /virtual camera|\bvcam\b/i.test(windowsText));
check("Windows row names the pad driver", /\bpad\b|vigem/i.test(windowsText));

finish();
