/**
 * Host Stats — live machine stats for dashboard host cards.
 *
 * Absorbed from webmux/vmux/multimux (per-box CPU/RAM/disk cards).
 * Uses only node:os — no shell-outs, works on Windows/Linux/Mac.
 */

import os from "node:os";

const cpuTimes = { idle: 0, total: 0 };

function cpuUsagePercent() {
  const cpus = os.cpus();
  let idle = 0;
  let total = 0;
  for (const cpu of cpus) {
    for (const [key, ms] of Object.entries(cpu.times)) {
      total += ms;
      if (key === "idle") idle += ms;
    }
  }
  if (cpuTimes.total === 0) {
    cpuTimes.idle = idle;
    cpuTimes.total = total;
    return null; // first sample — no delta yet
  }
  const dIdle = idle - cpuTimes.idle;
  const dTotal = total - cpuTimes.total;
  cpuTimes.idle = idle;
  cpuTimes.total = total;
  return dTotal > 0 ? Math.round((1 - dIdle / dTotal) * 100) : null;
}

export function hostStats() {
  return {
    type: "stats",
    hostname: os.hostname(),
    platform: os.platform(),
    release: os.release(),
    arch: os.arch(),
    uptimeSec: Math.round(os.uptime()),
    cpuCount: os.cpus().length,
    cpuModel: os.cpus()[0]?.model?.trim() || "unknown",
    cpuUsagePercent: cpuUsagePercent(),
    loadavg: os.loadavg().map((n) => Math.round(n * 100) / 100),
    memTotalMb: Math.round(os.totalmem() / 1024 / 1024),
    memFreeMb: Math.round(os.freemem() / 1024 / 1024),
  };
}
