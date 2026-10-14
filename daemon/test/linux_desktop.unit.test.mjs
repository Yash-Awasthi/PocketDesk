// Linux X11 helpers: pure functions, no display needed.
import test from "node:test";
import assert from "node:assert/strict";
import { parseXrandrMonitors, xdoKey, xdoChord } from "../src/linux_desktop.js";

test("xrandr --listmonitors parses geometry, order and the primary star", () => {
  const text = [
    "Monitors: 2",
    " 0: +*eDP-1 1920/344x1080/194+0+0  eDP-1",
    " 1: +HDMI-1 2560/597x1440/336+1920+0  HDMI-1",
  ].join("\n");
  const m = parseXrandrMonitors(text);
  assert.equal(m.length, 2);
  assert.deepEqual(m[0], { index: 0, name: "eDP-1", w: 1920, h: 1080, x: 0, y: 0, primary: true });
  assert.deepEqual(m[1], { index: 1, name: "HDMI-1", w: 2560, h: 1440, x: 1920, y: 0, primary: false });
});

test("virtual keys map to xdotool key names", () => {
  assert.equal(xdoKey(0x41), "a");
  assert.equal(xdoKey(0x5a), "z");
  assert.equal(xdoKey(0x30), "0");
  assert.equal(xdoKey(0x1b), "Escape");
  assert.equal(xdoKey(0x25), "Left");
  assert.equal(xdoKey(0x70), "F1");
  assert.equal(xdoKey(0x87), "F24");
  assert.equal(xdoKey(0x60), "KP_0");
  assert.equal(xdoKey(0xaf), "XF86AudioRaiseVolume");
  assert.equal(xdoKey(0x999), null);
});

test("a chord carries its modifiers in xdotool's form", () => {
  assert.equal(xdoChord(0x43, ["ctrl"]), "ctrl+c");
  assert.equal(xdoChord(0x09, ["alt"]), "alt+Tab");
  assert.equal(xdoChord(0x25, ["ctrl", "win"]), "ctrl+super+Left");
  assert.equal(xdoChord(0x999, ["ctrl"]), null);
});
