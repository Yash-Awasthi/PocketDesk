import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const IS_WIN = process.platform === "win32";
const cmdWrap = (cmd) => (IS_WIN ? ["cmd.exe", ["/c", cmd]] : ["/bin/sh", ["-c", cmd]]);

const builtinDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "manifests");
const userDir = process.env.RH_MANIFESTS || path.join(process.env.USERPROFILE || process.env.HOME, ".pocketdesk", "manifests");

export const registry = new Map();

function loadManifests() {
  registry.clear();
  for (const dir of [builtinDir, userDir]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const m = JSON.parse(fs.readFileSync(path.join(dir, f), "utf8"));
        m.adapter = m.adapter || "terminal";
        registry.set(m.id, m);
      } catch (e) {
        console.error(`[registry] bad manifest ${f}: ${e.message}`);
      }
    }
  }
}

const state = new Map(); // id -> { installed, version, installing }
const pinned = new Set(); // ids of pinned tools

export function pin(id) { pinned.add(id); }
export function unpin(id) { pinned.delete(id); }
export function listPinned() { return [...pinned]; }

function shell(cmd, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const [bin, args] = cmdWrap(cmd);
    const p = spawn(bin, args, { windowsHide: true });
    let out = "";
    const t = setTimeout(() => {
      p.kill();
      resolve({ code: -1, out });
    }, timeoutMs);
    p.stdout.on("data", (d) => (out += d));
    p.on("close", (code) => {
      clearTimeout(t);
      resolve({ code: code ?? -1, out });
    });
    p.on("error", () => {
      clearTimeout(t);
      resolve({ code: -1, out });
    });
  });
}

/**
 * Absolute path of a GUI application on this platform, or null when the
 * manifest declares none. GUI apps have no `--version` probe, so presence is
 * the whole detection.
 */
export function guiPath(m) {
  const paths = m && m.paths;
  if (!paths) return null;
  const raw = paths[process.platform] || paths.default;
  if (!raw) return null;
  // Manifests ship for every OS and are read on a machine that may differ, so
  // %VAR% (Windows) and ~ are expanded here rather than stored expanded.
  return raw
    .replace(/%([^%]+)%/g, (_, name) => process.env[name] ?? process.env[name.toUpperCase()] ?? "")
    .replace(/^~(?=$|[/\\])/, process.env.USERPROFILE || process.env.HOME || "");
}

async function detect(id) {
  const m = registry.get(id);
  if (m.adapter === "gui") {
    const p = guiPath(m);
    const ok = Boolean(p && fs.existsSync(p));
    state.set(id, { ...state.get(id), installing: false, installed: ok, version: ok ? p : null });
    return;
  }
  const r = await shell(`${m.bin} --version`);
  const ok = r.code === 0 && r.out.trim().length > 0;
  state.set(id, {
    ...state.get(id),
    installing: false,
    installed: ok,
    version: ok ? r.out.trim().split(/\r?\n/)[0].slice(0, 80) : null,
  });
}

/**
 * Start a GUI application detached from the daemon. The process outlives the
 * request and is not a child session: there is no PTY and nothing to stream,
 * so the phone watches it through the desktop frame stream instead.
 */
export function launchGui(id) {
  const m = registry.get(id);
  if (!m) return { ok: false, reason: "unknown app" };
  if (m.adapter !== "gui") return { ok: false, reason: "not a gui app" };
  const p = guiPath(m);
  if (!p || !fs.existsSync(p)) return { ok: false, reason: "not installed" };
  try {
    // A macOS .app bundle is a directory, not an executable; `open -a` is how
    // it is started. Everything else is spawned directly.
    const [bin, args] = p.endsWith(".app")
      ? ["open", ["-a", p, ...(m.openArgs || [])]]
      : [p, m.openArgs || []];
    const child = spawn(bin, args, { detached: true, stdio: "ignore" });
    // Node reports a failed spawn asynchronously on platforms where the call
    // itself does not throw, and there is no caller left by then: an unhandled
    // 'error' event would take the daemon down.
    child.on("error", (e) => {
      console.error(`[registry] launching ${id} failed: ${e.message}`);
    });
    child.unref();
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) };
  }
  return { ok: true, path: p };
}

export async function scanAll(broadcast) {
  loadManifests();
  await Promise.all([...registry.keys()].map(detect));
  broadcast({ type: "manifests", items: list() });
}

export function list() {
  return [...registry.keys()].map((id) => ({
    manifest: registry.get(id),
    ...(state.get(id) || { installed: null, version: null, installing: false }),
  }));
}

export function get(id) {
  return registry.get(id);
}

export function isInstalled(id) {
  return Boolean(state.get(id)?.installed);
}

export function isInstalling(id) {
  return Boolean(state.get(id)?.installing);
}

export async function install(id, broadcast) {
  const m = registry.get(id);
  if (!m) return;
  const s = state.get(id) || {};
  if (s.installing) return;
  s.installing = true;
  state.set(id, s);
  if (!m.install || (!m.install.npm && !m.install.pip)) {
    s.installing = false;
    broadcast({ type: "progress", id, line: `no installer defined for ${m.id}` });
    return;
  }
  broadcast({ type: "progress", id, line: `$ ${m.install.npm ? `npm install -g ${m.install.npm}` : `pip install ${m.install.pip}`}` });

  const [kind, pkg] = m.install.npm ? ["npm", m.install.npm] : ["pip", m.install.pip];
  const cmd = kind === "npm" ? `npm install -g ${pkg}` : `pip install ${pkg}`;
  await new Promise((resolve) => {
    const [bin, args] = cmdWrap(cmd);
    const p = spawn(bin, args, { windowsHide: true });
    let buf = "";
    const push = (d) => {
      buf += d;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop();
      for (const line of lines) if (line.trim()) broadcast({ type: "progress", id, line: line.slice(0, 300) });
    };
    p.stdout.on("data", push);
    p.stderr.on("data", push);
    p.on("close", async (code) => {
      if (buf.trim()) broadcast({ type: "progress", id, line: buf.slice(0, 300) });
      broadcast({ type: "progress", id, line: code === 0 ? "install complete" : `install failed (exit ${code})` });
      await detect(id);
      broadcast({ type: "manifests", items: list() });
      resolve();
    });
  });
}
