// The video bitrate ladder on a simulated slow link: settle, bounded latency, no stall, recovery.
import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { DesktopVideo, PRESETS, ffmpegArgs, presetWithCap } from "../src/desktop_video.js";
import remoteHandlers from "../src/handlers/remote.js";

const LADDER = ["low", "saver", "balanced", "quality"];
const RTT_MS = 200;
const LOSS = 0.05;
const TICK_MS = 100;
const DOWN_GAP_MS = 3000; // server.js: one step down per burst of drops
const UP_AFTER_MS = 30_000; // server.js: step up only after 30 s without a drop
const UP_EVERY_MS = 10_000; // server.js: recovery is checked every 10 s
const QUEUE_CAP_MS = 2000; // a frame that would wait longer is dropped
const STALL_MS = 1500; // no frame delivered for this long is a stall

function parseRate(text) {
  const m = /^([0-9]+(?:\.[0-9]+)?)([kM])$/.exec(text);
  assert.ok(m, `unreadable maxrate ${text}`);
  return Number(m[1]) * (m[2] === "k" ? 1e3 : 1e6);
}

const RATE = Object.fromEntries(LADDER.map((name) => [name, parseRate(PRESETS[name].maxrate)]));

test("the preset ladder is monotonic in bitrate", () => {
  assert.deepEqual(
    LADDER.map((n) => RATE[n]),
    [600_000, 1_500_000, 6_000_000, 12_000_000],
  );
  for (let i = 1; i < LADDER.length; i++) {
    assert.ok(RATE[LADDER[i - 1]] < RATE[LADDER[i]], `${LADDER[i - 1]} < ${LADDER[i]}`);
  }
});

// One link: capacity minus 5% loss (goodput), one drain per tick, RTT/2 added to each frame.
function makeSim(requested = "quality") {
  const video = new DesktopVideo();
  video.setPreset(requested);
  return {
    video,
    t: 0,
    queue: 0,
    nextFrameAt: 0,
    gop: 0,
    gopPreset: null,
    latencies: [],
    arrivals: [],
    drops: [],
    steps: [],
    lastDropAt: -Infinity,
    nextUpAt: UP_EVERY_MS,
  };
}

function step(sim, dir, now) {
  const from = sim.video.preset;
  const moved = dir === "down" ? sim.video.stepDown() : sim.video.stepUp();
  if (moved) sim.steps.push({ t: now, dir, from, to: sim.video.preset });
  return moved;
}

// Mirrors server.js: lastDrop moves even when the ladder is already at low.
function congested(sim, now) {
  if (now - sim.lastDropAt < DOWN_GAP_MS) return;
  sim.lastDropAt = now;
  step(sim, "down", now);
}

function sendFrame(sim, g, now) {
  const name = sim.video.preset;
  const p = PRESETS[name];
  if (sim.gopPreset !== name) {
    sim.gopPreset = name;
    sim.gop = 0;
  }
  const key = sim.gop === 0;
  sim.gop = (sim.gop + 1) % p.fps;
  const bytes = (RATE[name] / 8 / p.fps) * (key ? 3 : 1);
  const queueMs = ((sim.queue + bytes) / g) * 1000;
  if (queueMs > QUEUE_CAP_MS) {
    sim.drops.push(now);
    congested(sim, now);
  } else {
    sim.queue += bytes;
    const ms = queueMs + RTT_MS / 2;
    sim.latencies.push({ t: now, ms });
    sim.arrivals.push(now + ms);
  }
  sim.nextFrameAt += 1000 / p.fps;
}

function advance(sim, capacityBps, untilMs) {
  const g = (capacityBps * (1 - LOSS)) / 8; // goodput in bytes per second
  while (sim.t + TICK_MS <= untilMs) {
    sim.t += TICK_MS;
    const now = sim.t;
    sim.queue = Math.max(0, sim.queue - g * (TICK_MS / 1000));
    while (sim.nextFrameAt <= now) sendFrame(sim, g, now);
    while (now >= sim.nextUpAt) {
      sim.nextUpAt += UP_EVERY_MS;
      if (now - sim.lastDropAt > UP_AFTER_MS) step(sim, "up", now);
    }
  }
}

function p95(values) {
  const s = [...values].sort((a, b) => a - b);
  return s[Math.floor((s.length - 1) * 0.95)];
}

