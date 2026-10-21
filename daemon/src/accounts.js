/**
 * Account switching for coding agents: the login an agent keeps on this PC (files, keys inside JSON
 * files, rows of a VS Code style state.vscdb) is saved per account and restored to switch, the way
 * the Freebuff vault does it for Freebuff. One account per person's own logins: no rotation, no
 * device-identity changes.
 *
 * Saved logins hold tokens: they live in the config dir (owner-only, like config.json) and never
 * reach the phone, which sees only an account's label and email. AH_HOME and AH_USERDATA relocate
 * the roots (tests); PD_ACCOUNTS relocates the vault.
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { writeFileAtomic } from "./atomic_write.js";
import { configDir } from "./config.js";

const home = () => process.env.AH_HOME || os.homedir();
const userData = () => process.env.AH_USERDATA || (process.platform === "win32"
  ? process.env.APPDATA || path.join(home(), "AppData", "Roaming")
  : process.platform === "darwin" ? path.join(home(), "Library", "Application Support") : path.join(home(), ".config"));
const vaultDir = () => process.env.PD_ACCOUNTS || path.join(configDir, "accounts");

const jwtEmail = (t) => { try { return JSON.parse(Buffer.from(String(t).split(".")[1], "base64url")).email ?? null; } catch { return null; } };

/**
 * Where each agent keeps its login. A source is a whole file, one key path inside a JSON file, or
 * rows of a SQLite key/value table. [app] is the process that must be closed before rows change.
 */
const AGENTS = {
  claude: {
    sources: () => [
      { kind: "jsonKey", file: path.join(home(), ".claude", "settings.json"), key: ["env", "CLAUDE_CODE_OAUTH_TOKEN"] },
      { kind: "jsonKey", file: path.join(home(), ".claude", ".credentials.json"), key: ["claudeAiOauth"] },
      { kind: "jsonKey", file: path.join(home(), ".claude.json"), key: ["oauthAccount"] },
    ],
    email: (snap) => snap[2]?.emailAddress ?? null,
  },
  codex: {
    sources: () => [{ kind: "file", file: path.join(home(), ".codex", "auth.json") }],
    email: (snap) => { try { return jwtEmail(JSON.parse(snap[0]).tokens?.id_token); } catch { return null; } },
  },
  gemini: {
    sources: () => [
      { kind: "file", file: path.join(home(), ".gemini", "oauth_creds.json") },
      { kind: "file", file: path.join(home(), ".gemini", "google_accounts.json") },
    ],
    email: (snap) => { try { return JSON.parse(snap[1]).active ?? null; } catch { return null; } },
  },
  cursor: {
    app: "Cursor.exe",
    sources: () => [{ kind: "rows", file: path.join(userData(), "Cursor", "User", "globalStorage", "state.vscdb"),
      keys: ["cursorAuth/accessToken", "cursorAuth/refreshToken", "cursorAuth/cachedEmail", "cursorAuth/cachedSignUpType", "cursorAuth/stripeMembershipType"] }],
    email: (snap) => snap[0]?.["cursorAuth/cachedEmail"] ?? null,
  },
  antigravity: {
    app: "Antigravity.exe",
    sources: () => [{ kind: "rows", file: path.join(userData(), "Antigravity", "User", "globalStorage", "state.vscdb"),
      keys: ["antigravityUnifiedStateSync.oauthToken", "antigravityUnifiedStateSync.userStatus", "antigravityAuthStatus", "antigravity.profileUrl"] }],
    email: (snap) => { try { return JSON.parse(snap[0]?.antigravityAuthStatus ?? "null")?.email ?? null; } catch { return null; } },
  },
};

export const supported = (agent) => Object.hasOwn(AGENTS, agent);

async function sqlite(file, readOnly) {
  if (!fs.existsSync(file)) return null;
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(file, { readOnly });
}

const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, "utf8")); } catch { return null; } };
const dig = (o, key) => key.reduce((v, k) => (v == null ? undefined : v[k]), o);

/** The current login of one source, or null when that source holds none. */
async function readSource(s) {
  if (s.kind === "file") { try { return fs.readFileSync(s.file, "utf8"); } catch { return null; } }
  if (s.kind === "jsonKey") return dig(readJson(s.file), s.key) ?? null;
  const db = await sqlite(s.file, true);
  if (!db) return null;
  try {
    const rows = {};
    for (const k of s.keys) {
      const r = db.prepare("SELECT value FROM ItemTable WHERE key = ?").get(k);
      if (r) rows[k] = String(r.value);
    }
    return Object.keys(rows).length ? rows : null;
  } finally { db.close(); }
}

