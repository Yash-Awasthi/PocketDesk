/**
 * Desktop video stream. ffmpeg grabs a monitor (ddagrab on Windows, x11grab on Linux X11,
 * avfoundation on a Mac whose native helper cannot run) and encodes with the first encoder that
 * works for a codec every viewer can decode: AV1, then HEVC, then H.264. macOS and Linux Wayland
 * use a native helper instead (ScreenCaptureKit + VideoToolbox, PipeWire + GStreamer).
 * Packets go out as { kind, data }: H.264/HEVC as Annex B, AV1 as OBUs, sound as AAC ADTS frames.
 *
 * ffmpeg writes FLV (enhanced FLV for HEVC and AV1) because its tags carry lengths: a frame can
 * be forwarded the moment it is written, while raw Annex B only ends when the next frame starts.
 */
import { IS_WAYLAND, wfRecorderArgs } from "./wayland_desktop.js";
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
const scaleTo = (p) => (p.scale === 1 ? "" : `scale=trunc(iw*${p.scale}/2)*2:-2,`);
// The pointer is left out of the picture; viewers draw it from desktop_cursor so it moves without video delay.
const grab = (p, output) => `ddagrab=output_idx=${output}:framerate=${p.fps}:dup_frames=0:draw_mouse=0,hwdownload,format=bgra,`
  + scaleTo(p) + "format=nv12";
// avfoundation hands over full-resolution (Retina) pixels; the pointer is left out as on Windows.
const grabMac = (p, output) => ["-f", "avfoundation", "-capture_cursor", "0", "-framerate", String(p.fps),
  "-pixel_format", "nv12", "-i", `Capture screen ${output}:none`, "-vf", scaleTo(p) + "format=nv12"];
// One monitor's rectangle of the X screen; VA-API encoders take frames uploaded to the GPU.
const grabX11 = (p, m, vaapi) => [
  ...(vaapi ? ["-vaapi_device", "/dev/dri/renderD128"] : []),
  "-f", "x11grab", "-draw_mouse", "0", "-framerate", String(p.fps),
  ...(m ? ["-video_size", `${m.w}x${m.h}`] : []), "-i", `${process.env.DISPLAY || ":0"}+${m?.x || 0},${m?.y || 0}`,
  "-vf", scaleTo(p) + "format=nv12" + (vaapi ? ",hwupload" : "")];

const nvenc = (zerolatency) => (q) => ["-preset", "p1", "-tune", "ull", ...(zerolatency ? ["-zerolatency", "1"] : []),
  "-rc", "vbr", "-cq", String(q), "-b:v", "0", "-forced-idr", "1"];
const qsv = (q) => ["-preset", "veryfast", "-low_delay_brc", "1", "-global_quality", String(q - 2)];
// AMF and VA-API count AV1 quantizers to 255, so they target the preset's bitrate instead of a quality.
const amf = (q, p) => ["-usage", "ultralowlatency", "-quality", "speed", "-rc", "vbr_latency", "-b:v", p.maxrate];
const vaapi = (q, p) => ["-rc_mode", "VBR", "-b:v", p.maxrate];
export const ENCODERS = {
  av1_nvenc: nvenc(false), hevc_nvenc: nvenc(true), h264_nvenc: nvenc(true),
  av1_qsv: qsv, hevc_qsv: qsv, h264_qsv: qsv,
  av1_amf: amf, hevc_amf: amf, h264_amf: amf,
  av1_vaapi: vaapi, hevc_vaapi: vaapi, h264_vaapi: vaapi,
  // VideoToolbox has no constant-quality mode on Intel Macs, so it targets the preset's cap.
  h264_videotoolbox: (q, p) => ["-realtime", "1", "-b:v", p.maxrate],
  libx264: (q) => ["-preset", "ultrafast", "-tune", "zerolatency", "-crf", String(q - 2)],
};
/** Encoders worth trying on each platform: newest codec first, then GPU vendor, CPU last. */
export const ENCODER_ORDER = {
  win32: ["av1_nvenc", "av1_qsv", "av1_amf", "hevc_nvenc", "hevc_qsv", "hevc_amf", "h264_nvenc", "h264_qsv", "h264_amf", "libx264"],
  linux: ["av1_nvenc", "av1_vaapi", "hevc_nvenc", "hevc_vaapi", "h264_nvenc", "h264_vaapi", "libx264"],
  darwin: ["h264_videotoolbox", "libx264"],
  // wf-recorder carries its own encoder, without NVENC.
  wayland: ["h264_vaapi", "libx264"],
};
export const CODECS = ["av1", "hevc", "h264"];
export const codecOf = (enc) => (enc.startsWith("av1") ? "av1" : enc.startsWith("hevc") ? "hevc" : "h264");
const START_CODE = Buffer.from([0, 0, 0, 1]);
const LADDER = ["low", "saver", "balanced", "quality"];

