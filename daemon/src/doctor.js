/**
 * Doctor — self-diagnosis of the daemon and its environment.
 *
 * Absorbed from whatsapp-claude-plugin / marchat (doctor command): a single
 * `doctor` message returns a structured health report — token auth, TLS cert
 * freshness, PTY availability, tmux presence, manifests on PATH, disk/data
 * dir writability, plus a list of detected problems with hints.
 */

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import https from "node:https";
import { execSync, spawn } from "node:child_process";
import { wakeArmedAdapters } from "./wake.js";

const DATA_DIR = process.env.POCKETDESK_DATA || ".pocketdesk";

function tryExec(cmd, timeoutMs = 4000) {
  try {
    return { ok: true, out: execSync(cmd, { encoding: "utf8", timeout: timeoutMs, stdio: "pipe", windowsHide: true }).trim() };
  } catch (e) {
    return { ok: false, out: String(e.message).split("\n")[0] };
  }
}

/**
 * health: { checks: [{ name, ok, detail, hint? }], problems: [names], ok }
 * Async — some probes spawn processes.
 */
export async function diagnose({ tls, manifests } = {}) {
  const checks = [];

  // Node version
  const major = Number(process.versions.node.split(".")[0]);
  checks.push({
    name: "node",
    ok: major >= 18,
    detail: `v${process.versions.node}`,
    hint: major >= 18 ? undefined : "PocketDesk needs Node >= 18",
  });

  // Data dir writable
  const dataDir = path.join(os.homedir(), DATA_DIR);
  try {
    fs.mkdirSync(dataDir, { recursive: true });
    const probe = path.join(dataDir, ".doctor-probe");
    fs.writeFileSync(probe, "ok");
    fs.unlinkSync(probe);
    checks.push({ name: "data_dir", ok: true, detail: dataDir });
  } catch (e) {
    checks.push({ name: "data_dir", ok: false, detail: e.message, hint: "chat history, schedules and the resurrection store live here" });
  }

  // TLS cert
  if (tls?.enabled) {
    const certOk = fs.existsSync(tls.cert) && fs.existsSync(tls.key);
    checks.push({ name: "tls", ok: certOk, detail: certOk ? tls.cert : "cert or key missing", hint: certOk ? undefined : "run npm run setup-tls" });
  } else {
    checks.push({ name: "tls", ok: true, detail: "disabled (plain ws://)" });
  }

  // PTY (node-pty native module loads lazily — probe it)
  try {
    await import("node-pty");
    checks.push({ name: "pty", ok: true, detail: "node-pty loaded" });
  } catch (e) {
    checks.push({ name: "pty", ok: false, detail: String(e.message).split("\n")[0], hint: "npm install (node-pty needs a native build)" });
  }

  // Manifests / agents on PATH
  let manifestList = [];
  try {
    const dirs = [manifests, process.env.RH_MANIFESTS].filter(Boolean);
    for (const dir of dirs) {
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir)) {
        if (!f.endsWith(".json")) continue;
        try {
          const m = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
          manifestList.push(m);
        } catch {}
      }
    }
    for (const m of manifestList.slice(0, 20)) {
      // A GUI application has no `bin` and is not on PATH; the registry reports
      // its presence by path, so there is nothing for this probe to test.
      if (m.adapter === "gui" || !m.bin) continue;
      const r = await new Promise((resolve) => {
        const p = spawn("cmd.exe", ["/c", m.bin, "--version"], { windowsHide: true });
        let out = "";
        const t = setTimeout(() => { p.kill(); resolve(false); }, 6000);
        p.stdout.on("data", (d) => (out += d));
        p.on("close", (code) => { clearTimeout(t); resolve(code === 0 && out.trim().length > 0); });
        p.on("error", () => { clearTimeout(t); resolve(false); });
      });
      checks.push({
        name: `agent:${m.id}`,
        ok: r,
        detail: r ? `${m.bin} on PATH` : `${m.bin} not found on PATH`,
        hint: r ? undefined : `install ${m.name ?? m.id} or remove its manifest`,
      });
    }
  } catch (e) {
    checks.push({ name: "manifests", ok: false, detail: e.message });
  }

  const armed = await wakeArmedAdapters().catch(() => null);
  if (armed) {
    checks.push({
      name: "wake_on_lan",
      ok: armed.length > 0,
      detail: armed.length ? `can wake the PC: ${armed.join(", ")}` : "no network adapter is allowed to wake this PC",
      hint: armed.length ? undefined : "Device Manager > network adapter > Power Management: allow it to wake the computer, only with a magic packet; enable Wake-on-LAN in the BIOS for a wired port",
    });
  }

  // Console endpoint (optional SYSTEM secure-desktop daemon on 8766).
  if (process.platform === "win32") {
    const task = tryExec('schtasks /query /TN "PocketDeskConsole" /fo LIST');
    const registered = task.ok && !/Disabled/i.test(task.out);
    let reachable = false;
    if (registered) {
      reachable = await new Promise((resolve) => {
        const req = https.request(
          { host: "127.0.0.1", port: 8766, path: "/health", method: "GET", rejectUnauthorized: false, timeout: 2000 },
          (res) => { res.resume(); resolve(res.statusCode === 200); },
        );
        req.on("error", () => resolve(false));
        req.on("timeout", () => { req.destroy(); resolve(false); });
        req.end();
      });
    }
    checks.push({
      name: "console_endpoint",
      // Absent is fine (optional feature); only registered-but-dead is a problem.
      ok: !registered || reachable,
      detail: registered
        ? (reachable ? "SYSTEM console daemon reachable on 8766" : "task registered but 8766 not answering")
        : "not installed (optional)",
      hint: registered && !reachable
        ? "the PocketDeskConsole task is registered but its daemon is down — check %ProgramData%\\PocketDesk\\console"
        : (registered ? undefined : "for lock-screen / UAC / before-login access, run install-service.ps1 -Console elevated"),
    });
  }

  const problems = checks.filter((c) => !c.ok).map((c) => c.name);
  return { checks, problems, ok: problems.length === 0 };
}
