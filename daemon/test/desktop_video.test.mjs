import test from "node:test";
import assert from "node:assert/strict";
import { DesktopVideo, ENCODER_ORDER, FlvToAnnexB, FrameReader, KIND, av1WithSequenceHeader, ffmpegArgs, seiStamp, splitConfig, stampFrame, STAMP_UUID } from "../src/desktop_video.js";
import { macMonitors } from "../src/desktop_capture.js";

function tag(type, body) {
  const h = Buffer.alloc(11);
  h[0] = type;
  h.writeUIntBE(body.length, 1, 3);
  const prev = Buffer.alloc(4);
  prev.writeUInt32BE(11 + body.length);
  return Buffer.concat([h, body, prev]);
}

test("FLV video tags become Annex B packets, even when split byte by byte", () => {
  const sps = Buffer.from([0x67, 1, 2, 3]), pps = Buffer.from([0x68, 4]);
  const avcc = Buffer.concat([Buffer.from([1, 0x64, 0, 0x28, 0xff, 0xe1, 0, 4]), sps, Buffer.from([1, 0, 2]), pps]);
  const idr = Buffer.from([0x65, 9, 9]), p = Buffer.from([0x41, 7]);
  const len = (b) => { const l = Buffer.alloc(4); l.writeUInt32BE(b.length); return Buffer.concat([l, b]); };
  const header = Buffer.from([0x46, 0x4c, 0x56, 1, 1, 0, 0, 0, 9, 0, 0, 0, 0]);
  const flv = Buffer.concat([
    header,
    tag(18, Buffer.from("meta")),
    tag(9, Buffer.concat([Buffer.from([0x17, 0, 0, 0, 0]), avcc])),
    tag(9, Buffer.concat([Buffer.from([0x17, 1, 0, 0, 0]), len(idr)])),
    tag(9, Buffer.concat([Buffer.from([0x27, 1, 0, 0, 0]), len(p)])),
  ]);
  const demux = new FlvToAnnexB();
  const out = [];
  for (const byte of flv) out.push(...demux.push(Buffer.from([byte])));
  const sc = Buffer.from([0, 0, 0, 1]);
  assert.deepEqual(out.map((o) => o.kind), [KIND.config, KIND.key, KIND.delta]);
  assert.deepEqual(out[0].data, Buffer.concat([sc, sps, sc, pps]));
  assert.deepEqual(out[1].data, Buffer.concat([sc, idr]));
  assert.deepEqual(out[2].data, Buffer.concat([sc, p]));
});

test("congestion steps the preset down, and recovery never goes above what was asked", () => {
  const v = new DesktopVideo();
  v.setPreset("quality");
  assert.equal(v.stepDown(), true);
  assert.equal(v.stepDown(), true);
  assert.equal(v.stepDown(), true);
  assert.equal(v.preset, "low");
  assert.equal(v.stepDown(), false);
  assert.equal(v.stepUp(), true);
  assert.equal(v.stepUp(), true);
  assert.equal(v.stepUp(), true);
  assert.equal(v.preset, "quality");
  assert.equal(v.stepUp(), false);
  v.setPreset("balanced");
  v.stepDown();
  v.stepUp();
  assert.equal(v.stepUp(), false, "a viewer that asked for balanced is never raised to quality");
});

test("a monitor picks its output, and one on another GPU gets that GPU's device", () => {
  const first = ffmpegArgs("libx264", "balanced", null, "win32");
  assert.ok(!first.includes("-init_hw_device"));
  assert.match(first[first.indexOf("-filter_complex") + 1], /ddagrab=output_idx=0:.*draw_mouse=0/);
  const second = ffmpegArgs("libx264", "balanced", { adapter: 1, output: 2 }, "win32");
  assert.deepEqual(second.slice(3, 7), ["-init_hw_device", "d3d11va=rh:1", "-filter_hw_device", "rh"]);
  assert.match(second[second.indexOf("-filter_complex") + 1], /ddagrab=output_idx=2:/);
});

test("frame stamps survive as an SEI unit with no zero bytes to escape", () => {
  const ms = 1790000000123;
  const sei = seiStamp(ms);
  assert.deepEqual([...sei.subarray(0, 7)], [0, 0, 0, 1, 0x06, 0x05, 23]);
  const body = sei.subarray(4);
  assert.ok(!body.includes(0), "no 0x00 means no 00 00 0x start-code emulation");
  const at = sei.indexOf(STAMP_UUID) + 16;
  let v = 0;
  for (let i = 0; i < 7; i++) v = v * 128 + (sei[at + i] & 0x7f);
  assert.equal(v, ms);
});

