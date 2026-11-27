import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import { forPlatform, validateManifest, parseVersion, checkCompat } from "../src/registry.js";

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

const good = { id: "alpha", name: "Alpha", adapter: "terminal", bin: "alpha" };

test("a complete manifest validates with no errors and no warnings", () => {
  const r = validateManifest(good, "alpha.json");
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.ok, true);
});

test("a manifest without an id fails and names the file and the field", () => {
  const r = validateManifest({ ...good, id: undefined }, "bad.json");
  assert.equal(r.ok, false);
  assert.ok(r.errors.includes("bad.json: id: required"), r.errors.join("\n"));
});

test("an unknown adapter fails and names the known set", () => {
  const r = validateManifest({ ...good, adapter: "gpt5" }, "bad.json");
  assert.equal(r.ok, false);
  assert.ok(
    r.errors.includes('bad.json: adapter: unknown "gpt5" (known: terminal, gui)'),
    r.errors.join("\n"),
  );
});

test("a malformed chat.args fails and names chat.args", () => {
  for (const chat of [
    { args: "not an array" },
    { args: ["ok", 3] },
    { models: { opus: { args: "nope" } } },
  ]) {
    const r = validateManifest({ ...good, chat }, "bad.json");
    assert.equal(r.ok, false, JSON.stringify(chat));
    assert.ok(
      r.errors.some((e) => e.startsWith("bad.json: chat.args:") || e.startsWith("bad.json: chat.models.")),
      r.errors.join("\n"),
    );
  }
});

test("a non-object manifest is one error naming the file", () => {
  for (const bad of [null, "text", [1, 2]]) {
    const r = validateManifest(bad, "bad.json");
    assert.equal(r.ok, false);
    assert.deepEqual(r.errors, ["bad.json: manifest: must be a JSON object"]);
  }
});

test("parseVersion reads the first x.y.z triple and never invents one", () => {
  assert.deepEqual(parseVersion("claude 2.4.1 (Claude Code)"), { version: "2.4.1", parts: [2, 4, 1] });
  assert.equal(parseVersion("v1.2.3").version, "1.2.3");
  assert.equal(parseVersion("2.4.1").version, "2.4.1");
  assert.equal(parseVersion("no version here"), null);
  assert.equal(parseVersion(""), null);
  assert.equal(parseVersion(undefined), null);
});

test("compat compares numerically against compat.minVersion", () => {
  const min = { compat: { minVersion: "2.0.0" } };
  const below = checkCompat(min, "1.2.3");
  assert.equal(below.installed, true);
  assert.equal(below.version, "1.2.3");
  assert.equal(below.expected, "2.0.0");
  assert.equal(below.ok, false);

  assert.equal(checkCompat(min, "2.0.0").ok, true);
  assert.equal(checkCompat(min, "v2.10.1").ok, true);

  const any = checkCompat({}, "1.2.3");
  assert.equal(any.expected, "any");
  assert.equal(any.ok, true);

  const absent = checkCompat({}, "no version here");
  assert.equal(absent.installed, false);
  assert.equal(absent.version, "not installed");
  assert.equal(absent.ok, false);
});
