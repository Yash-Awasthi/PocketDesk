#!/usr/bin/env node
/**
 * Frame pacing: frames per wall-clock second each daemon encoder actually
 * delivers on this machine, idle and with half or all cores spinning.
 *
 * Frames are counted from the FLV tags on ffmpeg's stdout, not from its
 * `-progress` counter. The counter can freeze for seconds under CPU starvation
 * while the encoded bytes keep coming, which made a stalled encoder look fine.
 * Here a frame counts when the last byte of its tag reaches the reader; a tag
 * still stuck in the pipe at the window end is a drop for a live stream.
 *
 *   node scripts/frame-pacing.mjs [--seconds 10] [--warmup 3]
 *     [--loads idle,half,full] [--source ddagrab|testsrc] [--preset balanced]
 *     [--only h264_nvenc] [--json out.json] [--md out.md]
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import { ffmpegPath } from "../src/desktop/encode.js";
import { ENCODERS, ENCODER_ORDER, PRESETS, codecOf } from "../src/desktop_video.js";

const USAGE = `Frame pacing probe: frames written per second by each daemon encoder.

Usage: node scripts/frame-pacing.mjs [options]

  --seconds <n>    measurement window in seconds (default 10)
  --warmup <n>     seconds discarded before the window (default 3)
  --loads <list>   comma-separated load levels to run back to back:
                   idle, half (one spinner per two cpus), full (one per cpu),
                   over (two per cpu) (default idle,half,full)
  --repeat <n>     runs per load level; the table shows the median and every
                   dropped count (default 1)
  --source <src>   "ddagrab" for the daemon's Windows capture graph, or
                   "testsrc" for a 2560x1440 synthetic source (default ddagrab)
  --preset <name>  low | saver | balanced | quality (default balanced)
  --only <enc>     restrict to one encoder; repeat for more
  --json <path>    write { machine, source, preset, seconds, rows }
  --md <path>      write the same header and table as markdown
  --help           show this text

Exit status is 0 when some encoders are unavailable; it is non-zero only when
the probe itself cannot run.
`;

const opt = {
  seconds: 10,
  warmup: 3,
  loads: "idle,half,full",
  repeat: 1,
  source: "ddagrab",
  preset: "balanced",
  only: [],
  json: null,
  md: null,
};

let help = false;
const argv = process.argv.slice(2);
for (let i = 0; i < argv.length; i++) {
  const a = argv[i];
  const value = () => {
    if (i + 1 >= argv.length) throw new Error(`${a} needs a value`);
    return argv[++i];
  };
  if (a === "--help" || a === "-h") help = true;
  else if (a === "--seconds") opt.seconds = Number(value());
  else if (a === "--warmup") opt.warmup = Number(value());
  else if (a === "--loads") opt.loads = value();
  else if (a === "--repeat") opt.repeat = Number(value());
  else if (a === "--source") opt.source = value();
  else if (a === "--preset") opt.preset = value();
  else if (a === "--only") opt.only.push(value());
  else if (a === "--json") opt.json = value();
  else if (a === "--md") opt.md = value();
  else throw new Error(`unknown option ${a} (try --help)`);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const firstLine = (text) =>
  (text || "")
    .split(/\r?\n/)
    .map((l) => l.trim())
    .find(Boolean) || "";
const clip = (s) => {
  const t = String(s).replace(/\s+/g, " ").trim();
  return t.length > 100 ? `${t.slice(0, 97)}...` : t;
};
const round1 = (n) => Math.round(n * 10) / 10;

/** Input args for the chosen source. ddagrab mirrors the daemon's Windows graph. */
function inputArgs(p) {
  if (opt.source === "testsrc")
    return ["-re", "-f", "lavfi", "-i", `testsrc2=size=2560x1440:rate=${p.fps}`, "-vf", "format=nv12"];
  const graph =
    `ddagrab=output_idx=0:framerate=${p.fps}:dup_frames=1:draw_mouse=0,hwdownload,format=bgra` +
    (p.scale === 1 ? "" : `,scale=trunc(iw*${p.scale}/2)*2:-2`) +
    ",format=nv12";
  return ["-filter_complex", graph];
}

