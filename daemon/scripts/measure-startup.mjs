// Cold-start measurement for the daemon: how long from spawn to the listening banner, and from
// there to the first /health answer. The budget is 400 ms on a mid-range PC: the registry scan
// (about 60 `cmd.exe /c <bin> --version` probes) blocks the Windows event loop for seconds, so
// the port and the health answer must not wait for it.
//
//   node scripts/measure-startup.mjs            # five cold starts, one fresh compile cache dir
//   node scripts/measure-startup.mjs --runs=3
//
// A cold start is a fresh process. The compile cache directory is shared by the runs and its state
// is printed per run (fresh or reused), because cached bytecode changes what a "cold" run pays.
// PD_COMPILE_CACHE points the runs at an existing directory; PD_NO_LOAD=1 skips the host snapshot.
//
// Prints one line per run, then the median and the worst, then the gate. Exit 1 when the worst
// start->listen is at or over the budget; a median gate is a deliberate, documented choice, not
// something this script silently switches to.
//
// On Windows each run is preceded by a host load snapshot: the CPU load percentage and the top CPU
// consumers over a 500 ms sample, so a measurement on a busy box cannot be read as an idle baseline.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const daemonDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BUDGET_MS = 400;
const HEALTH_POLL_MS = 12;
const ANSWER_DEADLINE_MS = 60_000;
// Long enough for the deferred scan to finish and print its banner, short enough to keep the five
// runs under a minute: this is what makes "health before scan" a real ordering, not a race.
const SCAN_DEADLINE_MS = 20_000;

function freePort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.on("error", reject);
    s.listen(0, "127.0.0.1", () => {
      const p = s.address().port;
      s.close(() => resolve(p));
    });
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// One PowerShell call: load percentage, then CPU seconds each process spent in a 500 ms window.
const LOAD_SCRIPT = [
  "$before=@{}",
  "Get-Process | ForEach-Object { if ($null -ne $_.CPU) { $before[$_.Id]=$_.CPU } }",
  "Start-Sleep -Milliseconds 500",
  "Write-Output ('load ' + (Get-CimInstance Win32_Processor).LoadPercentage)",
  "Get-Process | Where-Object { $before.ContainsKey($_.Id) -and $null -ne $_.CPU } | ForEach-Object { [pscustomobject]@{ n=$_.ProcessName; i=$_.Id; d=[math]::Round($_.CPU-$before[$_.Id],2) } } | Sort-Object d -Descending | Select-Object -First 3 | ForEach-Object { Write-Output ('top ' + $_.n + ' ' + $_.i + ' ' + $_.d) }",
].join("; ");

/** Windows-only host snapshot, or null where it does not apply. Never fails the measurement. */
export function hostLoad() {
  if (process.platform !== "win32") return null;
  let out = null;
  try {
    const r = spawnSync("powershell.exe", ["-NoProfile", "-Command", LOAD_SCRIPT], {
      encoding: "utf8",
      timeout: 20_000,
    });
    if (r.status === 0) out = r.stdout;
  } catch {
    return null;
  }
  const lines = String(out || "")
    .trim()
    .split(/\r?\n/);
  const load = /^load (\d+)/.exec(lines[0] || "");
  if (!load) return null;
  const top = [];
  for (const line of lines.slice(1)) {
    const m = /^top (\S+) (\d+) ([\d.]+)/.exec(line);
    if (m) top.push({ name: m[1], pid: Number(m[2]), cpuSec: Number(m[3]) });
  }
  return { load: Number(load[1]), top };
}

export function loadLine(i, snapshot) {
  if (!snapshot) return `host load before run ${i}: unavailable`;
  const top = snapshot.top.map((p) => `${p.name}(${p.pid}) ${p.cpuSec}s`).join(", ");
  return `host load before run ${i}: ${snapshot.load}%; top CPU over 500 ms: ${top || "none"}`;
}

/**
 * One cold start on free ports and a fresh tmp state dir.
 * Resolves { listenMs, healthMs, healthBeforeScan, scanMs } or throws with the daemon's stderr.
 */
