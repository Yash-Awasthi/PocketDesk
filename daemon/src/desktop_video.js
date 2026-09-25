/**
 * H.264 desktop stream: ffmpeg grabs the primary monitor (ddagrab) and encodes
 * with the first working encoder (NVENC, Quick Sync, x264). Frames are emitted
 * only when the screen changes, as Annex B packets ready for a hardware decoder.
 *
 * ffmpeg writes FLV because its tags carry lengths: a frame can be forwarded the
 * moment it is written, while raw Annex B only ends when the next frame starts.
 */
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";

/** scale: output px per screen px, which input coordinates are divided by. */
export const PRESETS = {
  // Only reached by congestion stepping: small enough keyframes for a slow relayed link.
  low: { fps: 12, scale: 1 / 2, maxrate: "600k", q: 36 },
  saver: { fps: 15, scale: 2 / 3, maxrate: "1500k", q: 34 },
  balanced: { fps: 30, scale: 1, maxrate: "6M", q: 30 },
  quality: { fps: 60, scale: 1, maxrate: "12M", q: 26 },
};
// The pointer is left out of the picture; viewers draw it from desktop_cursor so it moves without video delay.
const grab = (p, output) => `ddagrab=output_idx=${output}:framerate=${p.fps}:dup_frames=0:draw_mouse=0,hwdownload,format=bgra,`
  + (p.scale === 1 ? "" : `scale=trunc(iw*${p.scale}/2)*2:-2,`) + "format=nv12";
export const ENCODERS = {
  h264_nvenc: (q) => ["-preset", "p1", "-tune", "ull", "-zerolatency", "1", "-rc", "vbr", "-cq", String(q), "-b:v", "0"],
  h264_qsv: (q) => ["-preset", "veryfast", "-low_delay_brc", "1", "-global_quality", String(q - 2)],
  libx264: (q) => ["-preset", "ultrafast", "-tune", "zerolatency", "-crf", String(q - 2)],
};
const START_CODE = Buffer.from([0, 0, 0, 1]);
const LADDER = ["low", "saver", "balanced", "quality"];

/** Packet kinds, first byte of every binary message. */
export const KIND = { config: 0, key: 1, delta: 2 };

/** ffmpeg arguments for one encoder; a monitor on another GPU needs its own D3D11 device. */
export function ffmpegArgs(enc, presetName, monitor) {
  const p = PRESETS[presetName];
  const adapter = monitor?.adapter || 0;
  return ["-hide_banner", "-loglevel", "error",
    ...(adapter ? ["-init_hw_device", `d3d11va=rh:${adapter}`, "-filter_hw_device", "rh"] : []),
    "-filter_complex", grab(p, monitor?.output || 0),
    // A keyframe every `fps` changed frames starts each iroh GOP stream; see docs/TRANSPORT-BENCH.md.
    "-c:v", enc, ...ENCODERS[enc](p.q), ...(enc === "h264_nvenc" ? ["-forced-idr", "1"] : []), "-g", String(p.fps), "-bf", "0", "-maxrate", p.maxrate, "-bufsize", p.maxrate,
    "-flush_packets", "1", "-f", "flv", "-flvflags", "no_duration_filesize", "pipe:1"];
}

/**
 * SEI NAL (user data unregistered) carrying the daemon's send time, so viewers can show
 * how old each frame is. Decoders skip it. The time is 7 bytes of 7 bits with the high
 * bit set, so no byte is 0 and the payload needs no emulation-prevention bytes.
 */
export const STAMP_UUID = Buffer.from("52482d6c6174656e63792d7374616d70", "hex"); // "RH-latency-stamp"
export function seiStamp(ms) {
  const t = Buffer.alloc(7);
  for (let i = 6, v = ms; i >= 0; i--, v = Math.floor(v / 128)) t[i] = 0x80 | (v % 128);
  return Buffer.concat([START_CODE, Buffer.from([0x06, 0x05, 16 + 7]), STAMP_UUID, t, Buffer.from([0x80])]);
}

/** Incremental FLV demuxer yielding { kind, data } with Annex B payloads. */
export class FlvToAnnexB {
  constructor() { this.buf = Buffer.alloc(0); this.headerDone = false; }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    if (!this.headerDone) {
      if (this.buf.length < 13) return out;
      if (this.buf.toString("latin1", 0, 3) !== "FLV") throw new Error("not flv");
      this.buf = this.buf.subarray(this.buf.readUInt32BE(5) + 4);
      this.headerDone = true;
    }
    while (this.buf.length >= 11) {
      const size = this.buf.readUIntBE(1, 3);
      if (this.buf.length < 11 + size + 4) break;
      const type = this.buf[0];
      const body = this.buf.subarray(11, 11 + size);
      this.buf = this.buf.subarray(11 + size + 4);
      if (type !== 9 || body.length < 5 || (body[0] & 0x0f) !== 7) continue;
      const payload = body.subarray(5);
      if (body[1] === 0) out.push({ kind: KIND.config, data: avccToAnnexB(payload) });
      else if (body[1] === 1) out.push({ kind: body[0] >> 4 === 1 ? KIND.key : KIND.delta, data: lengthPrefixedToAnnexB(payload) });
    }
    return out;
  }
}

