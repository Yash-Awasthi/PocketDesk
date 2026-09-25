#!/usr/bin/env node
/**
 * Transport bench: encodes a fixed test pattern with the desktop encoder settings
 * and measures what a viewer on this machine receives over ws or iroh.
 *
 *   node scripts/transport-bench.mjs --transport ws|iroh-single|iroh-gop
 *     [--secs 30] [--preset balanced] [--gop 60] [--encoder h264_nvenc]
 *     [--relay http://localhost:3340 | --relay n0] [--dump out.h264]
 *
 * ws and iroh-single mirror production: an infinite GOP, and an ffmpeg restart
 * when the viewer falls 1.5 MB behind. iroh-gop sends each GOP on its own QUIC
 * stream, resets a GOP the viewer can no longer use, and never restarts ffmpeg.
 * Packet loss and lag come from clumsy, run separately. Prints one JSON line.
 */
import { spawn, fork } from "node:child_process";
import fs from "node:fs";
import { parseArgs } from "node:util";
import { WebSocketServer, WebSocket } from "ws";
import { ENCODERS, PRESETS, FlvToAnnexB, KIND } from "../src/desktop_video.js";

const { values: opt } = parseArgs({
  options: {
    transport: { type: "string", default: "ws" },
    secs: { type: "string", default: "30" },
    preset: { type: "string", default: "balanced" },
    gop: { type: "string", default: "60" },
    encoder: { type: "string", default: "h264_nvenc" },
    relay: { type: "string" },
    dump: { type: "string" },
    child: { type: "boolean", default: false },
  },
});

const ALPN = [...Buffer.from("rh-bench/0")];
const HEADER = 13; // kind u8, seq u32, sender timestamp f64 (ms)
const LAG_LIMIT = 1_500_000; // same backlog limit as server.js
const STALL_MS = 200;
// hrtime reads the OS performance counter, which every process shares; timeOrigin differs per process.
const now = () => Number(process.hrtime.bigint()) / 1e6;
// The binding drops an endpoint once JS stops referencing it, killing its connections.
const keep = [];

async function irohEndpoint(relay) {
  const { Endpoint, RelayMode } = await import("@number0/iroh");
  const b = Endpoint.builder();
  b.applyMinimal();
  b.alpns([ALPN]);
  b.relayMode(!relay ? RelayMode.disabled() : relay === "n0" ? RelayMode.defaultMode() : RelayMode.customFromUrls([relay]));
  b.bindAddr("127.0.0.1:0");
  const ep = await b.bind();
  keep.push(ep);
  return ep;
}

/** Length-prefixed frames on a QUIC stream: u32 length, then HEADER + payload. */
async function readFrames(stream, onFrame) {
  for (;;) {
    let len;
    try { len = Buffer.from(await stream.readExact(4)).readUInt32BE(0); } catch { return; }
    let body;
    try { body = Buffer.from(await stream.readExact(len)); } catch { return; }
    onFrame(body);
  }
}

function frame(pkt) {
  const b = Buffer.allocUnsafe(4 + pkt.length);
  b.writeUInt32BE(pkt.length, 0);
  pkt.copy(b, 4);
  return b;
}

