// Console mode (RH_CONSOLE) runs the daemon as SYSTEM on the secure desktop. It must change
// *who* may see the screen, never *what* the screen looks like: the capture geometry and the
// encoder arguments have to be identical with and without it.
//
// `IS_CONSOLE` is read when desktop_capture.js/desktop_video.js load, so the comparison runs in
// two `node -e` subprocesses rather than in this process, where the flag cannot change.
import path from "node:path";
import { execFileSync } from "node:child_process";
import { REPO, check, finish } from "./helpers.mjs";

const probe = `
const { toFraction, fromFraction, centerFor } = await import("./src/desktop_capture.js");
const { ffmpegArgs } = await import("./src/desktop_video.js");
const list = [
  { x: 0, y: 0, w: 2560, h: 1440, primary: true, name: "DISPLAY1" },
  { x: 2560, y: 120, w: 1920, h: 1080, primary: false, name: "DISPLAY2" },
];
const out = {
  fraction: list.map((m) => toFraction(m, 0.25, 0.75)),
  back: list.map((m) => fromFraction(m, 0.5, 0.5)),
  center0: centerFor(list[0], { x: 10, y: 10 }, 0),
  center1: centerFor(list[1], { x: 3000, y: 300 }, 0),
  args: [
    ffmpegArgs("libx264", "balanced", list[0], "win32"),
    ffmpegArgs("libx264", "balanced", list[1], "win32"),
    ffmpegArgs("h264_nvenc", "quality", list[0], "win32"),
    ffmpegArgs("libx264", "balanced", list[0], "darwin"),
  ],
};
process.stdout.write(JSON.stringify(out));
`;

function run(consoleMode) {
  const env = { ...process.env };
  delete env.RH_CONSOLE;
  if (consoleMode) env.RH_CONSOLE = "1";
  return execFileSync(process.execPath, ["--input-type=module", "-e", probe], {
    cwd: REPO + "/daemon",
    env,
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

let plain = "";
let console_ = "";
let err = "";
try {
  plain = run(false);
  console_ = run(true);
} catch (e) {
  err = `${e.stdout || ""}${e.stderr || ""}`.split("\n").slice(0, 4).join(" | ");
}
check("the geometry/encoder probe runs in both modes", plain.length > 0 && console_.length > 0, err);

if (plain && console_) {
  check("console mode does not change capture geometry or encoder args", plain === console_,
    plain === console_ ? "" : `plain ${plain.length} bytes vs console ${console_.length} bytes`);
  // Guard against the comparison passing because both sides are empty or both threw.
  const parsed = JSON.parse(plain);
  check("the probe produced real arguments", Array.isArray(parsed.args) && parsed.args.every((a) => Array.isArray(a) && a.length > 5));
  check("the probe covers monitors with different origins", parsed.center0.x !== parsed.center1.x);
  check("the console run is a separate process, so the flag really was read at load", plain === run(false));
}

finish();