// Arrival times with no delivered frame for STALL_MS after `from`.
function stalls(arrivals, from) {
  const ts = arrivals.filter((t) => t >= from).sort((a, b) => a - b);
  const out = [];
  let prev = from;
  for (const t of ts) {
    if (t - prev > STALL_MS) out.push(t);
    if (t > prev) prev = t;
  }
  return out;
}

test("a 1 Mbps link settles at low with bounded latency and no stall", () => {
  const sim = makeSim("quality");
  advance(sim, 1_000_000, 30_000);

  const settle = sim.steps.filter((s) => s.to === "low").at(-1);
  assert.ok(settle, "the ladder reaches low");
  assert.ok(settle.t < 60_000, `settled at ${settle.t} ms`);
  assert.equal(sim.video.preset, "low");
  assert.ok(RATE[sim.video.preset] <= 1_000_000, "the settled preset carries under 1 Mbps");
  // The 30 s window here sits inside the server's 30 s recovery delay, so any up step is a bug.
  assert.deepEqual(
    sim.steps.filter((s) => s.dir === "up"),
    [],
  );

  const from = settle.t + 6000; // let the backlog from the last overshoot drain
  const late = sim.latencies.filter((l) => l.t >= from).map((l) => l.ms);
  assert.ok(late.length > 100, `${late.length} frames after settling`);
  const tail = p95(late);
  assert.ok(tail < 2000, `p95 ${tail.toFixed(0)} ms`);
  assert.deepEqual(stalls(sim.arrivals, from), []);
  assert.deepEqual(stalls(sim.arrivals, 0), [], "no stall even while oversubscribed");
  // A frame is refused above a 2 s queue wait, so no frame can arrive later than that plus RTT/2.
  const max = Math.max(...sim.latencies.map((l) => l.ms));
  assert.ok(max <= QUEUE_CAP_MS + RTT_MS / 2, `max ${max.toFixed(0)} ms`);
});

test("raising the link to 20 Mbps steps back up to the requested preset", () => {
  const sim = makeSim("quality");
  advance(sim, 1_000_000, 30_000);
  assert.equal(sim.video.preset, "low");
  const dropsAt1Mbps = sim.drops.length;
  advance(sim, 20_000_000, 120_000);

  const up = sim.steps.filter((s) => s.dir === "up");
  assert.deepEqual(
    up.map((s) => s.to),
    ["saver", "balanced", "quality"],
  );
  assert.ok(
    up.every((s) => s.t > 30_000),
    "no up step while the link was at 1 Mbps",
  );
  assert.equal(sim.video.preset, "quality");
  assert.equal(sim.drops.length, dropsAt1Mbps, "20 Mbps carries the top preset");
});

test("recovery stops at the preset the viewer asked for", () => {
  const sim = makeSim("saver");
  advance(sim, 1_000_000, 30_000);
  assert.equal(sim.video.preset, "low");
  advance(sim, 20_000_000, 120_000);

  assert.equal(sim.video.preset, "saver");
  assert.deepEqual(
    sim.steps.filter((s) => s.dir === "up").map((s) => s.to),
    ["saver"],
  );
  assert.ok(!sim.steps.some((s) => LADDER.indexOf(s.to) > LADDER.indexOf("saver")));
});

test("the ladder stops at low and never passes the requested preset", () => {
  const v = new DesktopVideo();
  v.setPreset("quality");
  assert.equal(v.stepDown(), true);
  assert.equal(v.stepDown(), true);
  assert.equal(v.stepDown(), true);
  assert.equal(v.preset, "low");
  assert.equal(v.stepDown(), false);
  assert.equal(v.preset, "low");

  const w = new DesktopVideo();
  w.setPreset("saver"); // the viewer asked for saver
  assert.equal(w.stepDown(), true);
  assert.equal(w.stepDown(), false);
  assert.equal(w.preset, "low");
  assert.equal(w.stepUp(), true);
  assert.equal(w.preset, "saver");
  assert.equal(w.stepUp(), false);
  assert.equal(w.preset, "saver");
});