/** Puts a saved login back; null removes that source's login (the agent then shows signed out there). */
async function writeSource(s, value) {
  if (s.kind === "file") {
    if (value == null) fs.rmSync(s.file, { force: true });
    else { fs.mkdirSync(path.dirname(s.file), { recursive: true }); writeFileAtomic(s.file, value, { mode: 0o600 }); }
    return;
  }
  if (s.kind === "jsonKey") {
    const o = readJson(s.file) ?? {};
    let at = o;
    for (const k of s.key.slice(0, -1)) at = at[k] ??= {};
    if (value == null) delete at[s.key.at(-1)]; else at[s.key.at(-1)] = value;
    fs.mkdirSync(path.dirname(s.file), { recursive: true });
    writeFileAtomic(s.file, JSON.stringify(o, null, 2));
    return;
  }
  const db = await sqlite(s.file, false);
  if (!db) throw new Error("the app has never run on this PC");
  try {
    for (const k of s.keys) {
      if (value?.[k] == null) db.prepare("DELETE FROM ItemTable WHERE key = ?").run(k);
      else db.prepare("INSERT OR REPLACE INTO ItemTable (key, value) VALUES (?, ?)").run(k, value[k]);
    }
  } finally { db.close(); }
}

async function snapshot(agent) {
  return Promise.all(AGENTS[agent].sources().map(readSource));
}

// By email where the agent keeps one: tokens refresh, so a hash of the login would change under the same account.
const idFor = (agent, snap) => {
  const email = AGENTS[agent].email(snap);
  return email ? `e:${email.toLowerCase()}` : `h:${crypto.createHash("sha256").update(JSON.stringify(snap)).digest("hex").slice(0, 16)}`;
};
const vaultFile = (agent) => path.join(vaultDir(), `${agent}.json`);
const loadVault = (agent) => readJson(vaultFile(agent)) ?? {};
function saveVault(agent, v) {
  fs.mkdirSync(vaultDir(), { recursive: true, mode: 0o700 });
  writeFileAtomic(vaultFile(agent), JSON.stringify(v, null, 2), { mode: 0o600 });
}

/** The signed-in account (email when the agent keeps one) and the saved ones; never a token. */
export async function list(agent) {
  if (!supported(agent)) return { ok: false, error: `no account switching for ${agent}` };
  const snap = await snapshot(agent);
  const signedIn = snap.some((v) => v != null);
  const current = signedIn ? idFor(agent, snap) : null;
  const vault = loadVault(agent);
  return {
    ok: true,
    agent,
    signedIn,
    email: signedIn ? AGENTS[agent].email(snap) : null,
    saved: Object.entries(vault).map(([id, a]) => ({ id, label: a.label, email: a.email, current: id === current, savedAt: a.savedAt })),
  };
}

/** Keeps the current login under [label] so it can be switched back to later. */
export async function save(agent, label) {
  if (!supported(agent)) return { ok: false, error: `no account switching for ${agent}` };
  const snap = await snapshot(agent);
  if (!snap.some((v) => v != null)) return { ok: false, error: "nobody is signed in to save" };
  const email = AGENTS[agent].email(snap);
  const vault = loadVault(agent);
  const id = idFor(agent, snap);
  vault[id] = { label: String(label || email || "Account").slice(0, 60), email, snap, savedAt: Date.now() };
  saveVault(agent, vault);
  return { ok: true, id };
}

/**
 * Restores a saved login. The current one is saved first under its email (or "Previous") unless it
 * already is, so a switch never loses an account.
 */
export async function switchTo(agent, id, isRunning = () => false) {
  if (!supported(agent)) return { ok: false, error: `no account switching for ${agent}` };
  const target = loadVault(agent)[id];
  if (!target) return { ok: false, error: "that account is not saved on this PC" };
  const app = AGENTS[agent].app;
  if (app && isRunning(app)) return { ok: false, error: `close ${app.replace(/\.exe$/, "")} on the PC first` };
  const snap = await snapshot(agent);
  if (snap.some((v) => v != null) && !loadVault(agent)[idFor(agent, snap)]) await save(agent, AGENTS[agent].email(snap) || "Previous");
  const sources = AGENTS[agent].sources();
  for (let i = 0; i < sources.length; i++) await writeSource(sources[i], target.snap[i] ?? null);
  return { ok: true, id };
}

export function forget(agent, id) {
  if (!supported(agent)) return { ok: false, error: `no account switching for ${agent}` };
  const vault = loadVault(agent);
  if (!vault[id]) return { ok: false, error: "that account is not saved on this PC" };
  delete vault[id];
  saveVault(agent, vault);
  return { ok: true };
}
