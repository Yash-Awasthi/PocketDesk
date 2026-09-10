/**
 * Freebuff control — mobile control surface for the Freebuff desktop app.
 *
 * Exposes what Freebuff actually stores on this machine, without reaching
 * into the running app's memory:
 *   - profile dir:    %APPDATA%/Freebuff (Electron profile: Preferences,
 *                     Local State, Network session, Local Storage)
 *   - skills:         ~/.claude/skills (+ project .claude/skills, any dirs in
 *                     FB_SKILLS_DIRS) — the skill store Freebuff loads at
 *                     session start ("read fresh from disk")
 *   - auth:           JWT persisted in the app's Local Storage leveldb.
 *                     fb_auth_status reports ONLY logged-in state and token
 *                     expiry — the token itself is never returned or logged.
 *   - logout:         backs up Local Storage / Session Storage, clears them,
 *                     and can restart the app so the login screen returns.
 *
 * Env knobs (used by tests): FB_PROFILE_DIR, FB_SKILLS_DIRS (path-separator
 * separated), FB_APP_EXE.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, spawn } from "node:child_process";

const PROFILE_DIR = process.env.FB_PROFILE_DIR || (process.env.APPDATA
  ? path.join(process.env.APPDATA, "Freebuff")
  : path.join(os.homedir(), ".config", "Freebuff"));

const DEFAULT_SKILLS_DIRS = () => {
  const dirs = [path.join(os.homedir(), ".claude", "skills")];
  try {
    const proj = path.join(process.cwd(), ".claude", "skills");
    if (fs.existsSync(proj)) dirs.push(proj);
  } catch {}
  return dirs;
};

function skillsDirs() {
  if (process.env.FB_SKILLS_DIRS) {
    return process.env.FB_SKILLS_DIRS.split(path.delimiter).filter(Boolean);
  }
  return DEFAULT_SKILLS_DIRS();
}

// Only these profile-relative files are readable/writable via the protocol.
const CONFIG_ALLOWLIST = [
  "Preferences",
  "Local State",
  "Network/Network Persistent State",
];

const APP_EXE = process.env.FB_APP_EXE || path.join(
  process.env.LOCALAPPDATA || "",
  "Programs",
  "@codebufffreebuff-desktop",
  "Freebuff.exe",
);

const MAX_CONFIG_BYTES = 1024 * 1024;

function profilePath(rel) {
  const p = path.resolve(PROFILE_DIR, rel);
  // Confine reads to the profile dir.
  if (!p.startsWith(PROFILE_DIR + path.sep) && p !== PROFILE_DIR) return null;
  return p;
}

function appBasename() {
  return path.basename(APP_EXE) || "Freebuff.exe";
}

function isRunning(exeName = appBasename()) {
  try {
    if (process.platform === "win32") {
      const out = execSync(`tasklist /FI "IMAGENAME eq ${exeName}" /NH`, {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"],
        timeout: 5000,
      });
      return new RegExp(exeName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i").test(out);
    }
    const out = execSync(`pgrep -f ${JSON.stringify(exeName)} || true`, { encoding: "utf8", timeout: 5000 });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

export function getProfileDir() {
  return PROFILE_DIR;
}

export function status() {
  const running = isRunning();
  const skills = skillList();
  const configs = configList();
  return {
    running,
    profile: PROFILE_DIR,
    profileExists: fs.existsSync(PROFILE_DIR),
    appExe: APP_EXE,
    skillsDir: skillsDirs(),
    skillCount: skills.length,
    configCount: configs.length,
    auth: authStatus(),
  };
}

export function configList() {
  const items = [];
  for (const rel of CONFIG_ALLOWLIST) {
    const p = profilePath(rel);
    if (!p || !fs.existsSync(p)) continue;
    const st = fs.statSync(p);
    items.push({ name: rel, size: st.size, mtime: st.mtime.toISOString() });
  }
  return items;
}

export function configGet(name) {
  const rel = String(name || "");
  if (!CONFIG_ALLOWLIST.includes(rel)) return { ok: false, error: `config not in allowlist: ${rel}` };
  const p = profilePath(rel);
  if (!p || !fs.existsSync(p)) return { ok: false, error: `no such config: ${rel}` };
  if (fs.statSync(p).size > MAX_CONFIG_BYTES) return { ok: false, error: "config too large to read" };
  try {
    return { ok: true, name: rel, content: JSON.parse(fs.readFileSync(p, "utf8")) };
  } catch (e) {
    return { ok: false, error: `unparseable config: ${e.message}` };
  }
}

export function configSet(name, patch) {
  const rel = String(name || "");
  if (!CONFIG_ALLOWLIST.includes(rel)) return { ok: false, error: `config not in allowlist: ${rel}` };
  const p = profilePath(rel);
  if (!p || !fs.existsSync(p)) return { ok: false, error: `no such config: ${rel}` };
  if (typeof patch !== "object" || patch === null || Array.isArray(patch)) {
    return { ok: false, error: "patch must be a JSON object (deep-merged)" };
  }
  try {
    const current = JSON.parse(fs.readFileSync(p, "utf8"));
    const backup = `${p}.bak-${Date.now()}`;
    fs.copyFileSync(p, backup);
    const next = deepMerge(current, patch);
    // Atomic write: temp file + rename, so a crash mid-write never leaves a
    // truncated Preferences/Local State the app then flushes back on exit.
    const tmp = `${p}.tmp-${Date.now()}`;
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2));
    fs.renameSync(tmp, p);
    const appRunning = isRunning();
    return {
      ok: true,
      name: rel,
      backedUp: path.basename(backup),
      // The Electron app may hold these files open and flush over our edit on
      // exit — warn the client when it's running.
      appRunning,
      warning: appRunning ? "Freebuff is running — it may overwrite this edit when it exits. Quit the app first for guaranteed persistence." : undefined,
    };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

function deepMerge(base, patch) {
  const out = { ...base };
  for (const [k, v] of Object.entries(patch)) {
    if (v && typeof v === "object" && !Array.isArray(v) && out[k] && typeof out[k] === "object" && !Array.isArray(out[k])) {
      out[k] = deepMerge(out[k], v);
    } else {
      out[k] = v;
    }
  }
  return out;
}

export function skillList() {
  const seen = new Set();
  const items = [];
  for (const dir of skillsDirs()) {
    if (!fs.existsSync(dir)) continue;
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const e of entries) {
      if (!e.isDirectory() || seen.has(e.name)) continue;
      const skillDir = path.join(dir, e.name);
      const md = path.join(skillDir, "SKILL.md");
      if (!fs.existsSync(md)) continue;
      seen.add(e.name);
      const st = fs.statSync(md);
      items.push({
        name: e.name,
        dir: skillDir,
        size: st.size,
        mtime: st.mtime.toISOString(),
        description: readDescription(md),
      });
    }
  }
  items.sort((a, b) => a.name.localeCompare(b.name));
  return items;
}

function readDescription(md) {
  try {
    const first = fs.readFileSync(md, "utf8").split(/\r?\n/).find((l) => l.trim());
    if (!first) return "";
    return first.replace(/^#+\s*/, "").slice(0, 120);
  } catch {
    return "";
  }
}