/** Packet kinds, first byte of every binary message. */
export const KIND = { config: 0, key: 1, delta: 2, audio: 3 };

/** ffmpeg arguments for one encoder; a monitor on another GPU needs its own D3D11 device. */
export function ffmpegArgs(enc, presetName, monitor, platform = process.platform) {
  const p = PRESETS[presetName];
  let input;
  if (platform === "darwin") input = grabMac(p, monitor?.output || 0);
  else if (platform === "linux") input = grabX11(p, monitor, enc.endsWith("_vaapi"));
  else {
    const adapter = monitor?.adapter || 0;
    input = [...(adapter ? ["-init_hw_device", `d3d11va=rh:${adapter}`, "-filter_hw_device", "rh"] : []),
      "-filter_complex", grab(p, monitor?.output || 0)];
  }
  return ["-hide_banner", "-loglevel", "error", ...input,
    // A keyframe every `fps` changed frames starts each iroh GOP stream; see docs/TRANSPORT-BENCH.md.
    "-c:v", enc, ...ENCODERS[enc](p.q, p), "-g", String(p.fps), "-bf", "0", "-maxrate", p.maxrate, "-bufsize", p.maxrate,
    "-flush_packets", "1", "-f", "flv", "-flvflags", "no_duration_filesize", "pipe:1"];
}

/**
 * The daemon's send time inside the bitstream, where decoders skip it, so viewers can show how old
 * each frame is: an H.264 or HEVC SEI unit in front, an AV1 padding OBU behind. The time is 7 bytes
 * of 7 bits with the high bit set, so no byte is 0 and no emulation-prevention bytes are needed.
 */
export const STAMP_UUID = Buffer.from("52482d6c6174656e63792d7374616d70", "hex"); // "RH-latency-stamp"
function stampBytes(ms) {
  const t = Buffer.alloc(7);
  for (let i = 6, v = ms; i >= 0; i--, v = Math.floor(v / 128)) t[i] = 0x80 | (v % 128);
  return t;
}
export function seiStamp(ms) {
  return Buffer.concat([START_CODE, Buffer.from([0x06, 0x05, 16 + 7]), STAMP_UUID, stampBytes(ms), Buffer.from([0x80])]);
}
export function stampFrame(codec, data, ms) {
  if (codec === "av1") return Buffer.concat([data, Buffer.from([0x7a, 16 + 7]), STAMP_UUID, stampBytes(ms)]);
  if (codec === "hevc") return Buffer.concat([START_CODE, Buffer.from([0x4e, 0x01, 0x05, 16 + 7]), STAMP_UUID, stampBytes(ms), Buffer.from([0x80]), data]);
  return Buffer.concat([seiStamp(ms), data]);
}

/** Incremental FLV demuxer yielding { kind, data, codec }, legacy H.264 tags and enhanced HEVC/AV1 ones. */
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
      if (type !== 9 || body.length < 5) continue;
      if (body[0] & 0x80) {
        // Enhanced FLV: frame type, packet type, then a FourCC naming the codec.
        const fourcc = body.toString("latin1", 1, 5);
        const codec = fourcc === "hvc1" ? "hevc" : fourcc === "av01" ? "av1" : null;
        const packetType = body[0] & 0x0f;
        const key = ((body[0] >> 4) & 7) === 1;
        let payload = body.subarray(5);
        if (!codec) continue;
        if (packetType === 0) out.push({ kind: KIND.config, codec, data: codec === "hevc" ? hvccToAnnexB(payload) : payload.subarray(4) });
        else if (packetType === 1 || packetType === 3) {
          if (packetType === 1 && codec === "hevc") payload = payload.subarray(3); // composition time
          out.push({ kind: key ? KIND.key : KIND.delta, codec, data: codec === "hevc" ? lengthPrefixedToAnnexB(payload) : payload });
        }
        continue;
      }
      if ((body[0] & 0x0f) !== 7) continue;
      const payload = body.subarray(5);
      if (body[1] === 0) out.push({ kind: KIND.config, codec: "h264", data: avccToAnnexB(payload) });
      else if (body[1] === 1) out.push({ kind: body[0] >> 4 === 1 ? KIND.key : KIND.delta, codec: "h264", data: lengthPrefixedToAnnexB(payload) });
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

