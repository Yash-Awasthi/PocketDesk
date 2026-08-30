/**
 * Tmux session manager — session listing, creation, attach/detach lifecycle.
 *
 * Extracted from inspiration/PocketDesk/webmux.
 * Pattern: HTTP + WebSocket protocol for managing shared tmux sessions.
 * Wire protocol: text frames = JSON control messages, binary frames = raw terminal bytes.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const TMUX_BIN = process.env.TMUX_BIN || 'tmux';
const TMUX_SOCKET = process.env.TMUX_SOCKET || '';

function tmuxArgs(args) {
  return TMUX_SOCKET ? ['-L', TMUX_SOCKET, ...args] : args;
}

/**
 * List all active tmux sessions with metadata.
 * Returns array of { id, name, created, attached, windows, command }
 */
export async function listSessions() {
  try {
    const { stdout } = await execFileP(TMUX_BIN, tmuxArgs([
      'list-sessions', '-F',
      '#{session_id}\t#{session_name}\t#{session_created}\t#{session_attached}\t#{session_windows}\t#{session_command}'
    ]), { encoding: 'utf8' });

    return stdout.trim().split('\n').filter(Boolean).map(line => {
      const [id, name, created, attached, windows, command] = line.split('\t');
      return {
        id, name,
        created: parseInt(created, 10),
        attached: parseInt(attached, 10) === 1,
        windows: parseInt(windows, 10),
        command,
      };
    });
  } catch {
    return [];
  }
}

/**
 * Create a new named tmux session.
 */
export async function createSession(name) {
  const sessionName = name || `session-${Date.now()}`;
  try {
    await execFileP(TMUX_BIN, tmuxArgs([
      'new-session', '-d', '-s', sessionName
    ]), { encoding: 'utf8' });
    return { name: sessionName, created: true };
  } catch (err) {
    return { name: sessionName, created: false, error: err.message };
  }
}

/**
 * Kill a tmux session by name.
 */
export async function killSession(name) {
  try {
    await execFileP(TMUX_BIN, tmuxArgs(['kill-session', '-t', name]), { encoding: 'utf8' });
    return { name, killed: true };
  } catch (err) {
    return { name, killed: false, error: err.message };
  }
}

/**
 * Resize a tmux window's pane.
 */
export async function resizePane(name, cols, rows) {
  try {
    await execFileP(TMUX_BIN, tmuxArgs([
      'resize-window', '-t', name, '-x', String(cols), '-y', String(rows)
    ]), { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Send keys to a tmux session (simulate typing).
 */
export async function sendKeys(name, keys) {
  try {
    await execFileP(TMUX_BIN, tmuxArgs([
      'send-keys', '-t', name, keys, 'Enter'
    ]), { encoding: 'utf8' });
    return true;
  } catch {
    return false;
  }
}

/**
 * Capture pane output (screen content).
 */
export async function capturePane(name, lines = 100) {
  try {
    const { stdout } = await execFileP(TMUX_BIN, tmuxArgs([
      'capture-pane', '-t', name, '-p', '-S', `-${lines}`
    ]), { encoding: 'utf8' });
    return stdout;
  } catch {
    return '';
  }
}

/**
 * Wire protocol helpers for the WebSocket interface.
 * text frame = JSON control message
 * binary frame = raw terminal bytes
 */

export function isControlMessage(data) {
  if (typeof data !== 'string') return false;
  try {
    const msg = JSON.parse(data);
    return msg && typeof msg.type === 'string';
  } catch {
    return false;
  }
}

export function makeControlMessage(type, payload = {}) {
  return JSON.stringify({ type, ...payload, ts: Date.now() });
}

export function parseControlMessage(data) {
  try {
    return JSON.parse(data);
  } catch {
    return null;
  }
}

/**
 * Session metadata cache with TTL.
 * Useful for dashboards showing session list without re-querying tmux every time.
 */
export class SessionCache {
  constructor(ttlMs = 5000) {
    this._ttl = ttlMs;
    this._cache = null;
    this._timestamp = 0;
  }

  async get() {
    const now = Date.now();
    if (this._cache && now - this._timestamp < this._ttl) {
      return this._cache;
    }
    this._cache = await listSessions();
    this._timestamp = now;
    return this._cache;
  }

  invalidate() {
    this._cache = null;
    this._timestamp = 0;
  }
}
