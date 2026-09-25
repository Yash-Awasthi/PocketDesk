import test from "node:test";
import assert from "node:assert/strict";
import { broadcastOf, wakeTargets } from "../src/wake.js";

test("directed broadcast fills the host bits", () => {
  assert.equal(broadcastOf("192.168.1.37", "255.255.255.0"), "192.168.1.255");
  assert.equal(broadcastOf("10.0.5.9", "255.255.240.0"), "10.0.15.255");
});

test("this PC reports at least one adapter MAC in AA:BB:CC:DD:EE:FF form", async () => {
  const w = await wakeTargets();
  assert.ok(w.macs.length > 0);
  for (const m of w.macs) assert.match(m.mac, /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/);
});