/** HEVCDecoderConfigurationRecord: 22 fixed bytes, then arrays of VPS, SPS and PPS units. */
export function hvccToAnnexB(c) {
  const parts = [];
  let p = 23;
  for (let a = c[22]; a > 0 && p + 3 <= c.length; a--) {
    let n = c.readUInt16BE(p + 1);
    p += 3;
    for (; n > 0 && p + 2 <= c.length; n--) { const len = c.readUInt16BE(p); parts.push(START_CODE, c.subarray(p + 2, p + 2 + len)); p += 2 + len; }
  }
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

/** Annex B units of [data] as subarrays without their start codes. */
function nalUnits(data) {
  const starts = [];
  for (let i = 0; i + 3 <= data.length; i++) {
    if (data[i] === 0 && data[i + 1] === 0 && data[i + 2] === 1) { starts.push(i + 3); i += 2; }
  }
  return starts.map((s, k) => {
    if (k + 1 === starts.length) return data.subarray(s);
    let end = starts[k + 1] - 3;
    if (end > s && data[end - 1] === 0) end--; // the leading zero of a four-byte start code
    return data.subarray(s, end);
  });
}

/**
 * Splits the parameter sets (H.264 SPS/PPS, HEVC VPS/SPS/PPS) off the front of an access unit that
 * carries them, as native encoders do on keyframes. Returns [config or null, frame].
 */
export function splitConfig(codec, data) {
  const isParam = codec === "hevc" ? (u) => [32, 33, 34].includes((u[0] >> 1) & 0x3f) : (u) => [7, 8].includes(u[0] & 0x1f);
  const units = nalUnits(data);
  const params = units.filter(isParam);
  if (!params.length) return [null, data];
  const join = (us) => Buffer.concat(us.flatMap((u) => [START_CODE, u]));
  return [join(params), join(units.filter((u) => !isParam(u)))];
}

/** Records [kind u8][length u32 BE][data] from a native helper: 1 key, 2 delta, 3 audio. */
export class FrameReader {
  constructor() { this.buf = Buffer.alloc(0); }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk;
    const out = [];
    while (this.buf.length >= 5) {
      const len = this.buf.readUInt32BE(1);
      if (this.buf.length < 5 + len) break;
      out.push({ kind: this.buf[0], data: this.buf.subarray(5, 5 + len) });
      this.buf = this.buf.subarray(5 + len);
    }
    return out;
  }
}

/** AV1 decoders need the sequence header before a keyframe; it goes right after a temporal delimiter. */
export function av1WithSequenceHeader(header, frame) {
  if (!header?.length || !frame.length) return frame;
  const type = (b) => (b >> 3) & 0x0f;
  let at = 0;
  if (type(frame[0]) === 2 && frame[0] & 0x02) at = 2 + frame[1]; // temporal delimiter: header, size (0)
  if (at < frame.length && type(frame[at]) === 1) return frame;
  return Buffer.concat([frame.subarray(0, at), header, frame.subarray(at)]);
}

/**
 * Emits "packet" ({ kind, data }) while running and "audio" (ADTS frames) when a native helper
 * captures sound. restart() begins a fresh stream starting with config + keyframe, which is how a
 * new or lagging viewer resyncs. monitor: an entry from DesktopController.monitors(), or null.
 *
 * native: { start({ monitor, preset, codecs, audio }, onRecord) -> Promise<{ encoder, codec } | null>, stop() }
 * for platforms whose capture is a helper of ours; ffmpegOk() says whether an ffmpeg grabber works now.
 */
export class DesktopVideo extends EventEmitter {
  constructor({ ffmpeg = process.env.FFMPEG_PATH || "ffmpeg", native = null, ffmpegOk = () => true } = {}) {
    super();
    this.ffmpeg = ffmpeg;
    this.native = native;
    this.ffmpegOk = ffmpegOk;
    this.proc = null;
    this.child = null;
    this.gen = 0;
    this.encoder = null;
    this.codec = "h264";
    this.codecs = ["h264"];
    this.audio = false;
    this.failed = new Set();
    this.preset = "balanced";
    this.monitor = null;
    this.stats = { packets: 0, bytes: 0, restarts: 0 };
  }

  get running() { return !!this.proc; }
  get scale() { return PRESETS[this.preset].scale; }

  /** Unknown names keep the current preset. */
  setPreset(name) { if (PRESETS[name]) this.preset = this.wanted = name; }

  /** Codecs every viewer decodes, best first; H.264 is always there as the floor. */
  setCodecs(list) {
    const wanted = CODECS.filter((c) => (Array.isArray(list) ? list : []).includes(c));
    this.codecs = wanted.includes("h264") ? wanted : [...wanted, "h264"];
  }

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