export async function measureOnce({ compileCache } = {}) {
  const port = await freePort();
  const cliPort = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pd-coldstart-"));
  fs.mkdirSync(path.join(tmp, "home"), { recursive: true });
  fs.mkdirSync(path.join(tmp, "data"), { recursive: true });
  const env = {
    ...process.env,
    RH_PORT: String(port),
    RH_CLI_PORT: String(cliPort),
    RH_TOKEN: "coldstart-token",
    RH_HOME: path.join(tmp, "home"),
    RH_MANIFESTS: tmp,
    POCKETDESK_DATA: path.join(tmp, "data"),
  };
  // The daemon sets no compile cache of its own; only this script asks for one, so say so.
  if (compileCache) env.NODE_COMPILE_CACHE = compileCache;
  else delete env.NODE_COMPILE_CACHE;
  const started = performance.now();
  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: daemonDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let listenAt = null;
  let scanAt = null;
  let healthAt = null;
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
    if (listenAt === null && stdout.includes("PocketDesk daemon")) listenAt = performance.now();
    if (scanAt === null && stdout.includes("registry scanned")) scanAt = performance.now();
  });
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
    if (stderr.length > 4000) stderr = stderr.slice(-4000);
  });
  const url = `http://127.0.0.1:${port}/health`;
  const deadline = started + ANSWER_DEADLINE_MS;
  while (healthAt === null && performance.now() < deadline) {
    if (child.exitCode !== null) break;
    try {
      const res = await fetch(url);
      if (res.ok) {
        await res.arrayBuffer();
        healthAt = performance.now();
      }
    } catch {
      // not listening yet
    }
    if (healthAt === null) await sleep(HEALTH_POLL_MS);
  }
  // Wait for the deferred scan's banner so the ordering below is measured, not assumed.
  while (scanAt === null && healthAt !== null && performance.now() - healthAt < SCAN_DEADLINE_MS) {
    if (child.exitCode !== null) break;
    await sleep(25);
  }
  const closed = new Promise((r) => child.once("exit", r));
  try {
    child.kill("SIGTERM");
  } catch {}
  await Promise.race([closed, sleep(5000)]);
  try {
    child.kill("SIGKILL");
  } catch {}
  try {
    fs.rmSync(tmp, { recursive: true, force: true });
  } catch {}
  if (listenAt === null || healthAt === null) {
    const tail = stderr.trim().split(/\r?\n/).slice(-5).join("\n") || "no stderr";
    throw new Error(`daemon never answered on ${port} (exit ${child.exitCode}):\n${tail}`);
  }
  return {
    listenMs: Math.round(listenAt - started),
    healthMs: Math.round(healthAt - listenAt),
    scanMs: scanAt === null ? null : Math.round(scanAt - listenAt),
    healthBeforeScan: scanAt === null || healthAt < scanAt,
  };
}

function median(xs) {
  const s = [...xs].sort((a, b) => a - b);
  return s[Math.floor(s.length / 2)];
}

export function medianOf(runs) {
  return {
    listenMs: median(runs.map((r) => r.listenMs)),
    healthMs: median(runs.map((r) => r.healthMs)),
  };
}

export function worstOf(runs) {
  return {
    listenMs: Math.max(...runs.map((r) => r.listenMs)),
    healthMs: Math.max(...runs.map((r) => r.healthMs)),
  };
}

export function runLine(i, total, r, cache) {
  const note = cache ? `, compile cache ${cache}` : "";
  return `cold start run ${i}/${total}: start->listen ${r.listenMs} ms, listen->first health ${r.healthMs} ms${note}`;
}

export function medianLine(m, total) {
  return `cold start median: start->listen ${m.listenMs} ms, listen->first health ${m.healthMs} ms (${total} runs, budget ${BUDGET_MS} ms)`;
}

export function worstLine(w, total) {
  return `cold start worst: start->listen ${w.listenMs} ms, listen->first health ${w.healthMs} ms (${total} runs, budget ${BUDGET_MS} ms)`;
}

async function main() {
  const arg = process.argv.find((a) => a.startsWith("--runs="));
  const total = arg ? Math.max(1, Number(arg.split("=")[1]) || 0) : 5;
  let cacheDir = process.env.PD_COMPILE_CACHE || "";
  let ownsCache = false;
  if (!cacheDir) {
    cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), "pd-compile-cache-"));
    ownsCache = true;
  } else {
    fs.mkdirSync(cacheDir, { recursive: true });
  }
  console.log(
    `cold start: ${total} fresh processes, compile cache dir ${cacheDir}` +
      (ownsCache ? " (created fresh for this run)" : " (given by PD_COMPILE_CACHE)"),
  );
  const runs = [];
  try {
    for (let i = 1; i <= total; i++) {
      if (process.env.PD_NO_LOAD !== "1") console.log(loadLine(i, hostLoad()));
      const fresh = fs.readdirSync(cacheDir).length === 0;
      const r = await measureOnce({ compileCache: cacheDir });
      runs.push(r);
      console.log(runLine(i, total, r, fresh ? "fresh" : "reused"));
    }
  } finally {
    if (ownsCache) fs.rmSync(cacheDir, { recursive: true, force: true });
  }
  const m = medianOf(runs);
  const w = worstOf(runs);
  console.log(medianLine(m, total));
  console.log(worstLine(w, total));
  const failed = w.listenMs >= BUDGET_MS;
  console.log(
    `cold start gate: worst start->listen ${w.listenMs} ms ${failed ? ">=" : "<"} ${BUDGET_MS} ms budget -> ${failed ? "FAIL" : "PASS"}`,
  );
  if (failed) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(String(e?.message || e));
    process.exit(1);
  });
}
