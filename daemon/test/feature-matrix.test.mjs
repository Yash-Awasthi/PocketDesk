// The feature matrix once marked fifteen removed surfaces as shipped. This keeps the
// ✅ column honest: a family that no longer has a handler may not sit behind a ✅, and
// the historical protocol section has to say it is historical.
import fs from "node:fs";
import path from "node:path";
import { REPO, check, finish } from "./helpers.mjs";

const matrixPath = path.join(REPO, "docs", "FEATURE-MATRIX.md");
const matrix = fs.readFileSync(matrixPath, "utf8");
const rows = matrix.split(/\r?\n/).filter((l) => l.startsWith("|"));

// Message families that were removed from the daemon. None of these names exists in
// daemon/src/handlers/, so a row cannot honestly claim one with a ✅.
const DEAD_FAMILIES = [
  "share_create",
  "share_join",
  "share_list",
  "share_revoke",
  "wt_create",
  "wt_list",
  "wt_remove",
  "record_asciicast",
  "record_start",
  "record_stop",
  "lan_peers",
  "lan_send",
  "vnc_start",
  "vnc_stop",
  "vnc_frame",
  "notify_send",
  "notify_stats",
  "notify_bursts",
  "mcp_start",
  "mcp_stop",
  "mcp_status",
  "tunnel_create",
  "tunnel_close",
  "relay_connect",
  "relay_disconnect",
  "relay_publish",
  "render_digest",
  "digest_render",
  "digest_attach",
  "quiet_set",
  "session_quiet",
];

const lying = [];
for (const row of rows) {
  if (!row.includes("✅")) continue;
  const hit = DEAD_FAMILIES.filter((f) => row.includes(`\`${f}\``));
  if (hit.length) lying.push(`${hit.join("+")} in: ${row.slice(0, 80)}…`);
}
check(
  lying.length === 0
    ? "no ✅ row claims a removed message family"
    : `no ✅ row claims a removed message family (offenders: ${lying.join(" | ")})`,
  lying.length === 0,
);

// The names in DEAD_FAMILIES really are dead: if a handler comes back, this list is
// wrong and the test should be relaxed rather than silently passing.
const handlerText = fs
  .readdirSync(path.join(REPO, "daemon", "src", "handlers"))
  .map((f) => fs.readFileSync(path.join(REPO, "daemon", "src", "handlers", f), "utf8"))
  .join("\n");
const resurrected = DEAD_FAMILIES.filter((f) =>
  new RegExp(`^\\s{4}(?:async\\s+)?${f}\\s*\\(`, "m").test(handlerText),
);
check(
  resurrected.length === 0
    ? "the removed families still have no handler"
    : `the removed families still have no handler (back in the tree: ${resurrected.join(", ")})`,
  resurrected.length === 0,
);

// The old protocol summary is labelled historical, with the count it was checked against.
check(
  "the absorption-pass protocol section is labelled historical",
  /^## What one absorption pass claimed \(2026-09, historical\)$/m.test(matrix),
);
check("the historical section carries the re-check note", /Re-checked 2026-11-24/.test(matrix));
check("the historical section points at the live protocol", /README\.md#-protocol-v1/.test(matrix));

// The legend must still explain every mark the file uses.
for (const mark of ["✅", "⚙️", "🧩", "🗺️", "➖"]) {
  check(`the legend explains ${mark}`, matrix.includes(`| ${mark} |`));
}

finish();