function avccToAnnexB(c) {
  const parts = [];
  let p = 6;
  for (let n = c[5] & 0x1f; n > 0; n--) { const len = c.readUInt16BE(p); parts.push(START_CODE, c.subarray(p + 2, p + 2 + len)); p += 2 + len; }
  for (let n = c[p++]; n > 0; n--) { const len = c.readUInt16BE(p); parts.push(START_CODE, c.subarray(p + 2, p + 2 + len)); p += 2 + len; }
  return Buffer.concat(parts);
}

function lengthPrefixedToAnnexB(b) {
  const parts = [];
  for (let p = 0; p + 4 <= b.length;) {
    const len = b.readUInt32BE(p);
    parts.push(START_CODE, b.subarray(p + 4, p + 4 + len));
    p += 4 + len;
  }
  return Buffer.concat(parts);
}

/**
 * Emits "packet" ({ kind, data }) while running. restart() begins a fresh stream
 * starting with config + keyframe, which is how a new or lagging viewer resyncs.
 * monitor: an entry from DesktopController.monitors(), or null for the first output.
 */
export class DesktopVideo extends EventEmitter {
  constructor({ ffmpeg = process.env.FFMPEG_PATH || "ffmpeg" } = {}) {
    super();
    this.ffmpeg = ffmpeg;
    this.proc = null;
    this.child = null;
    this.gen = 0;
    this.encoder = null;
    this.preset = "balanced";
    this.monitor = null;
    this.stats = { packets: 0, bytes: 0, restarts: 0 };
  }

  get running() { return !!this.proc; }
  get scale() { return PRESETS[this.preset].scale; }

  /** Unknown names keep the current preset. */
  setPreset(name) { if (PRESETS[name]) this.preset = this.wanted = name; }

  /** Congestion step: one preset lower. False at the bottom. */
  stepDown() {
    const i = LADDER.indexOf(this.preset);
    if (i <= 0) return false;
    this.preset = LADDER[i - 1];
    return true;
  }

  /** Recovery step: one preset higher, never above what the viewer asked for. */
  stepUp() {
    const i = LADDER.indexOf(this.preset);
    if (this.preset === (this.wanted || "balanced") || i < 0 || i === LADDER.length - 1) return false;
    this.preset = LADDER[i + 1];
    return true;
  }

  /** Resolves with the encoder in use, or null when none can start. */
  start() {
    if (this.proc) return Promise.resolve(this.encoder);
    if (this._starting) return this._starting;
    const gen = this.gen;
    this._starting = (async () => {
      const order = this.encoder ? [this.encoder] : Object.keys(ENCODERS);
      for (const enc of order) {
        const ok = await this._spawn(enc, gen);
        if (gen !== this.gen) return null;
        if (ok) { this.encoder = enc; return enc; }
      }
      return null;
    })();
    const p = this._starting;
    p.finally(() => { if (this._starting === p) this._starting = null; });
    return p;
  }

  /** Kills ffmpeg; packets still in flight from it are dropped by the gen check. */
  stop() {
    this.gen = (this.gen || 0) + 1;
    this.child?.kill();
    this.child = this.proc = this._starting = null;
  }

  async restart() {
    this.stop();
    this.stats.restarts++;
    return this.start();
  }

  /** True once the first packet arrives; false if ffmpeg dies first. */
  _spawn(enc, gen) {
    return new Promise((resolve) => {
      const args = ffmpegArgs(enc, this.preset, this.monitor);
      let proc;
      try { proc = spawn(this.ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); }
      catch { return resolve(false); }
      this.child = proc;
      const live = () => gen === this.gen && this.child === proc;
      const demux = new FlvToAnnexB();
      let started = false;
      let err = "";
      proc.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
      proc.stdout.on("data", (chunk) => {
        let packets;
        try { packets = demux.push(chunk); } catch { proc.kill(); return; }
        for (const pkt of packets) {
          if (!live()) return;
          if (!started) { started = true; this.proc = proc; resolve(true); }
          if (pkt.kind !== KIND.config) pkt.data = Buffer.concat([seiStamp(Date.now()), pkt.data]);
          this.stats.packets++;
          this.stats.bytes += pkt.data.length;
          this.emit("packet", pkt);
        }
      });
      proc.on("error", () => { if (!started) resolve(false); });
      proc.on("exit", () => {
        if (!started) { this.lastError = err.trim(); return resolve(false); }
        if (live()) { this.child = this.proc = null; this.emit("ended", err.trim()); }
      });
    });
  }
}