/** One frame through the encoder; the first stderr line explains a failure. */
function probe(enc, p, ffmpeg) {
  return new Promise((resolve) => {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-f",
      "lavfi",
      "-i",
      "testsrc2=size=640x360:rate=30",
      "-frames:v",
      "1",
      "-c:v",
      enc,
      ...ENCODERS[enc](p.q, p),
      "-f",
      "null",
      "-",
    ];
    let child;
    let err = "";
    let settled = false;
    let timer = null;
    const done = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(r);
    };
    try {
      child = spawn(ffmpeg, args, { stdio: ["ignore", "ignore", "pipe"], windowsHide: true });
    } catch (e) {
      return done({ ok: false, note: clip(e.message) });
    }
    timer = setTimeout(() => {
      try {
        child.kill("SIGKILL");
      } catch {}
      done({ ok: false, note: "probe timed out" });
    }, 20_000);
    child.stderr.on("data", (d) => {
      err = (err + d.toString()).slice(-4000);
    });
    child.on("error", (e) => done({ ok: false, note: clip(e.message) }));
    child.on("close", (code) =>
      code === 0 ? done({ ok: true }) : done({ ok: false, note: clip(firstLine(err) || `exit ${code}`) }),
    );
  });
}

/**
 * FLV: a 9-byte header and its 4-byte PreviousTagSize, then tags of
 * [type u8][data size u24][ts low u24][ts ext u8][stream id u24], the body,
 * and a 4-byte PreviousTagSize. Type 9 is video. Feeds each completed video
 * tag's arrival time to onVideo; tags split across chunks are buffered.
 */
function flvScanner(onVideo) {
  let buf = Buffer.alloc(0);
  let headerDone = false;
  return (chunk, t) => {
    buf = buf.length ? Buffer.concat([buf, chunk]) : chunk;
    if (!headerDone) {
      if (buf.length < 13) return;
      buf = buf.subarray(13);
      headerDone = true;
    }
    for (;;) {
      if (buf.length < 11) return;
      const type = buf[0];
      const size = (buf[1] << 16) | (buf[2] << 8) | buf[3];
      const total = 11 + size + 4;
      if (buf.length < total) return;
      if (type === 9) onVideo(t);
      buf = buf.subarray(total);
    }
  };
}

/** Frames whose FLV tag fully arrived inside the warmup-adjusted window. */
function measure(enc, p, ffmpeg) {
  return new Promise((resolve) => {
    const args = [
      "-hide_banner",
      "-loglevel",
      "error",
      "-nostats",
      ...inputArgs(p),
      "-fps_mode",
      "passthrough",
      "-c:v",
      enc,
      ...ENCODERS[enc](p.q, p),
      "-g",
      String(p.fps),
      "-bf",
      "0",
      "-maxrate",
      p.maxrate,
      "-bufsize",
      p.maxrate,
      "-flush_packets",
      "1",
      "-f",
      "flv",
      "pipe:1",
    ];
    const arrivals = [];
    let errText = "";
    let child = null;
    let settled = false;
    let windowTimer = null;
    let hardTimer = null;
    const t0 = performance.now();
    const startT = t0 + opt.warmup * 1000;
    const endT = startT + opt.seconds * 1000;

    const finish = (r) => {
      if (settled) return;
      settled = true;
      clearTimeout(windowTimer);
      clearTimeout(hardTimer);
      try {
        child?.kill("SIGKILL");
      } catch {}
      resolve(r);
    };

    const compute = () => {
      const inWindow = arrivals.filter((t) => t >= startT && t <= endT);
      const frames = inWindow.length;
      const expected = Math.round(opt.seconds * p.fps);
      let maxGapMs = 0;
      for (let i = 1; i < inWindow.length; i++) maxGapMs = Math.max(maxGapMs, inWindow[i] - inWindow[i - 1]);
      return {
        fps: round1(frames / opt.seconds),
        frames,
        expected,
        dropped: Math.max(0, expected - frames),
        maxGapMs: Math.round(maxGapMs),
        note: clip(firstLine(errText) || (frames ? "" : "no frames in window")),
      };
    };

    try {
      child = spawn(ffmpeg, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true });
    } catch (e) {
      return resolve({ error: clip(e.message) });
    }
    const scan = flvScanner((t) => arrivals.push(t));
    child.stdout.on("data", (chunk) => scan(chunk, performance.now()));
    child.stderr.on("data", (d) => {
      errText = (errText + d.toString()).slice(-2000);
    });
    child.on("error", (e) => finish({ error: clip(e.message) }));
    child.on("close", (code) => {
      if (settled) return;
      if (performance.now() < endT - 100 && code !== 0)
        finish({ error: clip(firstLine(errText) || `exit ${code}`) });
      else finish(compute());
    });

    windowTimer = setTimeout(() => finish(compute()), Math.max(0, endT - performance.now()));
    hardTimer = setTimeout(() => finish(compute()), (opt.warmup + opt.seconds + 5) * 1000);
  });
}