// ── viewer (child process) ───────────────────────────────────────────────
async function viewer(info) {
  const t0 = now();
  let firstShown = 0, lastShown = 0, shown = 0, bytes = 0, stalls = 0, stallMs = 0, maxGap = 0;
  let haveConfig = false, chainOk = false, lastSeq = -1, lastKeySeq = -1, lateDropped = 0;
  const lat = [];
  const dump = opt.dump ? fs.createWriteStream(opt.dump) : null;

  function onPacket(buf) {
    const t = now();
    bytes += buf.length;
    const kind = buf[0], seq = buf.readUInt32BE(1), ts = buf.readDoubleBE(5);
    if (seq < lastKeySeq) { lateDropped++; return; } // tail of a GOP that was already replaced
    let show = false;
    if (kind === KIND.config) { haveConfig = true; lastSeq = seq; chainOk = false; }
    else if (kind === KIND.key) { chainOk = haveConfig; lastKeySeq = seq; lastSeq = seq; show = chainOk; }
    else { chainOk = chainOk && seq === lastSeq + 1; lastSeq = seq; show = chainOk; }
    if (dump && (show || kind === KIND.config)) dump.write(buf.subarray(HEADER));
    if (!show) return;
    shown++;
    lat.push(t - ts);
    if (!firstShown) firstShown = t;
    else {
      const gap = t - lastShown;
      if (gap > maxGap) maxGap = gap;
      if (gap > STALL_MS) { stalls++; stallMs += gap; }
    }
    lastShown = t;
  }

  let conn = null;
  if (info.transport === "ws") {
    const ws = new WebSocket(info.url);
    ws.binaryType = "nodebuffer";
    ws.on("message", (d) => onPacket(d));
  } else {
    const { EndpointAddr, EndpointId } = await import("@number0/iroh");
    const ep = await irohEndpoint(opt.relay);
    const addr = new EndpointAddr(EndpointId.fromString(info.id), info.relayUrl ?? null, info.relayUrl ? [] : info.direct);
    conn = await ep.connect(addr, ALPN);
    const streams = [];
    (async () => {
      for (;;) {
        let s;
        try { s = await conn.acceptUni(); } catch { return; }
        // A newer GOP makes every older stream useless; stop them so the sender stops retrying.
        for (const old of streams.splice(0)) old.stop(0n).catch(() => {});
        streams.push(s);
        readFrames(s, onPacket);
      }
    })();
  }
  const connectMs = now() - t0;

  process.on("message", (m) => {
    if (m !== "report") return;
    const end = now();
    if (lastShown && end - lastShown > STALL_MS) { stalls++; stallMs += end - lastShown; }
    lat.sort((a, b) => a - b);
    const q = (p) => (lat.length ? +lat[Math.min(lat.length - 1, Math.floor(p * lat.length))].toFixed(1) : null);
    const span = (end - (firstShown || end)) / 1000;
    const path = conn?.paths().find((p) => p.isSelected);
    dump?.end();
    process.send({
      connectMs: +connectMs.toFixed(0),
      firstFrameMs: firstShown ? +(firstShown - t0).toFixed(0) : null,
      shown, fps: span ? +(shown / span).toFixed(1) : 0,
      mbps: span ? +((bytes * 8) / span / 1e6).toFixed(2) : 0,
      latP50: q(0.5), latP95: q(0.95), latP99: q(0.99),
      stalls, stallMs: +stallMs.toFixed(0), stallPct: span ? +((stallMs / 10) / span).toFixed(2) : 0, maxGapMs: +maxGap.toFixed(0),
      lateDropped,
      path: path ? (path.isRelay ? "relay" : "direct") : info.transport === "ws" ? "tcp" : null,
      rttMs: path?.rttMs ?? null, lostPackets: conn?.stats().lostPackets ?? null,
    });
  });
  process.send("ready");
}

