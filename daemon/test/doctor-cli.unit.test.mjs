// `pocketdesk doctor --json`: every probe, its result and the fix, in one machine-readable report.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const DAEMON = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("doctor --json reports every probe with its result and fix", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rh-doctor-"));
  const r = spawnSync(process.execPath, ["src/index.js", "doctor", "--json"], {
    cwd: DAEMON,
    encoding: "utf8",
    timeout: 120_000,
    env: { ...process.env, RH_HOME: home, POCKETDESK_DATA: path.join(home, "data") },
  });
  const report = JSON.parse(r.stdout);
  assert.equal(typeof report.ok, "boolean");
  assert.ok(Array.isArray(report.problems));
  assert.ok(Array.isArray(report.checks) && report.checks.length >= 3);
  for (const c of report.checks) {
    assert.equal(typeof c.name, "string");
    assert.equal(typeof c.ok, "boolean");
    assert.equal(typeof c.detail, "string");
    assert.ok("fix" in c, `${c.name} has no fix field`);
  }
  // A failing probe without a fix is a dead end for the person reading it.
  for (const c of report.checks.filter((x) => !x.ok)) assert.ok(c.fix, `${c.name} fails without a fix`);
  assert.deepEqual(
    report.problems,
    report.checks.filter((c) => !c.ok).map((c) => c.name),
  );
  assert.equal(r.status, report.ok ? 0 : 1);
});