function spinUp(count, runMs) {
  const code = "const end=Date.now()+Number(process.argv[1]);while(Date.now()<end){}";
  const kids = [];
  for (let i = 0; i < count; i++) {
    try {
      const kid = spawn(process.execPath, ["-e", code, String(runMs)], {
        stdio: "ignore",
        windowsHide: true,
      });
      kid.on("error", () => {});
      kids.push(kid);
    } catch {}
  }
  return kids;
}

function spinDown(kids) {
  for (const kid of kids) {
    try {
      kid.kill("SIGKILL");
    } catch {}
  }
}

function spinCount(load, cpus) {
  if (load === "idle") return 0;
  if (load === "half") return Math.floor(cpus / 2);
  return load === "over" ? cpus * 2 : cpus;
}

function loadLabel(load, spins) {
  return load === "idle" ? "idle" : `${load} (${spins} spin)`;
}

function table(rows) {
  const esc = (s) => (s || "").replace(/\|/g, "\\|");
  const dash = (v) => (v == null ? "-" : String(v));
  const head =
    "| encoder | codec | load | fps | frames | expected | dropped | dropped per run | max gap ms | note |";
  const sep = "| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |";
  const body = [];
  for (const row of rows) {
    if (row.status === "unavailable") {
      body.push(`| ${row.encoder} | ${row.codec} | - | - | - | - | - | - | - | ${esc(row.note)} |`);
      continue;
    }
    for (const run of row.runs) {
      const cols = [
        row.encoder,
        row.codec,
        loadLabel(run.load, run.spins),
        run.fps == null ? "-" : run.fps.toFixed(1),
        dash(run.frames),
        dash(run.expected),
        dash(run.dropped),
        run.all.length > 1 ? run.all.map((r) => dash(r.dropped)).join("/") : "-",
        dash(run.maxGapMs),
        esc(row.note),
      ];
      body.push(`| ${cols.join(" | ")} |`);
    }
  }
  return [head, sep, ...body].join("\n");
}

