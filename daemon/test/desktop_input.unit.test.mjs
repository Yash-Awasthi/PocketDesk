// Desktop helper plumbing that runs on every OS, without a screen or a daemon.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { check, finish } from "./helpers.mjs";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "rh-deskin-"));
process.env.RH_HOME = home;
const { MacHelper, jpegRect, fromFraction, toFraction, centerFor } = await import("../src/desktop_capture.js");

// A viewer points at a fraction of its picture; the picture's pixel size never enters the mapping.
const second = { x: 1440, y: 0, w: 1920, h: 1080 };
const p = fromFraction(second, 0.5, 0.25);
check("a picture fraction lands inside the monitor it shows", p.x === 2400 && p.y === 270);
const back = toFraction(second, p);
check("the pointer maps back to the same fraction", back.fx === 0.5 && back.fy === 0.25);
const mons = [{ x: 0, y: 120, w: 1440, h: 900, primary: true }, { x: 1440, y: 0, w: 1920, h: 1080, primary: false }];
check("a macOS still frame shows the main display", jpegRect(mons, true) === mons[0]);
const all = jpegRect(mons, false);
check("a Windows still frame spans every monitor", all.x === 0 && all.y === 0 && all.w === 3360 && all.h === 1080);
check("no monitors known means no rect", jpegRect([], false) === null);

// Choosing a screen puts the pointer in its middle; opening one the pointer is already on leaves it be.
const right = { index: 1, x: 1440, y: 0, w: 1920, h: 1080 };
const mid = centerFor(right, { x: 100, y: 100 }, 0);
check("switching screens centres the pointer on the chosen one", mid?.x === 2400 && mid?.y === 540);
check("switching centres even when the pointer is already there", centerFor(right, { x: 2000, y: 10 }, 0)?.x === 2400);
check("first open keeps a pointer that is already on the screen", centerFor(right, { x: 2000, y: 10 }, undefined) === null);
check("first open brings a pointer from another screen", centerFor(right, { x: 100, y: 100 }, undefined)?.x === 2400);
check("the same screen again does not move the pointer", centerFor(right, { x: 100, y: 100 }, 1) === null);

// An upgrade ships new Swift source while the old binary on disk is newer than the old source.
const dir = path.join(home, "helpers");
fs.mkdirSync(dir, { recursive: true });
fs.writeFileSync(path.join(dir, "probe.swift"), "print(\"old\")\n");
fs.writeFileSync(path.join(dir, "probe"), "old binary");
const later = new Date(Date.now() + 60_000);
fs.utimesSync(path.join(dir, "probe"), later, later);

const h = new MacHelper("probe", "print(\"new\")\n");
try { h.ensureFile(); } catch { /* no swiftc off macOS; the source is what matters */ }
check("changed helper source replaces the stale copy", fs.readFileSync(path.join(dir, "probe.swift"), "utf8") === "print(\"new\")\n");
check("changed helper source forces a rebuild", h._compileFailedAt > 0 || fs.readFileSync(path.join(dir, "probe"), "utf8") !== "old binary");

fs.rmSync(home, { recursive: true, force: true });
finish();
