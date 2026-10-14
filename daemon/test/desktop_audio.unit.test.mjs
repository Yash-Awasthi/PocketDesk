// PC-sound plumbing that runs on every OS, without a sound card.
import test from "node:test";
import assert from "node:assert/strict";
import { AdtsReader, rawInput, pulseMonitorSource } from "../src/desktop_audio.js";

test("the pulse capture source is the default sink's monitor, falling back to default", () => {
  assert.equal(pulseMonitorSource(() => "alsa_output.pci-0000_00_1f.3.analog-stereo\n"), "alsa_output.pci-0000_00_1f.3.analog-stereo.monitor");
  assert.equal(pulseMonitorSource(() => { throw new Error("pactl missing"); }), "default");
});

function adts(payload) {
  const len = payload.length + 7;
  return Buffer.from([0xff, 0xf1, 0x4c, 0x80 | ((len >> 11) & 3), (len >> 3) & 0xff, ((len & 7) << 5) | 0x1f, 0xfc, ...payload]);
}

test("ADTS frames come out whole however the bytes are split", () => {
  const a = adts(Buffer.from([1, 2, 3])), b = adts(Buffer.from([4, 5]));
  const r = new AdtsReader();
  const out = [];
  for (const byte of Buffer.concat([a, b])) out.push(...r.push(Buffer.from([byte])));
  assert.equal(out.length, 2);
  assert.deepEqual(out[0], a);
  assert.deepEqual(out[1], b);
});

test("a reader resynchronises after junk to the next frame", () => {
  const good = adts(Buffer.from([9, 9]));
  const r = new AdtsReader();
  const out = r.push(Buffer.concat([Buffer.from([0x12, 0x34]), good]));
  assert.equal(out.length, 1);
  assert.deepEqual(out[0], good);
});

test("a half frame waits for the rest instead of being emitted", () => {
  const f = adts(Buffer.from([1, 2, 3, 4]));
  const r = new AdtsReader();
  assert.equal(r.push(f.subarray(0, 5)).length, 0);
  assert.deepEqual(r.push(f.subarray(5))[0], f);
});

test("raw loopback input names ffmpeg's sample format from the helper's header", () => {
  assert.deepEqual(rawInput({ float: true, rate: 48000, channels: 2 }), ["-f", "f32le", "-ar", "48000", "-ac", "2", "-i", "pipe:0"]);
  assert.equal(rawInput({ float: false, bits: 16, rate: 44100, channels: 2 })[1], "s16le");
  assert.equal(rawInput({ float: false, bits: 24, rate: 48000, channels: 2 })[1], "s24le");
});
