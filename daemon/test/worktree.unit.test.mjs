import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { add } from "../src/worktree.js";

const git = (cwd, ...args) => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rh-wt-"));
const repo = path.join(tmp, "proj");
fs.mkdirSync(repo);
git(repo, "init", "-q");
fs.writeFileSync(path.join(repo, "a.txt"), "hi");
git(repo, "add", ".");
git(repo, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");

test("a session gets its own worktree next to the repo, on its own branch", () => {
  const wt = add(repo, "fix-login");
  assert.equal(wt, path.join(tmp, "proj-fix-login"));
  assert.equal(fs.readFileSync(path.join(wt, "a.txt"), "utf8"), "hi");
  assert.equal(git(wt, "rev-parse", "--abbrev-ref", "HEAD"), "pocketdesk/fix-login");
});

test("names are made safe and a taken name gets a suffix", () => {
  const wt = add(path.join(repo, "."), "../evil name");
  assert.equal(path.dirname(wt), tmp);
  assert.match(path.basename(wt), /^proj-evil-name$/);
  assert.equal(add(repo, "evil name"), path.join(tmp, "proj-evil-name-2"));
});

test("a folder from inside the repo resolves to the repo root", () => {
  fs.mkdirSync(path.join(repo, "sub"));
  assert.equal(path.dirname(add(path.join(repo, "sub"), "deep")), tmp);
});

test("a folder that is not a git repository is refused", () => {
  assert.throws(() => add(tmp, "x"), /not a git repository/);
});
