import test from "node:test";
import assert from "node:assert/strict";
import { CODECS, DesktopVideo, ENCODER_ORDER, codecOf } from "../src/desktop_video.js";

// Synthetic capability matrix: what a viewer reports it can decode, including a phone that reports nothing.
const MATRIX = [
  [],
  undefined,
  ["vp9"],
  ["h264"],
  ["hevc", "h264"],
  ["av1", "hevc", "h264"],
  ["av1"],
  ["hevc"],
];

const rank = (codec) => CODECS.indexOf(codec);

// Best codec in the AV1, HEVC, H.264 order that the viewer shares, H.264 being the floor.
function bestShared(reported) {
  const list = Array.isArray(reported) ? reported : [];
  return CODECS.find((c) => list.includes(c)) || "h264";
}

const label = (reported) => (reported === undefined ? "no list" : JSON.stringify(reported));

test("every viewer capability row negotiates a codec list anchored at H.264 and a best-first candidate", () => {
  for (const reported of MATRIX) {
    const v = new DesktopVideo();
    v.setCodecs(reported);
    const at = `viewer ${label(reported)}`;

    for (const c of v.codecs) assert.ok(CODECS.includes(c), `${at}: ${c} is not a known codec`);
    assert.equal(new Set(v.codecs).size, v.codecs.length, `${at}: codec list has duplicates`);
    assert.deepEqual(
      v.codecs,
      [...v.codecs].sort((a, b) => rank(a) - rank(b)),
      `${at}: codec list is not AV1, HEVC, H.264 ordered`,
    );
    assert.equal(v.codecs.at(-1), "h264", `${at}: H.264 is not the floor`);
    assert.equal(v.codecs.filter((c) => c === "h264").length, 1, `${at}: H.264 should appear once`);

    const cands = v.candidates("win32");
    for (const enc of cands)
      assert.ok(v.codecs.includes(codecOf(enc)), `${at}: ${enc} encodes a codec the viewer cannot decode`);
    if (!Array.isArray(reported) || !reported.includes("av1"))
      assert.ok(!cands.some((e) => codecOf(e) === "av1"), `${at}: AV1 offered though not reported`);
    if (!Array.isArray(reported) || !reported.includes("hevc"))
      assert.ok(!cands.some((e) => codecOf(e) === "hevc"), `${at}: HEVC offered though not reported`);
    assert.equal(
      codecOf(cands[0]),
      bestShared(reported),
      `${at}: first candidate is not the best shared codec`,
    );
  }
});

test("a viewer that reports nothing still gets H.264 candidates, including the CPU floor", () => {
  const v = new DesktopVideo();
  v.setCodecs([]);
  assert.deepEqual(v.codecs, ["h264"]);
  assert.deepEqual(v.candidates("win32"), ["h264_nvenc", "h264_qsv", "h264_amf", "libx264"]);
  assert.deepEqual(v.candidates("linux"), ["h264_nvenc", "h264_vaapi", "libx264"]);
  assert.ok(
    v.candidates("win32").every((e) => codecOf(e) === "h264"),
    "phone reports no decoder: nothing but H.264",
  );
  assert.equal(v.candidates("win32").at(-1), "libx264", "CPU floor is tried last on win32");
  assert.equal(v.candidates("linux").at(-1), "libx264", "CPU floor is tried last on linux");
});

test("an unknown-only report behaves like no report at all", () => {
  for (const reported of [undefined, [], ["vp9", "theora"]]) {
    const v = new DesktopVideo();
    v.setCodecs(reported);
    assert.deepEqual(v.codecs, ["h264"], `viewer ${label(reported)}`);
  }
});

// Mirrors start(): try candidates in order, remember failures, and record them once one works.
function firstWorking(v, works, platform) {
  const tried = [];
  for (const enc of v.candidates(platform)) {
    if (works.has(enc)) {
      for (const t of tried) v.failed.add(t);
      return enc;
    }
    tried.push(enc);
  }
  return null;
}

test("fallback walks down the codec order and never climbs back up", () => {
  const workingSets = [
    new Set(["libx264"]),
    new Set(["h264_qsv"]),
    new Set(["hevc_nvenc"]),
    new Set(["av1_amf"]),
    new Set(["av1_qsv", "hevc_amf"]),
    new Set(),
  ];
  for (const reported of MATRIX) {
    for (const works of workingSets) {
      const v = new DesktopVideo();
      v.setCodecs(reported);
      const at = `viewer ${label(reported)} with ${[...works].join("+") || "nothing"} working`;
      const enc = firstWorking(v, works, "win32");

      // Walk the order the way start() does and prove the codec rank never climbs back up.
      const sequence = [];
      for (const e of v.candidates("win32")) {
        const prev = sequence.at(-1);
        if (prev)
          assert.ok(
            rank(codecOf(e)) >= rank(codecOf(prev)),
            `${at}: codec order climbed from ${codecOf(prev)} to ${codecOf(e)}`,
          );
        sequence.push(e);
        if (works.has(e)) break;
      }
      if (enc) assert.equal(sequence.at(-1), enc, `${at}: walk diverged from firstWorking`);
      else
        assert.equal(
          sequence.length,
          v.candidates("win32").length,
          `${at}: walk stopped before a working encoder existed`,
        );

      const available = new Set(
        (ENCODER_ORDER.win32 || []).filter((e) => works.has(e) && v.codecs.includes(codecOf(e))).map(codecOf),
      );
      const bestAvailable = CODECS.find((c) => available.has(c)) || null;
      assert.equal(
        enc ? codecOf(enc) : null,
        bestAvailable,
        `${at}: did not settle on the best available codec`,
      );

      if (works.has("libx264")) assert.equal(enc, "libx264", `${at}: H.264 floor should always start`);
    }
  }
});

test("macOS and Wayland fall back within H.264 only, with libx264 last", () => {
  for (const platform of ["darwin", "wayland"]) {
    const order = ENCODER_ORDER[platform];
    assert.equal(order.at(-1), "libx264", `${platform}: libx264 is not the last resort`);
    assert.ok(
      order.every((e) => codecOf(e) === "h264"),
      `${platform}: order holds a codec other than H.264`,
    );
    for (const reported of MATRIX) {
      const v = new DesktopVideo();
      v.setCodecs(reported);
      const cands = v.candidates(platform);
      assert.ok(cands.length > 0, `${platform} viewer ${label(reported)}: no candidates at all`);
      assert.ok(
        cands.every((e) => codecOf(e) === "h264"),
        `${platform} viewer ${label(reported)}: offered AV1 or HEVC`,
      );
      assert.equal(codecOf(cands[0]), "h264", `${platform} viewer ${label(reported)}: H.264 is not first`);
      assert.equal(cands.at(-1), "libx264", `${platform} viewer ${label(reported)}: libx264 is not last`);
    }
  }
});