test("macOS captures the chosen screen through avfoundation and tries VideoToolbox first", () => {
  const a = ffmpegArgs("h264_videotoolbox", "saver", { adapter: 0, output: 1 }, "darwin");
  assert.equal(a[a.indexOf("-f") + 1], "avfoundation");
  assert.equal(a[a.indexOf("-i") + 1], "Capture screen 1:none");
  assert.equal(a[a.indexOf("-capture_cursor") + 1], "0", "viewers draw the pointer themselves");
  assert.match(a[a.indexOf("-vf") + 1], /scale=trunc\(iw\*0\.6+\d*\/2\)\*2:-2,format=nv12/);
  assert.equal(a[a.indexOf("-b:v") + 1], "1500k");
  assert.ok(!a.includes("ddagrab") && !a.includes("-filter_complex"));
  assert.deepEqual(ENCODER_ORDER.darwin, ["h264_videotoolbox", "libx264"]);
});

test("macOS displays stay in points, the space input and the pointer use, whatever their pixel density", () => {
  const m = macMonitors([
    { x: 0, y: 0, w: 1440, h: 900, pw: 1440, ph: 900, primary: true },
    { x: 1440, y: -100, w: 1920, h: 1080, pw: 1920, ph: 1080, primary: false },
  ]);
  assert.deepEqual(m[0], { adapter: 0, output: 0, name: "Display 1", left: 0, top: 0, w: 1440, h: 900, primary: true });
  assert.deepEqual(m[1], { adapter: 0, output: 1, name: "Display 2", left: 1440, top: -100, w: 1920, h: 1080, primary: false });
});

const sc = Buffer.from([0, 0, 0, 1]);
const len32 = (b) => { const l = Buffer.alloc(4); l.writeUInt32BE(b.length); return Buffer.concat([l, b]); };
const flvHead = Buffer.from([0x46, 0x4c, 0x56, 1, 1, 0, 0, 0, 9, 0, 0, 0, 0]);

test("enhanced FLV carries HEVC: the config record and frames become Annex B", () => {
  const vps = Buffer.from([0x40, 1, 7]), sps = Buffer.from([0x42, 1, 8]), pps = Buffer.from([0x44, 1, 9]);
  const arr = (type, u) => Buffer.concat([Buffer.from([type, 0, 1, 0, u.length]), u]);
  const hvcc = Buffer.concat([Buffer.alloc(22), Buffer.from([3]), arr(32, vps), arr(33, sps), arr(34, pps)]);
  const idr = Buffer.from([0x26, 1, 5]), p = Buffer.from([0x02, 1, 6]);
  const ex = (frameType, packetType) => Buffer.from([0x80 | (frameType << 4) | packetType, ...Buffer.from("hvc1")]);
  const flv = Buffer.concat([flvHead,
    tag(9, Buffer.concat([ex(1, 0), hvcc])),
    tag(9, Buffer.concat([ex(1, 1), Buffer.from([0, 0, 0]), len32(idr)])),
    tag(9, Buffer.concat([ex(2, 3), len32(p)])),
  ]);
  const out = new FlvToAnnexB().push(flv);
  assert.deepEqual(out.map((o) => [o.kind, o.codec]), [[KIND.config, "hevc"], [KIND.key, "hevc"], [KIND.delta, "hevc"]]);
  assert.deepEqual(out[0].data, Buffer.concat([sc, vps, sc, sps, sc, pps]));
  assert.deepEqual(out[1].data, Buffer.concat([sc, idr]), "the composition time is skipped");
  assert.deepEqual(out[2].data, Buffer.concat([sc, p]));
});

test("enhanced FLV carries AV1: config OBUs and frames pass through", () => {
  const seq = Buffer.from([0x0a, 2, 0xaa, 0xbb]), frame = Buffer.from([0x32, 1, 0xcc]);
  const flv = Buffer.concat([flvHead,
    tag(9, Buffer.concat([Buffer.from([0x90, ...Buffer.from("av01")]), Buffer.from([0x81, 0, 0, 0]), seq])),
    tag(9, Buffer.concat([Buffer.from([0x91, ...Buffer.from("av01")]), frame])),
  ]);
  const out = new FlvToAnnexB().push(flv);
  assert.deepEqual(out.map((o) => [o.kind, o.codec]), [[KIND.config, "av1"], [KIND.key, "av1"]]);
  assert.deepEqual(out[0].data, seq, "the four-byte av1C header is dropped");
  assert.deepEqual(out[1].data, frame);
});

test("an AV1 keyframe gets its sequence header after the temporal delimiter, once", () => {
  const seq = Buffer.from([0x0a, 1, 0xaa]), td = Buffer.from([0x12, 0]), frame = Buffer.from([0x32, 1, 0xcc]);
  assert.deepEqual(av1WithSequenceHeader(seq, Buffer.concat([td, frame])), Buffer.concat([td, seq, frame]));
  assert.deepEqual(av1WithSequenceHeader(seq, frame), Buffer.concat([seq, frame]));
  const already = Buffer.concat([seq, frame]);
  assert.equal(av1WithSequenceHeader(seq, already), already);
});

