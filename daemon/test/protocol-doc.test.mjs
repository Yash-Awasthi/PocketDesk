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

finish();