test("a per-stream cap lowers a preset and never raises it", () => {
  assert.equal(presetWithCap("balanced", 1200).maxrate, "1200k");
  assert.equal(presetWithCap("balanced", 50_000).maxrate, "6000k", "a high cap keeps the preset rate");
  assert.equal(presetWithCap("balanced", 0).maxrate, PRESETS.balanced.maxrate);
  assert.equal(presetWithCap("low", 0).maxrate, "600k");

  const args = ffmpegArgs("libx264", "balanced", null, "win32", 1200);
  assert.equal(args[args.indexOf("-maxrate") + 1], "1200k");
  assert.equal(args[args.indexOf("-bufsize") + 1], "1200k");
  const plain = ffmpegArgs("libx264", "balanced", null, "win32");
  assert.equal(plain[plain.indexOf("-maxrate") + 1], PRESETS.balanced.maxrate);

  const v = new DesktopVideo();
  assert.equal(v.setCap(900), 900);
  assert.equal(v.setCap(-5), 0);
  assert.equal(v.setCap("nope"), 0);
  assert.equal(v.setCap(1e9), 50_000);
});

test("the narrowest viewer or config request becomes the stream cap", async () => {
  const caps = [];
  const sent = [];
  const video = {
    running: false,
    capKbps: 0,
    preset: "balanced",
    codec: "h264",
    monitor: null,
    setPreset() {},
    setCodecs() {},
    setCap(k) {
      caps.push(k);
      this.capKbps = k;
      return k;
    },
    async start() {
      return "libx264";
    },
    async restart() {
      return "libx264";
    },
    stop() {},
  };
  const desktop = {
    monitorList: [{ index: 0, all: false, output: 0, w: 1920, h: 1080 }],
    watchCursor() {},
    watchClipboard() {},
    watchProtected() {},
    setCaptureAllowed() {},
    async monitors() {
      return { monitors: this.monitorList };
    },
    async pointer() {
      return { x: 0, y: 0 };
    },
    async inputMouse() {},
    stopFrameStream() {
      return { ok: true };
    },
  };
  const h = remoteHandlers({
    send: (_ws, m) => sent.push(m),
    desktop,
    clippy: {},
    desktopWatchers: new Set(),
    video,
    videoWatchers: new Set(),
    recorder: { log() {}, screenWatched() {}, recordingScreen: false },
    access: { controlAllowed: true, remoteOn: true },
    syncAudio() {},
    audioListeners: new Set(),
    monitorRefresh() {},
  });
  const viewer = () => ({ bufferedAmount: 0, once() {}, _codecs: [] });

  const wide = viewer();
  const narrow = viewer();
  await h.desktop_start(wide, { video: true, stream: { maxKbps: 4000 } });
  await h.desktop_start(narrow, { video: true, stream: { maxKbps: 1200 } });
  assert.equal(video.capKbps, 1200, "the smallest viewer cap wins");
  assert.equal(sent.at(-1).maxKbps, 1200, "the reply tells the viewer the cap in force");
  assert.equal(caps.at(-1), 1200);

  await h.desktop_stop(narrow, {});
  assert.equal(video.capKbps, 4000, "the cap lifts when the narrow viewer leaves");
  await h.desktop_stop(wide, {});
  assert.equal(video.capKbps, 0, "with no viewers the preset carries its own rate");
});

test("the cap comes from RH_STREAM_MAX_KBPS or config.json and survives a save", () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "rh-cap-"));
  const daemon = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
  try {
    fs.writeFileSync(path.join(home, "config.json"), JSON.stringify({ stream: { maxKbps: 1800 } }));
    const read = (extra = {}) =>
      execFileSync(
        process.execPath,
        [
          "--input-type=module",
          "-e",
          'const c=await import("./src/config.js"); process.stdout.write(String(c.streamCapKbps()))',
        ],
        { cwd: daemon, env: { ...process.env, RH_HOME: home, ...extra }, encoding: "utf8" },
      );
    assert.equal(read(), "1800", "config.json sets the ceiling");
    assert.equal(read({ RH_STREAM_MAX_KBPS: "900" }), "900", "the environment overrides the file");
    assert.equal(read({ RH_STREAM_MAX_KBPS: "junk" }), "1800", "junk falls back to the file");
    assert.equal(read({ RH_STREAM_MAX_KBPS: "999999" }), "50000", "an absurd cap is clamped");

    execFileSync(
      process.execPath,
      [
        "--input-type=module",
        "-e",
        'const {saveConfig}=await import("./src/config.js"); saveConfig({ port: 1, token: "t", tls: { enabled: false, cert: "c", key: "k" }, stream: { maxKbps: 2400 } })',
      ],
      { cwd: daemon, env: { ...process.env, RH_HOME: home }, encoding: "utf8" },
    );
    const saved = JSON.parse(fs.readFileSync(path.join(home, "config.json"), "utf8"));
    assert.equal(saved.stream.maxKbps, 2400, "a save keeps the hand-set cap");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
