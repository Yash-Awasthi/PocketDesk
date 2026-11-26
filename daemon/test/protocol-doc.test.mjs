// daemon/README.md documents every message the daemon answers, with the handler file.
// It is generated, so the only thing to test is that it is current: regenerate into a
// buffer and compare, which is what `--check` does.
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { REPO, check, finish } from "./helpers.mjs";

const script = path.join(REPO, "daemon", "scripts", "gen-protocol-doc.mjs");
const readme = path.join(REPO, "daemon", "README.md");
check("the generator exists", fs.existsSync(script));
check("daemon/README.md exists", fs.existsSync(readme));

let out;
let code = 0;
try {
  out = execFileSync(process.execPath, [script, "--check"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (e) {
  code = e.status ?? 1;
  out = `${e.stdout || ""}${e.stderr || ""}`;
}
check(
  code === 0
    ? "the protocol table is current"
    : "the protocol table is current (stale — run: node daemon/scripts/gen-protocol-doc.mjs)",
  code === 0,
);
check("the check reports how many messages it covers", /\d+ message types/.test(out), out.trim());

const text = fs.readFileSync(readme, "utf8");
check(
  "the table is inside its markers",
  (text.match(/<!-- BEGIN protocol-table -->/g) || []).length === 1 &&
    (text.match(/<!-- END protocol-table -->/g) || []).length === 1,
);
check("the README says the table is generated", /Do not edit by hand/.test(text));

const rows = text.split(/\r?\n/).filter((l) => /^\| `[a-z0-9_]+` \| `src\/[a-z_/.]+` \|$/.test(l));
check(`the table has a row per message (${rows.length})`, rows.length > 150);

const types = rows.map((r) => r.split("`")[1]);
check(
  "no message appears twice",
  new Set(types).size === types.length,
  `${types.length} rows, ${new Set(types).size} distinct`,
);

// A message named in the table must be a real handler method or a server-level assignment.
check("a known message is listed", types.includes("chatsession") && types.includes("fs_op"));
check(
  "a message removed from the daemon is not listed",
  !types.includes("share_create") && !types.includes("mcp_start"),
);

// Every listed handler file exists.
const files = [...new Set(rows.map((r) => r.split("`")[3]))];
const missingFiles = files.filter((f) => !fs.existsSync(path.join(REPO, "daemon", f)));
check(
  missingFiles.length === 0
    ? `every listed handler file exists (${files.length} files)`
    : `every listed handler file exists (missing: ${missingFiles.join(", ")})`,
  missingFiles.length === 0,
);

// The compatibility rule in docs/adr/0001-protocol-changes.md: an addition is free, a removal or a
// changed field list needs a version bump and a note. The checker is table-driven over the README
// and the generated table, so this runs it and confirms the baseline it read is the documented one.
const compatScript = path.join(REPO, "daemon", "scripts", "gen-protocol-compat.mjs");
const baselinePath = path.join(REPO, "daemon", "protocol", "compat.json");
check("the compatibility checker exists", fs.existsSync(compatScript));
check("the compatibility baseline exists", fs.existsSync(baselinePath));

let compatOut;
let compatCode = 0;
try {
  compatOut = execFileSync(process.execPath, [compatScript, "--check"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
} catch (e) {
  compatCode = e.status ?? 1;
  compatOut = `${e.stdout || ""}${e.stderr || ""}`;
}
check(
  compatCode === 0
    ? "the compatibility baseline is current"
    : `the compatibility baseline is current (${compatOut.trim().split("\n").pop()})`,
  compatCode === 0,
);
check(
  "the check names the version and the message count",
  /protocol v\d+/.test(compatOut) && /\d+ messages/.test(compatOut),
);

const baseline = JSON.parse(fs.readFileSync(baselinePath, "utf8"));
const rootReadme = fs.readFileSync(path.join(REPO, "README.md"), "utf8");
check(
  `the baseline version matches the README heading (v${baseline.protocolVersion})`,
  new RegExp(`Protocol \\(v${baseline.protocolVersion}\\)`).test(rootReadme),
);
check(
  `every message in the generated table is in the baseline (${types.length})`,
  types.every((type) => Object.hasOwn(baseline.messages, type)),
);
check(
  `the baseline records no message the table dropped (${Object.keys(baseline.messages).length})`,
  Object.keys(baseline.messages).length === types.length,
);

const adr = fs.readFileSync(path.join(REPO, "docs", "adr", "0001-protocol-changes.md"), "utf8");
check("the ADR says an addition is additive", /additive/i.test(adr));
check("the ADR requires a version bump for a removal or change", /version bump/i.test(adr));
check(
  "the ADR keeps a compatibility note log",
  /^## Compatibility notes/m.test(adr) && /^- v\d+: /m.test(adr),
);
check(
  "the README protocol section states the same rule",
  /adding a message is additive/.test(rootReadme) && /removing, renaming or changing/i.test(rootReadme),
);

finish();
