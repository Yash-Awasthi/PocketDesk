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
 *   - auth:           the codebuff.com session in ~/.config/freebuff-desktop/
 *                     state.json. Signed-in accounts are saved on the PC so
 *                     the phone can switch between them; only email and name
 *                     ever leave the PC.
 *
 * Env knobs (used by tests): FB_PROFILE_DIR, FB_SKILLS_DIRS (path-separator
 * separated), FB_APP_EXE, FB_STATE_FILE, FB_VAULT.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execSync, execFileSync, spawn } from "node:child_process";

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
    // execFileSync (no sh -c): pgrep -f would otherwise match the shell
    // wrapper's own command line, which contains the pattern → always true.
    const out = execFileSync("pgrep", ["-f", exeName], { encoding: "utf8", timeout: 5000 });
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

// The desktop app keeps its codebuff.com session in state.json (not in its Electron storage).
const STATE_FILE = process.env.FB_STATE_FILE || path.join(os.homedir(), ".config", "freebuff-desktop", "state.json");
const AUTH_HOST = "https://www.codebuff.com";
// Saved sessions for switching accounts; tokens never leave this file.
const VAULT = process.env.FB_VAULT
  || path.join(os.homedir(), process.env.POCKETDESK_DATA || ".pocketdesk", "freebuff-accounts.json");

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return fallback;
  }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2));
  fs.renameSync(tmp, file);
}

function currentSession() {
  const s = readJson(STATE_FILE, {})?.authSessions?.[AUTH_HOST];
  return s?.token && s?.user?.email ? s : null;
}

/** Remembers the signed-in account so it can be switched back to later. */
function remember(session) {
  const vault = readJson(VAULT, {});
  vault[session.user.email] = { session, savedAt: new Date().toISOString() };
  writeJson(VAULT, vault);
}

/** Signed-in account (email and name only) — the token is never returned. */
export function authStatus() {
  const s = currentSession();
  if (s) remember(s);
  return { loggedIn: !!s, email: s?.user.email ?? null, name: s?.user.name ?? null };
}

export function accounts() {
  const cur = currentSession();
  if (cur) remember(cur);
  const vault = readJson(VAULT, {});
  return Object.entries(vault)
    .map(([email, v]) => ({ email, name: v.session?.user?.name ?? "", savedAt: v.savedAt, current: cur?.user.email === email }))
    .sort((x, y) => x.email.localeCompare(y.email));
}

/** Quits the app (it rewrites state.json on exit), edits the session, and reopens it. */
function withAppClosed(edit) {
  const wasRunning = isRunning();
  if (wasRunning) {
    appQuit();
    for (let i = 0; i < 50 && isRunning(); i++) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
    if (isRunning()) return { ok: false, error: "Freebuff did not close; quit it on the PC and retry" };
  }
  const state = readJson(STATE_FILE, {});
  state.authSessions = state.authSessions || {};
  edit(state.authSessions);
  writeJson(STATE_FILE, state);
  return { ok: true, reopened: appOpen().ok };
}

/** Signs Freebuff out (the account stays saved for switching back). Needs confirm "CLEAR". */
export function authLogout(confirm) {
  if (confirm !== "CLEAR") return { ok: false, error: 'confirm must be exactly "CLEAR"' };
  const cur = currentSession();
  if (cur) remember(cur);
  return withAppClosed((sessions) => { delete sessions[AUTH_HOST]; });
}

export function accountSwitch(email) {
  const saved = readJson(VAULT, {})[String(email)];
  if (!saved?.session) return { ok: false, error: `no saved Freebuff account: ${email}` };
  const cur = currentSession();
  if (cur) remember(cur);
  return withAppClosed((sessions) => { sessions[AUTH_HOST] = saved.session; });
}

export function accountForget(email) {
  const vault = readJson(VAULT, {});
  delete vault[String(email)];
  writeJson(VAULT, vault);
  return accounts();
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