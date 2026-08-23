import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

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

function shell(cmd, timeoutMs = 8000) {
  return new Promise((resolve) => {
    const p = spawn("cmd.exe", ["/c", cmd], { windowsHide: true });
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

async function detect(id) {
  const m = registry.get(id);
  const r = await shell(`${m.bin} --version`);
  const ok = r.code === 0 && r.out.trim().length > 0;
  state.set(id, {
    ...state.get(id),
    installing: false,
    installed: ok,
    version: ok ? r.out.trim().split(/\r?\n/)[0].slice(0, 80) : null,
  });
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
  broadcast({ type: "progress", id, line: `$ ${m.install.npm ? `npm install -g ${m.install.npm}` : `pip install ${m.install.pip}`}` });

  const [kind, pkg] = m.install.npm ? ["npm", m.install.npm] : ["pip", m.install.pip];
  const cmd = kind === "npm" ? `npm install -g ${pkg}` : `pip install ${pkg}`;
  await new Promise((resolve) => {
    const p = spawn("cmd.exe", ["/c", cmd], { windowsHide: true });
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
