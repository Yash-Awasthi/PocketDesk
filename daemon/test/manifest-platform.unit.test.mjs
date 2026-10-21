import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { forPlatform } from "../src/registry.js";

const shell = JSON.parse(fs.readFileSync(new URL("../manifests/shell.json", import.meta.url), "utf8"));

test("the shell tool is PowerShell on Windows", () => {
  const m = forPlatform(shell, "win32", {});
  assert.equal(m.bin, "powershell.exe");
  assert.equal(m.name, "PowerShell");
});

test("on Linux and macOS it is the user's login shell, or /bin/sh", () => {
  assert.equal(forPlatform(shell, "linux", { SHELL: "/usr/bin/zsh" }).bin, "/usr/bin/zsh");
  assert.equal(forPlatform(shell, "darwin", {}).bin, "/bin/sh");
  assert.equal(forPlatform(shell, "linux", {}).name, "Shell");
});

test("an exact platform beats unix, and manifests without platforms are untouched", () => {
  const m = { id: "x", bin: "a", platforms: { unix: { bin: "b" }, darwin: { bin: "c" } } };
  assert.equal(forPlatform(m, "darwin", {}).bin, "c");
  assert.equal(forPlatform(m, "linux", {}).bin, "b");
  assert.deepEqual(forPlatform({ id: "y", bin: "z" }, "linux", {}), { id: "y", bin: "z" });
});
