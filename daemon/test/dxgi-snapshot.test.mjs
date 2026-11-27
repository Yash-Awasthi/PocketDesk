// The DXGI snapshot route used to pass `-f ddagrab -i desktop`. ddagrab is a
// filter, so ffmpeg answered "Unknown input format" and the route reported
// failure every time it was tried; nothing caught it because no test looked at
// the argv. These assertions pin the shape that was measured working.
import assert from "node:assert/strict";
import test from "node:test";

import { dxgiArgs } from "../src/desktop/encode.js";

test("the DXGI snapshot asks ffmpeg for a filter, never for an input device", () => {
  const args = dxgiArgs(60, 0);
  assert.equal(args.includes("-i"), false, "no input device: there is nothing to open");
  assert.equal(args.includes("ddagrab"), false, "-f ddagrab is not an input format");
  assert.equal(args[args.indexOf("-filter_complex") + 1].startsWith("ddagrab="), true);
});

test("the filter chain downloads the surface and names one output", () => {
  const graph = dxgiArgs(60, 2)[dxgiArgs(60, 2).indexOf("-filter_complex") + 1];
  assert.match(graph, /output_idx=2/, "a monitor on another output is grabbed by index");
  assert.match(graph, /hwdownload/, "a GPU surface has to come back to system memory");
  assert.match(graph, /format=bgra/, "the encoder is fed a plain 8-bit layout");
  assert.match(graph, /dup_frames=1/, "a still screen yields no frame without this");
  assert.match(graph, /draw_mouse=0/, "viewers draw the pointer themselves");
});

test("one frame, MJPEG on a pipe, quality mapped to qscale", () => {
  const args = dxgiArgs(100, 0);
  assert.equal(args[args.indexOf("-frames:v") + 1], "1");
  assert.equal(args[args.indexOf("-vcodec") + 1], "mjpeg");
  assert.equal(args[args.indexOf("-f") + 1], "image2pipe");
  assert.equal(args[args.length - 1], "-", "the frame is written to stdout");

  const qscale = Number(args[args.indexOf("-qscale:v") + 1]);
  assert.equal(qscale, 3, "quality 100 is the best qscale mjpeg offers");
  assert.equal(
    Number(dxgiArgs(10, 0)[dxgiArgs(10, 0).indexOf("-qscale:v") + 1]),
    28,
    "quality 10 is the worst",
  );
  assert.equal(
    Number(dxgiArgs(1, 0)[dxgiArgs(1, 0).indexOf("-qscale:v") + 1]),
    28,
    "quality below 10 is clamped",
  );
  for (const q of [1, 40, 60, 95]) {
    const v = Number(dxgiArgs(q, 0)[dxgiArgs(q, 0).indexOf("-qscale:v") + 1]);
    assert.ok(v >= 1 && v <= 31, `qscale ${v} is outside the mjpeg range for quality ${q}`);
  }
});