test("parameter sets come off the front of a native keyframe", () => {
  const sps = Buffer.from([0x67, 1]), pps = Buffer.from([0x68, 2]), idr = Buffer.from([0x65, 3, 0]);
  const [config, frame] = splitConfig("h264", Buffer.concat([sc, sps, sc, pps, Buffer.from([0, 0, 1]), idr]));
  assert.deepEqual(config, Buffer.concat([sc, sps, sc, pps]));
  assert.deepEqual(frame, Buffer.concat([sc, idr]), "a trailing zero inside the unit is kept");
  const vps = Buffer.from([0x40, 1]), hidr = Buffer.from([0x26, 1]);
  const [hc, hf] = splitConfig("hevc", Buffer.concat([sc, vps, sc, hidr]));
  assert.deepEqual(hc, Buffer.concat([sc, vps]));
  assert.deepEqual(hf, Buffer.concat([sc, hidr]));
  const delta = Buffer.concat([sc, Buffer.from([0x41, 9])]);
  assert.deepEqual(splitConfig("h264", delta), [null, delta]);
});

test("native helper records split across reads come out whole", () => {
  const rec = (kind, data) => { const h = Buffer.alloc(5); h[0] = kind; h.writeUInt32BE(data.length, 1); return Buffer.concat([h, data]); };
  const all = Buffer.concat([rec(1, Buffer.from("key")), rec(3, Buffer.from("aac")), rec(2, Buffer.alloc(0))]);
  const r = new FrameReader();
  const out = [];
  for (const b of all) out.push(...r.push(Buffer.from([b])));
  assert.deepEqual(out.map((o) => [o.kind, o.data.toString()]), [[1, "key"], [3, "aac"], [2, ""]]);
});

test("each codec carries the frame time where its decoder skips it", () => {
  const ms = 1790000000123, f = Buffer.from([1, 2, 3]);
  const at = (b, i) => { let v = 0; for (let k = 0; k < 7; k++) v = v * 128 + (b[i + k] & 0x7f); return v; };
  const h = stampFrame("hevc", f, ms);
  assert.deepEqual([...h.subarray(0, 8)], [0, 0, 0, 1, 0x4e, 0x01, 0x05, 23], "an HEVC prefix SEI unit");
  assert.equal(at(h, 8 + 16), ms);
  assert.deepEqual(h.subarray(-3), f);
  const a = stampFrame("av1", f, ms);
  assert.deepEqual(a.subarray(0, 3), f, "the frame stays first");
  assert.deepEqual([...a.subarray(3, 5)], [0x7a, 23], "an AV1 padding OBU behind it");
  assert.equal(at(a, a.length - 7), ms);
});

test("encoders follow the viewers' codecs, and ones that failed beside a working one are skipped", () => {
  const v = new DesktopVideo();
  assert.deepEqual(v.candidates("win32"), ["h264_nvenc", "h264_qsv", "h264_amf", "libx264"], "an old viewer gets H.264 only");
  v.setCodecs(["hevc", "av1", "vp9"]);
  assert.deepEqual(v.codecs, ["av1", "hevc", "h264"]);
  assert.deepEqual(v.candidates("win32").slice(0, 4), ["av1_nvenc", "av1_qsv", "av1_amf", "hevc_nvenc"]);
  v.failed.add("av1_nvenc");
  assert.equal(v.candidates("win32")[0], "av1_qsv");
  assert.ok(v.candidates("win32").includes("h264_amf"), "AMD GPUs encode on the GPU too");
});

test("Linux X11 grabs one monitor's rectangle, and VA-API gets frames on the GPU", () => {
  const a = ffmpegArgs("libx264", "balanced", { x: 1920, y: 0, w: 2560, h: 1440 }, "linux");
  assert.equal(a[a.indexOf("-f") + 1], "x11grab");
  assert.equal(a[a.indexOf("-video_size") + 1], "2560x1440");
  assert.match(a[a.indexOf("-i") + 1], /\+1920,0$/);
  assert.equal(a[a.indexOf("-draw_mouse") + 1], "0");
  const v = ffmpegArgs("hevc_vaapi", "balanced", null, "linux");
  assert.equal(v[v.indexOf("-vaapi_device") + 1], "/dev/dri/renderD128");
  assert.match(v[v.indexOf("-vf") + 1], /format=nv12,hwupload$/);
  assert.equal(v[v.indexOf("-b:v") + 1], "6M");
});
