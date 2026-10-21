import test from "node:test";
import assert from "node:assert/strict";
import { parseWlrRandr, moveArgs, buttonArgs, wtypeArgs, wfRecorderArgs, waylandDisplay } from "../src/wayland_desktop.js";

test("wlr-randr outputs become monitors in layout (logical) pixels, enabled ones only", () => {
  const json = JSON.stringify([
    { name: "eDP-1", enabled: true, scale: 2, position: { x: 0, y: 0 }, modes: [{ width: 2560, height: 1600, current: true }] },
    { name: "HDMI-A-1", enabled: true, scale: 1, position: { x: 1280, y: 0 }, modes: [{ width: 1920, height: 1080, current: false }, { width: 1280, height: 720, current: true }] },
    { name: "DP-2", enabled: false, scale: 1, position: { x: 0, y: 0 }, modes: [] },
  ]);
  assert.deepEqual(parseWlrRandr(json), [
    { index: 0, name: "eDP-1", w: 1280, h: 800, x: 0, y: 0, primary: true },
    { index: 1, name: "HDMI-A-1", w: 1280, h: 720, x: 1280, y: 0, primary: false },
  ]);
  assert.deepEqual(parseWlrRandr("not json"), []);
});

test("pointer moves go through the compositor, else ydotool", () => {
  assert.deepEqual(moveArgs("sway", 10.4, 20.6), ["swaymsg", ["seat", "-", "cursor", "set", "10", "21"]]);
  assert.deepEqual(moveArgs("hyprland", 10, 20), ["hyprctl", ["dispatch", "movecursor", "10", "20"]]);
  assert.deepEqual(moveArgs(null, 10, 20), ["ydotool", ["mousemove", "--absolute", "-x", "10", "-y", "20"]]);
});

test("buttons and the wheel", () => {
  assert.deepEqual(buttonArgs("sway", { click: "left" }), [["swaymsg", ["seat", "-", "cursor", "press", "button1"]], ["swaymsg", ["seat", "-", "cursor", "release", "button1"]]]);
  assert.deepEqual(buttonArgs(null, { click: "right" }), [["ydotool", ["click", "0xC1"]]]);
  assert.deepEqual(buttonArgs(null, { press: "down", button: "left" }), [["ydotool", ["click", "0x40"]]]);
  assert.deepEqual(buttonArgs(null, { wheel: -240 }), [["ydotool", ["mousemove", "--wheel", "-x", "0", "-y", "-2"]]]);
  assert.deepEqual(buttonArgs("sway", { wheel: 120 }), [["swaymsg", ["seat", "-", "cursor", "press", "button4"]], ["swaymsg", ["seat", "-", "cursor", "release", "button4"]]]);
});

test("keys and text through wtype, with the xdotool key names", () => {
  assert.deepEqual(wtypeArgs({ key: 0x0d }), ["-k", "Return"]);
  assert.deepEqual(wtypeArgs({ key: 0x43, modifiers: ["ctrl", "shift"] }), ["-M", "ctrl", "-M", "shift", "-k", "c", "-m", "ctrl", "-m", "shift"]);
  assert.deepEqual(wtypeArgs({ key: 0x41, press: "down" }), ["-P", "a"]);
  assert.equal(wtypeArgs({ key: 0x07 }), null);
  assert.deepEqual(wtypeArgs({ text: "-hi" }), ["--", "-hi"]);
});

test("wf-recorder writes FLV to stdout from one output, with the encoder's options", () => {
  const args = wfRecorderArgs("libx264", { fps: 30, scale: 0.5, q: 30, maxrate: "4M" }, { name: "eDP-1" });
  assert.deepEqual(args.slice(0, 4), ["-o", "eDP-1", "-c", "libx264"]);
  assert.ok(args.join(" ").includes("-p preset=ultrafast -p tune=zerolatency -p crf=28"));
  assert.ok(args.join(" ").includes("-r 30 -F scale=trunc(iw*0.5/2)*2:-2 -x yuv420p -p g=30 -p bf=0 -m flv -f /dev/stdout -y"));
  assert.ok(wfRecorderArgs("h264_vaapi", { fps: 60, scale: 1, q: 26, maxrate: "12M" }, null).join(" ").includes("-d /dev/dri/renderD128"));
});

test("the Wayland socket is found even when a user service started without WAYLAND_DISPLAY", () => {
  assert.equal(waylandDisplay({ WAYLAND_DISPLAY: "wayland-1" }), "wayland-1");
  assert.equal(waylandDisplay({}, () => ["bus", "wayland-0", "wayland-0.lock"]), "wayland-0");
  assert.equal(waylandDisplay({ XDG_RUNTIME_DIR: "/run/user/1000" }, () => ["bus"]), null);
});
