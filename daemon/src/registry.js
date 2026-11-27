import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";

const IS_WIN = process.platform === "win32";
const cmdWrap = (cmd) => (IS_WIN ? ["cmd.exe", ["/c", cmd]] : ["/bin/sh", ["-c", cmd]]);

export const builtinDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "manifests");
const userDir =
  process.env.RH_MANIFESTS ||
  path.join(process.env.USERPROFILE || process.env.HOME, ".pocketdesk", "manifests");

export const registry = new Map();

/**
 * A manifest as this OS sees it: `platforms.<os>` (or `platforms.unix` off Windows) overrides its fields,
 * and a bin of `$SHELL` is the login shell.
 */
export function forPlatform(m, platform = process.platform, env = process.env) {
  if (!m.platforms) return m;
  const { platforms, ...base } = m;
  const out = { ...base, ...(platforms[platform] ?? (platform !== "win32" ? platforms.unix : null) ?? {}) };
  if (out.bin === "$SHELL") out.bin = env.SHELL || "/bin/sh";
  return out;
}

const KNOWN_ADAPTERS = ["terminal", "gui"];
const KNOWN_KEYS = new Set([
  "id",
  "name",
  "adapter",
  "bin",
  "check",
  "install",
  "auth",
  "chat",
  "paths",
  "platforms",
  "openArgs",
  "docs",
  "compat",
  "description",
]);
const VERSION_TRIPLE = /(\d+)\.(\d+)\.(\d+)/;

const isObject = (v) => Boolean(v) && typeof v === "object" && !Array.isArray(v);
const isText = (v) => typeof v === "string" && v.trim().length > 0;
const isStringArray = (v) => Array.isArray(v) && v.every((x) => typeof x === "string");

/**
 * Checks a manifest as written, before `platforms` is applied: the errors and warnings name the
 * file and the field, so a drop-in manifest can be fixed without reading this code.
 */
export function validateManifest(m, file = "<manifest>") {
  const errors = [];
  const warnings = [];
  if (!isObject(m)) return { ok: false, errors: [`${file}: manifest: must be a JSON object`], warnings };
  const fail = (field, msg) => errors.push(`${file}: ${field}: ${msg}`);

  if (!isText(m.id)) fail("id", "required");
  if (!isText(m.name)) fail("name", "required");
  if (!isText(m.adapter)) fail("adapter", "required");
  else if (!KNOWN_ADAPTERS.includes(m.adapter))
    fail("adapter", `unknown "${m.adapter}" (known: ${KNOWN_ADAPTERS.join(", ")})`);

  if (m.adapter === "gui") {
    const keys = ["win32", "darwin", "linux", "default"];
    if (!isObject(m.paths) || !keys.some((k) => isText(m.paths[k])))
      fail("paths", `gui adapter needs one of ${keys.join(", ")}`);
  } else if (KNOWN_ADAPTERS.includes(m.adapter) && !isText(m.bin) && !isText(m.check)) {
    fail("bin", "required for a terminal adapter (or a check command)");
  }

  if (m.chat !== undefined) {
    if (!isObject(m.chat)) fail("chat", "must be an object");
    else {
      if (m.chat.args !== undefined && !isStringArray(m.chat.args))
        fail("chat.args", "must be an array of strings");
      if (m.chat.models !== undefined) {
        if (!isObject(m.chat.models)) fail("chat.models", "must be an object");
        else
          for (const [model, spec] of Object.entries(m.chat.models))
            if (!isObject(spec) || !isStringArray(spec.args))
              fail(`chat.models.${model}`, "args must be an array of strings");
      }
    }
  }

  if (m.compat !== undefined) {
    if (!isObject(m.compat)) fail("compat", "must be an object");
    else if (!isText(m.compat.minVersion) || !/^\d+\.\d+\.\d+$/.test(m.compat.minVersion))
      fail("compat.minVersion", "must be a x.y.z version");
  }

  // Unknown keys are tolerated so a newer manifest still loads on an older daemon.
  for (const key of Object.keys(m))
    if (!KNOWN_KEYS.has(key)) warnings.push(`${file}: ${key}: warning: unknown key`);

  return { ok: errors.length === 0, errors, warnings };
}

/** The first x.y.z triple in a probe's output, or null: a version is never invented. */
export function parseVersion(text) {
  if (typeof text !== "string") return null;
  const m = VERSION_TRIPLE.exec(text);
  if (!m) return null;
  return { version: `${m[1]}.${m[2]}.${m[3]}`, parts: [Number(m[1]), Number(m[2]), Number(m[3])] };
}

const compareParts = (a, b) => {
  for (let i = 0; i < 3; i++) if (a[i] !== b[i]) return a[i] - b[i];
  return 0;
};

/**
 * Compares a `--version` output against `compat.minVersion`. Installed means the probe printed a
 * version: a binary that runs but prints none is not evidence of a usable install.
 */
export function checkCompat(manifest, text) {
  const min = manifest?.compat?.minVersion;
  const expected = isText(min) ? min : "any";
  const parsed = parseVersion(text);
  if (!parsed)
    return {
      installed: false,
      version: "not installed",
      found: "none",
      expected,
      ok: false,
      reason: "no version found",
    };
  const base = { installed: true, version: parsed.version, found: parsed.version, expected };
  if (expected === "any") return { ...base, ok: true, reason: "no minimum declared" };
  const ok = compareParts(parsed.parts, min.split(".").map(Number)) >= 0;
  return { ...base, ok, reason: ok ? "ok" : `installed ${parsed.version} < required ${min}` };
}