  /** ffmpeg encoders to try, in the viewers' codec order; ones that failed where a later one worked are skipped. */
  candidates(platform = IS_WAYLAND ? "wayland" : process.platform) {
    const order = (ENCODER_ORDER[platform] || []).filter((e) => this.codecs.includes(codecOf(e)) && !this.failed.has(e));
    return order.sort((a, b) => this.codecs.indexOf(codecOf(a)) - this.codecs.indexOf(codecOf(b)));
  }

  /** Resolves with the encoder in use, or null when none can start. */
  start() {
    if (this.proc) return Promise.resolve(this.encoder);
    if (this._starting) return this._starting;
    const gen = this.gen;
    this._starting = (async () => {
      if (this.native && (await this._spawnNative(gen))) return gen === this.gen ? this.encoder : null;
      if (gen !== this.gen || !this.ffmpegOk()) return null;
      const tried = [];
      for (const enc of this.candidates()) {
        const ok = await this._spawn(enc, gen);
        if (gen !== this.gen) return null;
        if (ok) {
          // Earlier ones failed while capture worked: their encoder or GPU is missing, not the screen.
          for (const t of tried) this.failed.add(t);
          this.encoder = enc;
          this.codec = codecOf(enc);
          return enc;
        }
        tried.push(enc);
      }
      return null;
    })();
    const p = this._starting;
    p.finally(() => { if (this._starting === p) this._starting = null; });
    return p;
  }

  /** Kills the stream; packets still in flight from it are dropped by the gen check. */
  stop() {
    this.gen = (this.gen || 0) + 1;
    this.child?.kill();
    this.native?.stop();
    this.child = this.proc = this._starting = null;
  }

  async restart() {
    this.stop();
    this.stats.restarts++;
    return this.start();
  }

  _emit(kind, data) {
    if (kind === KIND.key || kind === KIND.delta) data = stampFrame(this.codec, data, Date.now());
    this.stats.packets++;
    this.stats.bytes += data.length;
    this.emit("packet", { kind, data });
  }

  /**
   * A native helper's records ({ kind, data, codec }): parameter sets come off the front of keyframes
   * as their own config packet. Its AV1 keyframes carry the sequence header, so an empty config only
   * marks where a stream starts.
   */
  _spawnNative(gen) {
    const opts = { monitor: this.monitor, preset: PRESETS[this.preset], codecs: this.codecs, audio: this.audio };
    return this.native.start(opts, ({ kind, data, codec }) => {
      if (gen !== this.gen) return;
      if (kind === KIND.audio) return this.emit("audio", data);
      this.codec = codec;
      if (kind === KIND.key) {
        const [config, frame] = codec === "av1" ? [Buffer.alloc(0), data] : splitConfig(codec, data);
        if (config) this.emit("packet", { kind: KIND.config, data: config });
        return this._emit(KIND.key, frame);
      }
      if (kind === KIND.delta) this._emit(kind, data);
    }, () => { if (gen === this.gen) { this.proc = null; this.emit("ended", "native helper stopped"); } })
      .then((r) => {
        if (!r || gen !== this.gen) return false;
        this.encoder = r.encoder;
        this.codec = r.codec;
        this.proc = this.native;
        return true;
      }, () => false);
  }

  /** True once the first packet arrives; false if ffmpeg dies first. */
  _spawn(enc, gen) {
    return new Promise((resolve) => {
      const [bin, args] = IS_WAYLAND ? ["wf-recorder", wfRecorderArgs(enc, PRESETS[this.preset], this.monitor)] : [this.ffmpeg, ffmpegArgs(enc, this.preset, this.monitor)];
      let proc;
      try { proc = spawn(bin, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true }); }
      catch { return resolve(false); }
      this.child = proc;
      const live = () => gen === this.gen && this.child === proc;
      const demux = new FlvToAnnexB();
      const codec = codecOf(enc);
      let av1Header = null;
      let started = false;
      let err = "";
      proc.stderr.on("data", (d) => { err = (err + d).slice(-2000); });
      proc.stdout.on("data", (chunk) => {
        let packets;
        try { packets = demux.push(chunk); } catch { proc.kill(); return; }
        for (const pkt of packets) {
          if (!live()) return;
          if (!started) { started = true; this.proc = proc; this.codec = codec; resolve(true); }
          if (pkt.kind === KIND.config) {
            if (codec === "av1") av1Header = pkt.data;
            this.stats.packets++;
            this.emit("packet", { kind: KIND.config, data: pkt.data });
            continue;
          }
          this._emit(pkt.kind, codec === "av1" && pkt.kind === KIND.key ? av1WithSequenceHeader(av1Header, pkt.data) : pkt.data);
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
