// Daemon cold-start table: spawn -> listening, spawn -> first /health answer, and spawn ->
// "registry scanned", which is the readiness line the test helpers wait for. The scan is deferred
// on purpose (it spawns about 60 `bin --version` probes and blocks the Windows event loop for
// seconds), so the three numbers are reported side by side instead of merged into one.
//
//   node scripts/cold-start.mjs                 # 12 cold starts, table + min/median/max/spread
//   node scripts/cold-start.mjs --runs=20
//   PD_NO_LOAD=1 node scripts/cold-start.mjs    # skip the per-run host snapshot
//
// A cold start is a fresh process on free ports with a temporary home, data and manifest dir, and
// no NODE_COMPILE_CACHE, so every run pays the parse. The host spawn floor is measured in the same
// window (`node -e ""` from spawn to exit) because a machine whose bare spawn alone costs hundreds
// of milliseconds cannot answer whether a 400 ms budget holds. The verdict gates on the median of
// spawn -> "registry scanned"; the listen and health medians are printed for contrast. Exit 1 when
// the stated readiness misses the budget.
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { BUDGET_MS, daemonDir, hostLoad, loadLine } from "./measure-startup.mjs";

const HEALTH_POLL_MS = 12;
const SPAWN_DEADLINE_MS = 60_000;
const SCAN_DEADLINE_MS = 30_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

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

/** CPU, cores, RAM and the system disk, so a number can be read against the hardware it came from. */
export function hardware() {
  if (process.platform !== "win32") {
    return {
      cpu: os.cpus()[0]?.model || "unknown",
      cores: `${os.cpus().length} logical`,
      ramGb: null,
      disk: "unknown",
    };
  }
  const script = [
    "$c = Get-CimInstance Win32_Processor | Select-Object -First 1",
    "Write-Output ('cpu ' + $c.Name)",
    "Write-Output ('cores ' + $c.NumberOfCores + ' physical, ' + $c.NumberOfLogicalProcessors + ' logical')",
    "$m = (Get-CimInstance Win32_ComputerSystem).TotalPhysicalMemory",
    "Write-Output ('ram ' + [math]::Round($m/1GB,1) + ' GB')",
    "try { $d = Get-PhysicalDisk | Sort-Object Size -Descending | Select-Object -First 1; Write-Output ('disk ' + $d.FriendlyName + ' ' + $d.MediaType + ' ' + $d.BusType) } catch { Write-Output 'disk unknown' }",
  ].join("; ");
  const r = spawnSync("powershell.exe", ["-NoProfile", "-Command", script], {
    encoding: "utf8",
    timeout: 20_000,
  });
  const out = { cpu: "unknown", cores: "unknown", ramGb: null, disk: "unknown" };
  for (const line of String(r.stdout || "")
    .trim()
    .split(/\r?\n/)) {
    const m = /^(cpu|cores|ram|disk) (.*)$/.exec(line);
    if (!m) continue;
    if (m[1] === "ram") out.ramGb = Number.parseFloat(m[2]);
    else out[m[1]] = m[2].trim();
  }
  return out;
}

/** Spawn-to-exit of `node -e ""`: the host's own process floor, with no daemon work in it. */
export async function spawnFloor() {
  const started = performance.now();
  const child = spawn(process.execPath, ["-e", ""], { stdio: "ignore" });
  await new Promise((r) => child.once("exit", r));
  return Math.round(performance.now() - started);
}

