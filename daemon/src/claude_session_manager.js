/**
 * Claude Session Manager
 *
 * Extracted from Claude-websocket (inspiration).
 * Manages Claude Code CLI sessions with persistence, environment profiles,
 * process lifecycle, and session recovery.
 */

import { randomUUID } from "node:crypto";
import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import * as os from "os";

/**
 * @typedef {Object} ClaudeSession
 * @property {string} sessionId
 * @property {string} state - 'starting', 'connected', 'running', 'exited'
 * @property {string} cwd
 * @property {string} model
 * @property {string} permissionMode
 * @property {number} createdAt
 * @property {number|null} pid
 * @property {number|null} exitCode
 * @property {string} cliSessionId
 * @property {boolean} archived
 */

const HOME_DIR = os.homedir();
const COMPANION_DIR = join(HOME_DIR, ".pocketdesk");
const SESSIONS_DIR = join(COMPANION_DIR, "sessions");
const ENVS_DIR = join(COMPANION_DIR, "envs");

/**
 * Initialize the session storage directories
 */
export function initStorage() {
  for (const dir of [COMPANION_DIR, SESSIONS_DIR, ENVS_DIR]) {
    if (!existsSync(dir)) {
      mkdirSync(dir, { recursive: true });
    }
  }
}

/**
 * Get session file path
 * @param {string} sessionId
 * @returns {string}
 */
function sessionPath(sessionId) {
  return join(SESSIONS_DIR, `${sessionId}.json`);
}

/**
 * Save session to disk
 * @param {ClaudeSession} session
 */
export function saveSession(session) {
  initStorage();
  writeFileSync(sessionPath(session.sessionId), JSON.stringify(session, null, 2));
}

/**
 * Load session from disk
 * @param {string} sessionId
 * @returns {ClaudeSession | null}
 */
export function loadSession(sessionId) {
  const path = sessionPath(sessionId);
  if (!existsSync(path)) return null;
  try {
    return JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return null;
  }
}

/**
 * List all sessions from disk
 * @returns {ClaudeSession[]}
 */
export function listSessions() {
  initStorage();
  const { readdirSync } = await import("node:fs");
  const files = readdirSync(SESSIONS_DIR).filter(f => f.endsWith(".json"));
  return files.map(f => {
    try {
      return JSON.parse(readFileSync(join(SESSIONS_DIR, f), "utf-8"));
    } catch {
      return null;
    }
  }).filter(Boolean);
}

/**
 * Delete session from disk
 * @param {string} sessionId
 * @returns {boolean}
 */
export function deleteSession(sessionId) {
  const path = sessionPath(sessionId);
  if (existsSync(path)) {
    const { unlinkSync } = await import("node:fs");
    unlinkSync(path);
    return true;
  }
  return false;
}

/**
 * Create a new Claude session
 * @param {Object} options
 * @returns {ClaudeSession}
 */
export function createSession(options = {}) {
  const sessionId = randomUUID();
  const session = {
    sessionId,
    state: "starting",
    cwd: options.cwd || process.cwd(),
    model: options.model || "claude-sonnet-4-20250514",
    permissionMode: options.permissionMode || "auto",
    createdAt: Date.now(),
    pid: null,
    exitCode: null,
    cliSessionId: null,
    archived: false,
  };

  saveSession(session);
  return session;
}

/**
 * Update session state
 * @param {string} sessionId
 * @param {Partial<ClaudeSession>} updates
 * @returns {ClaudeSession | null}
 */
export function updateSession(sessionId, updates) {
  const session = loadSession(sessionId);
  if (!session) return null;

  Object.assign(session, updates);
  saveSession(session);
  return session;
}

/**
 * Archive a session
 * @param {string} sessionId
 * @returns {ClaudeSession | null}
 */
export function archiveSession(sessionId) {
  return updateSession(sessionId, { archived: true, state: "exited" });
}

// --- Environment Profiles ---

/**
 * Get environment profile path
 * @param {string} name
 * @returns {string}
 */
function envProfilePath(name) {
  return join(ENVS_DIR, `${name}.env`);
}

/**
 * Save environment profile
 * @param {string} name
 * @param {Record<string, string>} env
 */
export function saveEnvProfile(name, env) {
  initStorage();
  const lines = Object.entries(env).map(([k, v]) => `${k}=${v}`);
  writeFileSync(envProfilePath(name), lines.join("\n"));
}

/**
 * Load environment profile
 * @param {string} name
 * @returns {Record<string, string>}
 */
export function loadEnvProfile(name) {
  const path = envProfilePath(name);
  if (!existsSync(path)) return {};

  const content = readFileSync(path, "utf-8");
  const env = {};
  for (const line of content.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eqIdx = trimmed.indexOf("=");
    if (eqIdx > 0) {
      env[trimmed.slice(0, eqIdx)] = trimmed.slice(eqIdx + 1);
    }
  }
  return env;
}

/**
 * List available environment profiles
 * @returns {string[]}
 */
export function listEnvProfiles() {
  initStorage();
  const { readdirSync } = await import("node:fs");
  return readdirSync(ENVS_DIR)
    .filter(f => f.endsWith(".env"))
    .map(f => f.replace(".env", ""));
}

/**
 * Build launch command for Claude CLI
 * @param {ClaudeSession} session
 * @param {string} wsUrl
 * @returns {string[]}
 */
export function buildLaunchCommand(session, wsUrl) {
  const args = [
    "claude",
    "--sdk-url", wsUrl,
    "--model", session.model,
  ];

  if (session.permissionMode) {
    args.push("--permission-mode", session.permissionMode);
  }

  if (session.cliSessionId) {
    args.push("--resume", session.cliSessionId);
  }

  return args;
}

/**
 * Check if a process is still alive
 * @param {number} pid
 * @returns {boolean}
 */
export function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Recover sessions from disk on startup
 * @returns {{ recovered: number, sessions: ClaudeSession[] }}
 */
export function recoverSessions() {
  const sessions = listSessions();
  let recovered = 0;

  for (const session of sessions) {
    if (session.state === "exited" || session.archived) continue;

    if (session.pid && isProcessAlive(session.pid)) {
      session.state = "starting"; // Wait for WebSocket reconnection
      recovered++;
    } else {
      session.state = "exited";
      session.exitCode = -1;
    }
    saveSession(session);
  }

  return { recovered, sessions };
}
