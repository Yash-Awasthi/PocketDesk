import test from "node:test";
import assert from "node:assert/strict";
import { versionProbe } from "../src/doctor.js";

test("Windows probes through cmd.exe so .cmd shims resolve", () => {
  assert.deepEqual(versionProbe({ bin: "claude" }, "win32"), ["cmd.exe", ["/c", "claude", "--version"]]);
});

test("Linux and macOS run the tool itself, with the manifest as that OS sees it", () => {
  assert.deepEqual(versionProbe({ bin: "claude" }, "linux"), ["claude", ["--version"]]);
  const shell = { bin: "powershell.exe", platforms: { unix: { bin: "/bin/bash" } } };
  assert.deepEqual(versionProbe(shell, "darwin"), ["/bin/bash", ["--version"]]);
});
