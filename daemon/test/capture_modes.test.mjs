// The capture policy is what the phone shows and what the daemon obeys, so both
// can be asserted without a window, a GPU or a protected process.
import assert from "node:assert/strict";
import test from "node:test";

import { MODE_IDS, classifyCause, describeModes, orderFor, verdict } from "../src/desktop/capture_modes.js";

test("auto tries the window render first, and the screen grab is not trusted more", () => {
  const order = orderFor("auto");
  assert.equal(order[0], "printwindow", "the occlusion-immune method leads");
  assert.equal(order[1], "screen");
  assert.deepEqual([...order].sort(), [...MODE_IDS].sort(), "auto covers every method exactly once");
  assert.equal(new Set(order).size, order.length);
});

test("the window DC method is never offered", () => {
  for (const id of [...orderFor("auto"), ...describeModes().map((m) => m.id)]) {
    assert.notEqual(id, "windowdc");
    assert.notEqual(id, "window-dc");
  }
});

test("auto ends with the only rung the user can see", () => {
  assert.equal(orderFor("auto").at(-1), "fullscreen");
});

test("an explicit mode is one rung", () => {
  assert.deepEqual(orderFor("dxgi"), ["dxgi"]);
  assert.deepEqual(orderFor("printwindow"), ["printwindow"]);
  assert.throws(() => orderFor("bitblt"), /unknown capture mode/);
});

test("the menu marks exactly one method as current", () => {
  for (const current of ["auto", ...MODE_IDS]) {
    const modes = describeModes(current);
    assert.equal(modes.filter((m) => m.current).length, 1, `current ${current}`);
    assert.equal(modes.find((m) => m.current).id, current);
    assert.ok(modes.every((m) => m.label.length > 0 && m.note.length > 0));
  }
});

test("every cause the helper can return has its own step", () => {
  const codes = [
    "needs_elevation",
    "protected_process",
    "architecture_mismatch",
    "unsupported_export",
    "no_window",
    "exclusive_fullscreen",
  ];
  const nexts = new Set();
  for (const code of codes) {
    const cause = classifyCause(code);
    assert.equal(cause.id, code);
    assert.ok(cause.say.length > 0 && cause.next.length > 0);
    nexts.add(cause.next);
  }
  assert.equal(nexts.size, codes.length, "two causes must not share a next step");
});

test("an unknown failure still says something specific", () => {
  const cause = classifyCause("whatever", "ffmpeg exited 1");
  assert.equal(cause.id, "unknown");
  assert.match(cause.say, /ffmpeg exited 1/);
});

test("the verdict refuses a scaled capture even when the pixels match", () => {
  const v = verdict({
    controlPct: 100,
    gatedPct: 0,
    reversePct: 100,
    width: 1280,
    height: 720,
    expectedWidth: 1600,
    expectedHeight: 900,
  });
  assert.equal(v.ok, false);
  assert.match(v.line, /scaled or cropped/);
});

test("the verdict refuses a window that was never hiding", () => {
  const v = verdict({
    controlPct: 0,
    gatedPct: 0,
    reversePct: 0,
    width: 1280,
    height: 720,
    expectedWidth: 1280,
    expectedHeight: 720,
  });
  assert.equal(v.ok, false);
  assert.match(v.line, /proves nothing/);
});

test("the verdict refuses a residual difference and a gate that did nothing", () => {
  const residual = verdict({
    controlPct: 100,
    gatedPct: 6.8,
    reversePct: 100,
    width: 1280,
    height: 720,
    expectedWidth: 1280,
    expectedHeight: 720,
  });
  assert.equal(residual.ok, false);
  assert.match(residual.line, /not the window's own/);

  const stuck = verdict({
    controlPct: 100,
    gatedPct: 0,
    reversePct: 0,
    width: 1280,
    height: 720,
    expectedWidth: 1280,
    expectedHeight: 720,
  });
  assert.equal(stuck.ok, false);
  assert.match(stuck.line, /something else is hiding/);
});

test("a measured lossless capture passes and says the numbers", () => {
  const v = verdict({
    controlPct: 100,
    gatedPct: 0,
    reversePct: 100,
    width: 1280,
    height: 720,
    expectedWidth: 1280,
    expectedHeight: 720,
  });
  assert.equal(v.ok, true);
  assert.match(v.line, /1280x720/);
  assert.match(v.line, /0\.00% differing/);
});