/** One cold start. Resolves { listenMs, healthMs, scanMs } or throws with the daemon's stderr tail. */
export async function measureOnce() {
  const port = await freePort();
  const cliPort = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pd-coldstart-table-"));
  const env = {
    ...process.env,
    RH_PORT: String(port),
    RH_CLI_PORT: String(cliPort),
    RH_TOKEN: "coldstart-token",
    RH_HOME: path.join(tmp, "home"),
    RH_MANIFESTS: path.join(tmp, "manifests"),
    POCKETDESK_DATA: path.join(tmp, "data"),
  };
  // "Cold" here means an uncached parse too: a shared compile cache would hide what the row asks.
  delete env.NODE_COMPILE_CACHE;
  for (const d of ["home", "manifests", "data"]) fs.mkdirSync(path.join(tmp, d), { recursive: true });

  const started = performance.now();
  const child = spawn(process.execPath, ["src/index.js"], {
    cwd: daemonDir,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  let listenAt = null;
  let scanAt = null;
  let healthAt = null;
  child.stdout.on("data", (chunk) => {
    stdout += String(chunk);
    if (listenAt === null && stdout.includes("PocketDesk daemon")) listenAt = performance.now();
    if (scanAt === null && stdout.includes("registry scanned")) scanAt = performance.now();
  });
  child.stderr.on("data", (chunk) => {
    stderr = (stderr + String(chunk)).slice(-4000);
  });

  const url = `http://127.0.0.1:${port}/health`;
  const deadline = started + SPAWN_DEADLINE_MS;
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
  const scanDeadline = performance.now() + SCAN_DEADLINE_MS;
  while (scanAt === null && performance.now() < scanDeadline && child.exitCode === null) await sleep(25);

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

  if (scanAt === null || healthAt === null) {
    const tail = stderr.trim().split(/\r?\n/).slice(-5).join("\n") || "no stderr";
    throw new Error(
      `daemon on ${port} never reached the readiness line and /health (exit ${child.exitCode}):\n${tail}`,
    );
  }
  return {
    listenMs: Math.round(listenAt === null ? Number.NaN : listenAt - started),
    healthMs: Math.round(healthAt - started),
    scanMs: Math.round(scanAt - started),
  };
}

export function stats(xs) {
  const s = [...xs].sort((a, b) => a - b);
  const mid = s.length >> 1;
  const median = s.length % 2 ? s[mid] : Math.round((s[mid - 1] + s[mid]) / 2);
  return { min: s[0], median, max: s[s.length - 1], spread: s[s.length - 1] - s[0] };
}

const pad = (v, w) => String(v).padStart(w);

/**
 * Wait until the host reports load at or below `pct`, up to `budgetMs`. Without this a run on a
 * fleet box measures the neighbours, not the daemon; with it the number still says which load it
 * was taken at, and a host that never calms down yields an honest upper bound instead of silence.
 * Returns the last snapshot (or null when the platform has no load probe).
 */
async function waitQuiet(pct, budgetMs) {
  if (!(pct >= 0) || process.env.PD_NO_LOAD === "1") return null;
  const deadline = performance.now() + budgetMs;
  for (;;) {
    const snap = hostLoad();
    if (!snap) return null;
    if (snap.load <= pct) return snap;
    if (performance.now() >= deadline) {
      console.log(`  host stayed above ${pct}% for ${Math.round(budgetMs / 1000)} s; measuring anyway`);
      return snap;
    }
    await sleep(3000);
  }
}

async function main() {
  const arg = process.argv.find((a) => a.startsWith("--runs="));
  const runs = arg ? Math.max(1, Number(arg.split("=")[1]) || 0) : 12;
  const quietArg = process.argv.find((a) => a.startsWith("--quiet="));
  const quiet = quietArg ? Number(quietArg.split("=")[1]) : Number.NaN;
  const timeoutArg = process.argv.find((a) => a.startsWith("--quiet-timeout="));
  const quietTimeoutMs = (timeoutArg ? Number(timeoutArg.split("=")[1]) : 300) * 1000;
  const hw = hardware();
  console.log(
    `host: ${hw.cpu}; ${hw.cores}; ${hw.ramGb ? hw.ramGb + " GB RAM" : "RAM unknown"}; disk ${hw.disk}`,
  );
  console.log(`cold start: ${runs} fresh processes, no NODE_COMPILE_CACHE, budget ${BUDGET_MS} ms`);
  // One gate before the batch: on a fleet box the neighbours decide the number, so wait once for a
  // quiet host rather than re-waiting before every run (which would just stretch the same bad window).
  if (quiet >= 0) {
    console.log(
      `quiet gate: waiting up to ${Math.round(quietTimeoutMs / 1000)} s for host load <= ${quiet}%`,
    );
    const snap = await waitQuiet(quiet, quietTimeoutMs);
    console.log(
      snap ? `quiet gate: proceeding at ${snap.load}% load` : "quiet gate: no load probe on this platform",
    );
  }

  const rows = [];
  const floors = [];
  const loads = [];
  for (let i = 1; i <= runs; i++) {
    const snapshot = process.env.PD_NO_LOAD === "1" ? null : hostLoad();
    if (snapshot) {
      loads.push(snapshot.load);
      console.log(loadLine(i, snapshot));
    }
    floors.push(await spawnFloor());
    const r = await measureOnce();
    rows.push(r);
    console.log(
      `run ${pad(i, 2)}/${runs}: spawn->listen ${pad(r.listenMs, 5)} ms | spawn->health ${pad(r.healthMs, 5)} ms | spawn->"registry scanned" ${pad(r.scanMs, 6)} ms`,
    );
  }

  const floor = stats(floors);
  const L = stats(rows.map((r) => r.listenMs));
  const H = stats(rows.map((r) => r.healthMs));
  const S = stats(rows.map((r) => r.scanMs));
  const loadRange = loads.length
    ? `load before runs ${Math.min(...loads)}-${Math.max(...loads)}%`
    : "load not sampled";
  const line = (name, s) =>
    `${name}: min ${s.min} ms, median ${s.median} ms, max ${s.max} ms, spread ${s.spread} ms`;
  console.log("");
  console.log("metric                         | min (ms) | median (ms) | max (ms) | spread (ms)");
  console.log("-------------------------------+----------+-------------+----------+------------");
  const tableRow = (name, s) =>
    console.log(
      `${name.padEnd(30)} | ${pad(s.min, 8)} | ${pad(s.median, 11)} | ${pad(s.max, 8)} | ${pad(s.spread, 11)}`,
    );
  tableRow('host spawn floor (node -e "")', floor);
  tableRow("spawn -> listening", L);
  tableRow("spawn -> first /health", H);
  tableRow("spawn -> registry scanned", S);
  console.log("");
  console.log(loadRange);
  console.log(line("spawn floor", floor));
  console.log(line("spawn -> listening", L));
  console.log(line("spawn -> /health", H));
  console.log(line("spawn -> readiness line", S));
  const missScan = S.median >= BUDGET_MS;
  const missListen = L.median >= BUDGET_MS;
  console.log(
    `verdict: median spawn -> "registry scanned" ${S.median} ms ${missScan ? ">=" : "<"} ${BUDGET_MS} ms -> ${missScan ? "MISS" : "MEET"}`,
  );
  console.log(
    `verdict: median spawn -> listening ${L.median} ms ${missListen ? ">=" : "<"} ${BUDGET_MS} ms -> ${missListen ? "MISS" : "MEET"} (printed for contrast)`,
  );
  if (missScan) process.exitCode = 1;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(String(e?.message || e));
    process.exit(1);
  });
}