// ── sender (parent process) ──────────────────────────────────────────────
async function sender() {
  const p = PRESETS[opt.preset];
  if (!p || !ENCODERS[opt.encoder]) throw new Error("unknown preset or encoder");
  const gopMode = opt.transport === "iroh-gop";
  const ffmpegPath = process.env.FFMPEG_PATH || "ffmpeg";
  const w = Math.round((1920 * p.scale) / 2) * 2, h = Math.round((1080 * p.scale) / 2) * 2;
  const stats = { packets: 0, restarts: -1, resets: 0, skippedDeltas: 0 };

  let seq = 0, onPacket = () => {}, proc = null, gen = 0;
  function startFfmpeg() {
    const my = ++gen;
    const extra = opt.encoder === "h264_nvenc" ? ["-forced-idr", "1"] : [];
    proc = spawn(ffmpegPath, ["-hide_banner", "-loglevel", "error", "-re", "-f", "lavfi",
      "-i", `testsrc2=size=${w}x${h}:rate=${p.fps}`, "-pix_fmt", "nv12",
      "-c:v", opt.encoder, ...ENCODERS[opt.encoder](p.q), ...extra, "-g", gopMode ? opt.gop : "9999", "-bf", "0",
      "-maxrate", p.maxrate, "-bufsize", p.maxrate, "-flush_packets", "1",
      "-f", "flv", "-flvflags", "no_duration_filesize", "pipe:1"], { stdio: ["ignore", "pipe", "inherit"], windowsHide: true });
    const demux = new FlvToAnnexB();
    proc.stdout.on("data", (chunk) => {
      for (const pkt of demux.push(chunk)) {
        if (my !== gen) return;
        const b = Buffer.allocUnsafe(HEADER + pkt.data.length);
        b[0] = pkt.kind; b.writeUInt32BE(seq++ >>> 0, 1); b.writeDoubleBE(now(), 5);
        pkt.data.copy(b, HEADER);
        stats.packets++;
        onPacket(pkt.kind, b);
      }
    });
  }
  let restartTimer = null;
  const restart = () => {
    if (restartTimer) return;
    restartTimer = setTimeout(() => { restartTimer = null; proc?.kill(); stats.restarts++; startFfmpeg(); }, 250);
  };

  const info = { transport: opt.transport };
  let cleanup = () => {};
  if (opt.transport === "ws") {
    const wss = new WebSocketServer({ host: "127.0.0.1", port: 0 });
    await new Promise((r) => wss.once("listening", r));
    info.url = `ws://127.0.0.1:${wss.address().port}`;
    wss.on("connection", (ws) => {
      let needKey = true;
      onPacket = (kind, b) => {
        if (ws.readyState !== 1) return;
        if (kind === KIND.config) needKey = false;
        if (needKey) return;
        if (ws.bufferedAmount > LAG_LIMIT) { needKey = true; restart(); return; }
        ws.send(b);
      };
      restart();
    });
    cleanup = () => wss.close();
  } else {
    const ep = await irohEndpoint(opt.relay);
    info.id = ep.id().toString();
    if (opt.relay) { await ep.online(); info.relayUrl = ep.addr().relayUrl(); }
    else info.direct = ep.addr().directAddresses();
    (async () => {
      const inc = await ep.acceptNext();
      const conn = await (await inc.accept()).connect();
      onPacket = gopMode ? gopSender(conn, stats) : singleSender(await conn.openUni(), restart);
      restart();
    })();
    cleanup = () => ep.close().catch(() => {});
  }

  const cpu0 = process.cpuUsage();
  const child = fork(new URL(import.meta.url), [...process.argv.slice(2), "--child"], { serialization: "advanced" });
  child.send(info);
  await new Promise((r) => child.once("message", r));
  const t0 = Date.now();
  await new Promise((r) => setTimeout(r, Number(opt.secs) * 1000));
  child.send("report");
  const result = await new Promise((r) => child.once("message", r));
  const cpu = process.cpuUsage(cpu0);
  gen++; proc?.kill(); clearTimeout(restartTimer);
  child.kill();
  cleanup();
  console.log(JSON.stringify({
    transport: opt.transport, relay: opt.relay ?? null, preset: opt.preset, gop: gopMode ? Number(opt.gop) : null,
    encoder: opt.encoder, secs: Number(opt.secs), clock: "hrtime", ...result, ...stats,
    senderCpuPct: +(((cpu.user + cpu.system) / 1000 / (Date.now() - t0)) * 100).toFixed(1),
  }));
  process.exit(0);
}

/** Serialized writes on one stream; `queued` counts bytes handed over but not yet accepted. */
function streamWriter(stream) {
  const s = { stream, queued: 0, dead: false, chain: Promise.resolve() };
  s.write = (buf) => {
    s.queued += buf.length;
    s.chain = s.chain.then(async () => {
      if (!s.dead) await stream.writeAll(Array.from(buf)).catch(() => { s.dead = true; });
      s.queued -= buf.length;
    });
  };
  s.reset = () => { if (!s.dead) { s.dead = true; stream.reset(0n).catch(() => {}); } };
  s.finish = () => { s.chain = s.chain.then(() => (s.dead ? null : stream.finish().catch(() => {}))); };
  return s;
}

function singleSender(stream, restart) {
  const s = streamWriter(stream);
  let needKey = true;
  return (kind, b) => {
    if (kind === KIND.config) needKey = false;
    if (needKey) return;
    if (s.queued > LAG_LIMIT) { needKey = true; restart(); return; }
    s.write(frame(b));
  };
}

function gopSender(conn, stats) {
  let cur = null, config = null, prio = 0, opening = Promise.resolve();
  return (kind, b) => {
    if (kind === KIND.config) { config = b; return; }
    if (kind === KIND.key) {
      const prev = cur;
      cur = null;
      // An unfinished GOP is stale once a newer keyframe exists.
      if (prev) { if (prev.queued > 0) { prev.reset(); stats.resets++; } else prev.finish(); }
      const head = config;
      opening = opening.then(async () => {
        const st = await conn.openUni();
        await st.setPriority(++prio).catch(() => {});
        cur = streamWriter(st);
        if (head) cur.write(frame(head));
        cur.write(frame(b));
      });
      return;
    }
    opening.then(() => {
      if (!cur || cur.dead) { stats.skippedDeltas++; return; }
      // Too far behind to catch up inside this GOP: drop it and wait for the next keyframe.
      if (cur.queued > LAG_LIMIT) { cur.reset(); stats.resets++; stats.skippedDeltas++; return; }
      cur.write(frame(b));
    });
  };
}

if (opt.child) process.once("message", (info) => viewer(info).catch((e) => { console.error(e); process.exit(1); }));
else sender().catch((e) => { console.error(e); process.exit(1); });
