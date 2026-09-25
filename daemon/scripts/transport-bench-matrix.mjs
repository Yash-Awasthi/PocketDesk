#!/usr/bin/env node
/**
 * Runs transport-bench.mjs across transports and clumsy network conditions.
 * Needs an elevated shell (clumsy loads WinDivert). Appends one JSON line per run
 * to ~/.pocketdesk/bench/results.jsonl and logs every step to matrix.log.
 *   node scripts/transport-bench-matrix.mjs --clumsy C:\path\clumsy.exe [--relay C:\path\iroh-relay.exe] [--secs 30] [--repeats 2]
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

const { values: opt } = parseArgs({
  options: {
    clumsy: { type: "string" },
    relay: { type: "string" },
    secs: { type: "string", default: "30" },
    repeats: { type: "string", default: "2" },
  },
});
if (!opt.clumsy) throw new Error("--clumsy is required");

const bench = path.join(path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, "$1")), "transport-bench.mjs");
const dir = path.join(os.homedir(), ".pocketdesk", "bench");
fs.mkdirSync(dir, { recursive: true });
const results = path.join(dir, "results.jsonl");
const logFile = path.join(dir, "matrix.log");

/** Appends with retries: a reader holding the file briefly must not lose a result. */
function append(file, text) {
  for (let i = 0; i < 20; i++) {
    try { fs.appendFileSync(file, text); return; } catch { spawnSync(process.execPath, ["-e", "setTimeout(()=>{},250)"]); }
  }
}
const log = (msg) => append(logFile, `${new Date().toISOString()} ${msg}\n`);
process.on("uncaughtException", (e) => { log(`FATAL ${e.stack || e}`); process.exit(1); });

// clumsy sees each loopback packet twice (send and receive), so every
// probability and delay is set to half of the intended effective value.
const conditions = [
  { name: "clean", args: [] },
  { name: "loss1", args: ["--drop", "on", "--drop-chance", "0.5"] },
  { name: "loss3", args: ["--drop", "on", "--drop-chance", "1.5"] },
  { name: "loss5", args: ["--drop", "on", "--drop-chance", "2.5"] },
  { name: "lag50", args: ["--lag", "on", "--lag-time", "25"] },
  { name: "lag50+loss3", args: ["--lag", "on", "--lag-time", "25", "--drop", "on", "--drop-chance", "1.5"] },
  { name: "cap500KBps", args: ["--bandwidth", "on", "--bandwidth-bandwidth", "500"] },
];
const transports = [
  { name: "ws", args: ["--transport", "ws"], filter: "tcp and loopback" },
  { name: "iroh-single", args: ["--transport", "iroh-single"], filter: "udp and loopback" },
  { name: "iroh-gop60", args: ["--transport", "iroh-gop", "--gop", "60"], filter: "udp and loopback" },
  { name: "iroh-gop30", args: ["--transport", "iroh-gop", "--gop", "30"], filter: "udp and loopback" },
];

const killClumsy = () => spawnSync("taskkill", ["/F", "/IM", path.basename(opt.clumsy)], { stdio: "ignore" });
const pause = (ms) => spawnSync(process.execPath, ["-e", `setTimeout(()=>{},${ms})`]);

function run(label, cond, filter, benchArgs) {
  log(`start ${label} ${cond.name}`);
  if (cond.args.length) {
    spawn(opt.clumsy, ["--filter", filter, ...cond.args], { detached: true, stdio: "ignore" }).unref();
    pause(2000);
  }
  try {
    const r = spawnSync(process.execPath, [bench, ...benchArgs, "--secs", opt.secs], {
      encoding: "utf8", timeout: (Number(opt.secs) + 90) * 1000, env: process.env,
    });
    const line = (r.stdout || "").split(/\r?\n/).filter((l) => l.startsWith("{")).pop();
    if (!line) { log(`FAILED ${label} ${cond.name} status=${r.status} err=${(r.stderr || r.error?.message || "").slice(0, 800)}`); return; }
    const o = { ...JSON.parse(line), condition: cond.name, label };
    append(results, JSON.stringify(o) + "\n");
    log(`done ${label} ${cond.name}: fps=${o.fps} p50=${o.latP50} p95=${o.latP95} stalls=${o.stalls} stallMs=${o.stallMs} path=${o.path}`);
  } finally {
    if (cond.args.length) { killClumsy(); pause(1000); }
  }
}

killClumsy();
for (let rep = 1; rep <= Number(opt.repeats); rep++) {
  for (const t of transports) for (const c of conditions) run(t.name, c, t.filter, t.args);
  // Relayed: loopback UDP fully dropped so no direct path can form; the relay leg is TCP.
  const block = { name: "relay-forced", args: ["--drop", "on", "--drop-chance", "100"] };
  if (opt.relay) {
    const relay = spawn(opt.relay, ["--dev"], { stdio: "ignore" });
    pause(2000);
    try { run("iroh-gop60-relay-local", block, "udp and loopback", ["--transport", "iroh-gop", "--relay", "http://localhost:3340"]); }
    finally { relay.kill(); }
  }
  run("iroh-gop60-relay-n0", block, "udp and loopback", ["--transport", "iroh-gop", "--relay", "n0"]);
}
append(results, "MATRIX-EXIT\n");
log("matrix finished");
