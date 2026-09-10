/**
 * Run Scheduler — scheduled runs / auto-continue loops / cron from chat.
 *
 * Absorbed from codeman / codex-bee / claude-threads / kagora: schedule a
 * prompt (or command) to fire on an interval, after a delay, or N times.
 * Loops auto-continue an agent (send the same prompt each run) — the phone
 * schedules it and walks away.
 *
 * Persisted to POCKETDESK_DATA/schedules.json so runs survive restarts.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const DATA_DIR = process.env.POCKETDESK_DATA || ".pocketdesk";
const STORE = path.join(os.homedir(), DATA_DIR, "schedules.json");

const MAX_RUNS = 200;
const MIN_INTERVAL_MS = 5_000;

let jobs = [];
let timer = null;
let fireFn = null; // async ({ job, runAt }) — injected by server.js

function load() {
  try {
    const parsed = JSON.parse(fs.readFileSync(STORE, "utf8"));
    jobs = Array.isArray(parsed) ? parsed : [];
  } catch {
    jobs = [];
  }
}

function save() {
  try {
    fs.mkdirSync(path.dirname(STORE), { recursive: true });
    fs.writeFileSync(STORE, JSON.stringify(jobs.slice(-MAX_RUNS), null, 2));
  } catch {}
}

function persist() {
  save();
}

export function init(fire) {
  fireFn = fire;
  load();
  // Drop one-shot jobs that fired while the daemon was down; reset running ones.
  const now = Date.now();
  jobs = jobs.filter((j) => j.kind !== "once" || j.nextRunAt > now);
  for (const j of jobs) j.running = false;
  save();
  if (!timer) {
    timer = setInterval(sweep, 1_000);
    timer.unref?.();
  }
  return jobs.length;
}

export function stop() {
  if (timer) clearInterval(timer);
  timer = null;
}

function sweep() {
  const now = Date.now();
  for (const j of [...jobs]) {
    if (j.paused || j.running) continue;
    if (j.nextRunAt <= now) {
      j.running = true;
      j.lastRunAt = now;
      j.runCount = (j.runCount ?? 0) + 1;
      const isFinal = j.kind === "once" || (j.maxRuns > 0 && j.runCount >= j.maxRuns);
      if (isFinal) {
        j.done = true;
      } else {
        j.nextRunAt = now + Math.max(MIN_INTERVAL_MS, Number(j.intervalMs) || MIN_INTERVAL_MS);
      }
      persist();
      Promise.resolve()
        .then(() => fireFn?.({ job: j }))
        .catch(() => {})
        .finally(() => {
          j.running = false;
          if (j.done) jobs = jobs.filter((x) => x.id !== j.id);
          persist();
        });
    }
  }
}

/**
 * kind: "interval" (every intervalMs), "once" (after delayMs), "count"
 * (intervalMs, maxRuns times). schedule: { chatId, text, kind, intervalMs,
 * delayMs, maxRuns }.
 */
export function schedule({ chatId, text, kind = "interval", intervalMs, delayMs, maxRuns = 0 }) {
  const k = ["interval", "once", "count"].includes(kind) ? kind : "interval";
  const now = Date.now();
  const job = {
    id: "job_" + crypto.randomBytes(6).toString("hex"),
    chatId: String(chatId ?? ""),
    text: String(text ?? ""),
    kind: k,
    intervalMs: Math.max(MIN_INTERVAL_MS, Number(intervalMs) || MIN_INTERVAL_MS),
    maxRuns: Math.max(0, Number(maxRuns) || 0),
    runCount: 0,
    paused: false,
    done: false,
    running: false,
    createdAt: now,
    nextRunAt: k === "once" ? now + Math.max(0, Number(delayMs) || 0) : now + Math.max(MIN_INTERVAL_MS, Number(intervalMs) || MIN_INTERVAL_MS),
  };
  jobs.push(job);
  persist();
  return job;
}

export function list() {
  return jobs.map((j) => ({ ...j }));
}

export function get(id) {
  return jobs.find((j) => j.id === id) ?? null;
}

export function pause(id) {
  const j = get(id);
  if (!j) return null;
  j.paused = true;
  persist();
  return j;
}

export function resume(id) {
  const j = get(id);
  if (!j) return null;
  j.paused = false;
  j.nextRunAt = Date.now() + Math.max(MIN_INTERVAL_MS, Number(j.intervalMs) || MIN_INTERVAL_MS);
  persist();
  return j;
}

export function cancel(id) {
  const before = jobs.length;
  jobs = jobs.filter((j) => j.id !== id);
  persist();
  return jobs.length < before;
}

/** Test hook: force the sweep without waiting for the timer. */
export function sweepNow() {
  sweep();
}
