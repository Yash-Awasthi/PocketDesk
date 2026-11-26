// Cold-start measurement for the daemon: how long from spawn to the listening banner, and from
// there to the first /health answer. Both must stay well under the budget, because the registry
// scan (about 60 `cmd.exe /c <bin> --version` probes) blocks the Windows event loop for seconds.
//
//   node scripts/measure-startup.mjs
//
// Prints one line per run and a median line:
//   cold start run 1/3: start->listen 1843 ms, listen->first health 27 ms
//   cold start median: start->listen 1800 ms, listen->first health 24 ms (3 runs, budget 400 ms)
//
// Exit 0 when all runs answered; exit 1 when a daemon never answered (its stderr tail is shown).
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

export const daemonDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export const BUDGET_MS = 400;
const HEALTH_POLL_MS = 12;
const ANSWER_DEADLINE_MS = 60_000;
// Long enough for the deferred scan to finish and print its banner, short enough to keep a 3-run
// measurement under a minute: this is what makes "health before scan" a real ordering, not a race.
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

/**
 * One cold start on free ports and a fresh tmp state dir.
 * Resolves { listenMs, healthMs, healthBeforeScan, scanMs } or throws with the daemon's stderr.
 */
export async function measureOnce() {
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

export function runLine(i, total, r) {
  return `cold start run ${i}/${total}: start->listen ${r.listenMs} ms, listen->first health ${r.healthMs} ms`;
}

export function medianLine(m, total) {
  return `cold start median: start->listen ${m.listenMs} ms, listen->first health ${m.healthMs} ms (${total} runs, budget ${BUDGET_MS} ms)`;
}

async function main() {
  const total = 3;
  const runs = [];
  for (let i = 1; i <= total; i++) {
    const r = await measureOnce();
    runs.push(r);
    console.log(runLine(i, total, r));
  }
  console.log(medianLine(medianOf(runs), total));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(String(e?.message || e));
    process.exit(1);
  });
}