export function loadManifests() {
  registry.clear();
  for (const dir of [builtinDir, userDir]) {
    if (!fs.existsSync(dir)) continue;
    for (const f of fs.readdirSync(dir)) {
      if (!f.endsWith(".json")) continue;
      try {
        const m = forPlatform(JSON.parse(fs.readFileSync(path.join(dir, f), "utf8")));
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

export function pin(id) {
  pinned.add(id);
}
export function unpin(id) {
  pinned.delete(id);
}
export function listPinned() {
  return [...pinned];
}

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

/** One `bin --version` probe, so the CLI reports compatibility without its own spawn logic. */
export async function versionProbe(m) {
  if (!isText(m?.bin)) return { code: -1, out: "" };
  return shell(`${m.bin} --version`);
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
  // `check` is for tools without --version (powershell.exe treats it as a script).
  const r = await shell(m.check || `${m.bin} --version`);
  const ok = r.code === 0 && r.out.trim().length > 0;
  state.set(id, {
    ...state.get(id),
    installing: false,
    installed: ok,
    version: ok ? r.out.trim().split(/\r?\n/)[0].slice(0, 80) : null,
  });
}

/**
 * Start an application detached from the daemon. The process outlives the
 * request and is not a child session: there is no PTY and nothing to stream,
 * so the phone watches it through the desktop frame stream instead.
 *
 * `folder` is the project to open. Every IDE here takes a directory as its
 * last positional argument, and it also becomes the process's own cwd for the
 * ones that do not.
 */
export function launchApp({ path: p, args = [], folder }) {
  const store = typeof p === "string" && p.startsWith("shell:AppsFolder\\");
  if (!p || (!store && !fs.existsSync(p))) return { ok: false, reason: "not installed" };
  let dir;
  if (folder && folder.trim()) {
    const resolved = path.resolve(
      folder.replace(/^~(?=$|[/\\])/, process.env.USERPROFILE || process.env.HOME || ""),
    );
    if (!fs.existsSync(resolved) || !fs.statSync(resolved).isDirectory())
      return { ok: false, reason: "no such folder" };
    dir = resolved;
  }
  const tail = dir ? [dir] : [];
  try {
    // A macOS .app bundle is a directory, not an executable, and a Windows
    // .lnk is resolved by the shell: both need a launcher in front of them.
    // Everything else is spawned directly.
    const [bin, argv] = store
      ? ["explorer.exe", [p]]
      : p.endsWith(".app")
        ? ["open", ["-a", p, ...args, ...tail]]
        : p.toLowerCase().endsWith(".lnk")
          ? ["cmd.exe", ["/c", "start", "", p, ...args, ...tail]]
          : [p, [...args, ...tail]];
    const child = spawn(bin, argv, { detached: true, stdio: "ignore", cwd: dir, windowsHide: true });
    // Node reports a failed spawn asynchronously on platforms where the call
    // itself does not throw, and there is no caller left by then: an unhandled
    // 'error' event would take the daemon down.
    child.on("error", (e) => {
      console.error(`[registry] launching ${p} failed: ${e.message}`);
    });
    child.unref();
  } catch (e) {
    return { ok: false, reason: e?.message || String(e) };
  }
  return { ok: true, path: p };
}

export function launchGui(id, folder) {
  const m = registry.get(id);
  if (!m) return { ok: false, reason: "unknown app" };
  if (m.adapter !== "gui") return { ok: false, reason: "not a gui app" };
  return launchApp({ path: guiPath(m), args: m.openArgs || [], folder });
}

// Settles after the first full scan; before it every tool reads as unknown or not installed, so
// anything that starts a tool waits for it (a phone often connects while the daemon is starting).
let firstScan;
export const ready = new Promise((resolve) => {
  firstScan = resolve;
});

export async function scanAll(broadcast) {
  loadManifests();
  await Promise.all([...registry.keys()].map(detect));
  broadcast({ type: "manifests", items: list() });
  firstScan();
}

// One shared scan: the readiness probe and the startup fallback must not each spawn 60 probes.
let inflight = null;
export function scan(broadcast) {
  if (!inflight)
    inflight = scanAll(broadcast).finally(() => {
      inflight = null;
    });
  return inflight;
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
  broadcast({
    type: "progress",
    id,
    line: `$ ${m.install.npm ? `npm install -g ${m.install.npm}` : `pip install ${m.install.pip}`}`,
  });

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
      for (const line of lines)
        if (line.trim()) broadcast({ type: "progress", id, line: line.slice(0, 300) });
    };
    p.stdout.on("data", push);
    p.stderr.on("data", push);
    p.on("close", async (code) => {
      if (buf.trim()) broadcast({ type: "progress", id, line: buf.slice(0, 300) });
      broadcast({
        type: "progress",
        id,
        line: code === 0 ? "install complete" : `install failed (exit ${code})`,
      });
      await detect(id);
      broadcast({ type: "manifests", items: list() });
      resolve();
    });
  });
}