async function main() {
  if (help) {
    console.log(USAGE);
    return;
  }
  const p = PRESETS[opt.preset];
  if (!p) throw new Error(`unknown preset "${opt.preset}" (${Object.keys(PRESETS).join(", ")})`);
  if (opt.source !== "ddagrab" && opt.source !== "testsrc")
    throw new Error(`unknown source "${opt.source}" (ddagrab or testsrc)`);
  if (!(opt.seconds > 0) || !(opt.warmup >= 0)) throw new Error("--seconds must be > 0 and --warmup >= 0");
  if (!(opt.repeat >= 1) || !Number.isInteger(opt.repeat))
    throw new Error("--repeat must be a whole number >= 1");

  const requested = [
    ...new Set(
      opt.loads
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
    ),
  ];
  if (!requested.length) throw new Error("--loads needs at least one of idle, half, full, over");
  const badLoads = requested.filter((l) => !["idle", "half", "full", "over"].includes(l));
  if (badLoads.length) throw new Error(`unknown load level(s): ${badLoads.join(", ")}`);
  const loads = ["idle", "half", "full", "over"].filter((l) => requested.includes(l));

  const offered = ENCODER_ORDER[process.platform] || [];
  if (opt.only.length) {
    const missing = opt.only.filter((e) => !offered.includes(e));
    if (missing.length) throw new Error(`not offered on ${process.platform}: ${missing.join(", ")}`);
  }
  const list = opt.only.length ? offered.filter((e) => opt.only.includes(e)) : offered;
  if (!list.length) throw new Error(`no encoders offered on ${process.platform}`);

  const ffmpeg = ffmpegPath();
  const cpus = os.cpus();
  const model = (cpus[0]?.model || "unknown").trim();
  const geometry = opt.source === "testsrc" ? "2560x1440" : "native";
  const machine = { cpus: cpus.length, model, ffmpeg };
  const runMs = (opt.warmup + opt.seconds + 4) * 1000;
  const rows = [];
  const notes = new Map();
  const usable = [];

  process.stderr.write(`${list.length} encoder(s), ${opt.source} ${geometry}, ${opt.preset}\n`);
  for (const enc of list) {
    const probed = await probe(enc, p, ffmpeg);
    if (!probed.ok) process.stderr.write(`${enc}: unavailable\n`);
    rows.push({
      encoder: enc,
      codec: codecOf(enc),
      status: probed.ok ? "ok" : "unavailable",
      note: probed.ok ? "" : probed.note,
      runs: [],
    });
    if (probed.ok) {
      usable.push(enc);
      notes.set(enc, []);
    }
  }
  process.stderr.write(`${usable.length} of ${list.length} encoder(s) usable\n`);
  // Interleaved, and repeat-by-repeat: every encoder meets the same background load inside a
  // repeat, and each idle run sits next to the loaded run it is compared with, so a build that
  // starts mid-sweep lands on both.
  const all = new Map(usable.map((enc) => [enc, new Map(loads.map((l) => [l, []]))]));
  for (let i = 0; i < opt.repeat; i++) {
    for (const loadName of loads) {
      const spins = spinCount(loadName, cpus.length);
      const spinsMs = runMs * usable.length + 4000;
      const kids = spins ? spinUp(spins, spinsMs) : [];
      try {
        if (spins) await sleep(500);
        for (const enc of usable) {
          process.stderr.write(`${enc}: ${loadLabel(loadName, spins)} ${i + 1}/${opt.repeat}\n`);
          const r = await measure(enc, p, ffmpeg);
          if (r.error) {
            notes.get(enc).push(`${loadName}: ${clip(r.error)}`);
            all.get(enc).get(loadName).push(null);
          } else {
            if (r.note) notes.get(enc).push(r.note);
            all.get(enc).get(loadName).push(r);
          }
        }
      } finally {
        spinDown(kids);
      }
    }
  }
  for (const loadName of loads) {
    const spins = spinCount(loadName, cpus.length);
    for (const enc of usable) {
      const ok = all.get(enc).get(loadName).filter(Boolean);
      const runs = rows.find((row) => row.encoder === enc).runs;
      if (!ok.length) {
        runs.push({
          load: loadName,
          spins,
          fps: null,
          frames: null,
          expected: null,
          dropped: null,
          maxGapMs: null,
          all: [],
        });
        continue;
      }
      const median = (key) => {
        const v = ok.map((r) => r[key]).sort((a, b) => a - b);
        const mid = v.length >> 1;
        return v.length % 2 ? v[mid] : Math.round(((v[mid - 1] + v[mid]) / 2) * 10) / 10;
      };
      runs.push({
        load: loadName,
        spins,
        fps: median("fps"),
        frames: median("frames"),
        expected: median("expected"),
        dropped: median("dropped"),
        maxGapMs: Math.max(...ok.map((r) => r.maxGapMs)),
        all: ok.map((r) => ({
          fps: r.fps,
          frames: r.frames,
          dropped: r.dropped,
          maxGapMs: r.maxGapMs,
        })),
      });
    }
  }
  for (const row of rows) {
    if (row.status === "unavailable") continue;
    row.note = [...new Set(notes.get(row.encoder))].join("; ");
    if (row.runs.some((r) => r.fps == null)) row.status = "error";
  }

  const loadsText = loads.map((l) => loadLabel(l, spinCount(l, cpus.length))).join(", ");
  const header = [
    `machine  ${model} (${cpus.length} cpus)`,
    `ffmpeg   ${ffmpeg}`,
    `preset   ${opt.preset} (fps ${p.fps}, scale ${p.scale}, maxrate ${p.maxrate}, q ${p.q})`,
    `source   ${opt.source} (${geometry})`,
    `window   ${opt.seconds} s (warmup ${opt.warmup} s, ${opt.repeat} run(s) per load)`,
    `loads    ${loadsText}`,
  ].join("\n");
  const report = `${header}\n\n${table(rows)}`;
  console.log(report);

  if (opt.md) fs.writeFileSync(opt.md, `${report}\n`);
  if (opt.json) {
    const json = {
      machine,
      source: opt.source,
      preset: opt.preset,
      seconds: opt.seconds,
      repeat: opt.repeat,
      rows,
    };
    fs.writeFileSync(opt.json, `${JSON.stringify(json, null, 2)}\n`);
  }
}

main().catch((e) => {
  console.error(e?.stack || e);
  process.exit(1);
});