function skillDirFor(name) {
  const n = String(name || "");
  // Traversal-safe: single path segment only.
  if (!n || n.includes("/") || n.includes("\\") || n === "." || n === "..") return null;
  for (const dir of skillsDirs()) {
    const candidate = path.join(dir, n);
    if (fs.existsSync(path.join(candidate, "SKILL.md"))) return candidate;
  }
  return null;
}

export function skillGet(name) {
  const dir = skillDirFor(name);
  if (!dir) return { ok: false, error: `no such skill: ${name}` };
  try {
    return { ok: true, name, dir, content: fs.readFileSync(path.join(dir, "SKILL.md"), "utf8") };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

/**
 * Auth status — derived from the persisted JWT's *presence and expiry only*.
 * The token itself is never returned, logged, or decoded beyond the payload
 * `exp` claim.
 */
const JWT_RE = /[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/;

function scanForJwt(file) {
  try {
    const st = fs.statSync(file);
    if (!st.isFile() || st.size > 64 * 1024 * 1024) return null;
    const buf = fs.readFileSync(file, "utf8");
    return buf.match(JWT_RE)?.[0] || null;
  } catch {
    return null;
  }
}

function authFiles() {
  const roots = ["Local Storage/leveldb", "Session Storage", "Network", "Local State", "Preferences"];
  const files = [];
  for (const rel of roots) {
    const p = profilePath(rel);
    if (!p || !fs.existsSync(p)) continue;
    if (fs.statSync(p).isDirectory()) {
      try {
        for (const f of fs.readdirSync(p)) {
          const fp = path.join(p, f);
          if (fs.statSync(fp).isFile() && /\.(log|ldb|json|txt)$/i.test(f)) files.push(fp);
        }
      } catch {}
    } else {
      files.push(p);
    }
  }
  return files;
}

/**
 * Auth status — derived from a JWT's *presence and expiry only* wherever the
 * app persists it (Local Storage leveldb, Session Storage, Network session,
 * Local State). The token itself is never returned, logged, or decoded beyond
 * the payload `exp` claim.
 */
export function authStatus() {
  let loggedIn = false;
  let expiresAt = null;
  for (const file of authFiles()) {
    const jwt = scanForJwt(file);
    if (jwt) {
      loggedIn = true;
      try {
        const payload = JSON.parse(Buffer.from(jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"));
        if (payload?.exp) expiresAt = new Date(payload.exp * 1000).toISOString();
      } catch {}
      break;
    }
  }
  const leveldb = profilePath("Local Storage/leveldb");
  const session = profilePath("Session Storage");
  return {
    loggedIn,
    expiresAt,
    store: "app persisted state (Local Storage / Session Storage / Network)",
    storeExists: !!(leveldb && fs.existsSync(leveldb)),
    sessionStorageExists: !!(session && fs.existsSync(session)),
  };
}

/**
 * Logout: back up the app's persisted web state (which holds the JWT), clear
 * it, and optionally restart Freebuff so the login screen returns. Requires an
 * explicit confirm string to guard against accidental wipes.
 */
export function authLogout(confirm, { restart = false } = {}) {
  if (confirm !== "CLEAR") {
    return { ok: false, error: 'confirm must be exactly "CLEAR"', hint: "restart=true kills and relaunches Freebuff so logout takes effect immediately" };
  }
  const targets = ["Local Storage", "Session Storage"];
  const backups = [];
  for (const rel of targets) {
    const p = profilePath(rel);
    if (!p || !fs.existsSync(p)) continue;
    const backup = `${p}.bak-${Date.now()}`;
    try {
      fs.cpSync(p, backup, { recursive: true });
      fs.rmSync(p, { recursive: true, force: true });
      backups.push(path.basename(backup));
    } catch (e) {
      return { ok: false, error: `failed clearing ${rel}: ${e.message}` };
    }
  }
  let restarted = false;
  if (restart) {
    restarted = appRestart();
  }
  return { ok: true, backups, restarted };
}

export function appOpen() {
  if (isRunning()) return { ok: true, alreadyRunning: true };
  if (!APP_EXE || !fs.existsSync(APP_EXE)) return { ok: false, error: `app not found: ${APP_EXE}` };
  try {
    const child = spawn(APP_EXE, [], { detached: true, stdio: "ignore" });
    child.unref();
    return { ok: true };
  } catch (e) {
    return { ok: false, error: e.message };
  }
}

export function appRestart() {
  appQuit();
  // taskkill returns before the process tree is fully gone — wait for the
  // app to actually stop, then relaunch (otherwise isRunning() sees it still
  // up and appOpen() reports alreadyRunning:true, never relaunching).
  for (let i = 0; i < 30; i++) {
    if (!isRunning()) break;
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
  }
  return appOpen().ok;
}

export function appQuit() {
  try {
    if (process.platform === "win32") {
      execSync(`taskkill /IM ${appBasename()} /T`, { stdio: "ignore", timeout: 10000 });
    } else {
      execSync(`pkill -f ${JSON.stringify(appBasename())} || true`, { stdio: "ignore", timeout: 10000 });
    }
    return { ok: true };
  } catch {
    return { ok: false };
  }
}