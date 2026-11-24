// A badge that counts something must be counting the thing that exists. The README
// claims a test count; this reads the tree and fails when the two drift apart, so the
// number cannot quietly go stale again.
import fs from "node:fs";
import path from "node:path";
import { REPO, check, finish } from "./helpers.mjs";

const readme = fs.readFileSync(path.join(REPO, "README.md"), "utf8");
const testDir = path.join(REPO, "daemon", "test");
const files = fs.readdirSync(testDir).filter((f) => f.endsWith(".test.mjs"));
const actual = files.length;

const badge = /badge\/Tests-(\d+)%20(\w+)-brightgreen\.svg/.exec(readme);
check("README carries a test-count badge", badge !== null);
if (badge) {
  check(
    `the badge count matches the ${actual} test files in daemon/test`,
    Number(badge[1]) === actual,
    `badge says ${badge[1]} ${badge[2]}, tree has ${actual}`,
  );
  check("the badge counts files, which is what each npm-test entry is", badge[2] === "files", `badge unit: ${badge[2]}`);
  check("the badge links to the testing section", /\]\(#testing\)/.test(readme));
}

// The testing section has to name the command that actually runs them.
const testing = readme.slice(readme.indexOf("## 🧪 Testing"));
check("the testing section shows the real npm command", /npm\.cmd test/.test(testing.slice(0, 600)));
check("the testing section names the per-file entrypoints it shows", /node test\/smoke\.test\.mjs/.test(testing.slice(0, 800)) && fs.existsSync(path.join(testDir, "smoke.test.mjs")));

finish();
