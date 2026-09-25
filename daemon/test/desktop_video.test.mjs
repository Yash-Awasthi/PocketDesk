import test from "node:test";
import assert from "node:assert/strict";
import { DesktopVideo, FlvToAnnexB, KIND } from "../src/desktop_video.js";

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
