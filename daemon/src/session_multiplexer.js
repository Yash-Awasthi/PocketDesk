/**
 * Session Multiplexer
 *
 * Extracted from agentpeek (inspiration).
 * Manages tmux sessions with name validation, activity detection,
 * and waiting-state monitoring. Pure functions — no DB, no async.
 */

import { execSync } from 'child_process';

// --- Constants ---

const SESSION_RE = /^[A-Za-z0-9_-]+$/;
const SESSION_RE_WITH_SPACES = /^[A-Za-z0-9 _-]+$/;

const SHELLS = new Set(['bash', 'zsh', 'sh', 'fish', 'dash', 'ash', 'ksh', 'tcsh', 'csh']);

const WAITING_MARKERS = [
  'Enter to select',
  'Do you want to proceed',
  'No, and tell Claude what to do',
];

// --- Errors ---

export class MuxError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MuxError';
  }
}

export class InvalidName extends MuxError {
  constructor(message) {
    super(message);
    this.name = 'InvalidName';
  }
}

// --- Validation ---

export function validateName(name, allowSpaces = false) {
  if (!name) {
    throw new InvalidName('Session name cannot be empty');
  }
  const regex = allowSpaces ? SESSION_RE_WITH_SPACES : SESSION_RE;
  if (!regex.test(name)) {
    throw new InvalidName(
      `Invalid session name: "${name}". Only letters, digits,${allowSpaces ? ' spaces,' : ''} '-' and '_' are allowed.`
    );
  }
}

// --- Tmux Commands ---

function tmux(args) {
  try {
    const result = execSync(`tmux ${args}`, { encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] });
    return { success: true, stdout: result.trim(), stderr: '' };
  } catch (error) {
    return { success: false, stdout: '', stderr: error.stderr || error.message };
  }
}

// --- Session Operations ---

export function hasSession(name) {
  validateName(name);
  const result = tmux(`has-session -t =${name}`);
  return result.success;
}

export function listSessions() {
  // Real TAB separator (\t) — tmux formats do not expand backslash escapes.
  const result = tmux('list-sessions -F "#{session_name}\t#{session_created}\t#{session_attached}\t#{@agentpeek_group}\t#{@agentpeek_cwd}\t#{window_activity}"');

  if (!result.success) {
    // No tmux server = no sessions
    if (result.stderr.includes('no server running') || result.stderr.includes('No such file')) {
      return [];
    }
    throw new MuxError(result.stderr);
  }

  // Get pane info for activity detection
  const paneResult = tmux('list-panes -a -F "#{session_name}\t#{pane_active}\t#{pane_current_command}\t#{pane_current_path}"');

  const foreground = {};
  const liveCwd = {};

  if (paneResult.success) {
    for (const line of paneResult.stdout.split('\n')) {
      const parts = line.split('\t');
      const [sname, active, cmd, path] = parts;
      if (cmd && !SHELLS.has(cmd) && !(sname in foreground)) {
        foreground[sname] = cmd;
      }
      if (active === '1' && path) {
        liveCwd[sname] = path;
      }
    }
  }

  const sessions = [];
  for (const line of result.stdout.split('\n')) {
    const parts = line.split('\t');
    if (parts.length < 6) continue;

    const [name, created, attached, group, cwd, activity] = parts;
    const busy = name in foreground;

    sessions.push({
      name,
      created: parseInt(created) || 0,
      attached: attached !== '0',
      busy,
      foreground: foreground[name] || null,
      activity: parseInt(activity) || 0,
      group: group || 'General',
      cwd: liveCwd[name] || cwd || null,
    });
  }

  return sessions;
}

export function paneWaiting(name) {
  validateName(name);
  const result = tmux(`capture-pane -p -t =${name}:`);
  if (!result.success) return false;
  return WAITING_MARKERS.some(m => result.stdout.includes(m));
}

export function getSessionInfo(name) {
  validateName(name);
  const sessions = listSessions();
  return sessions.find(s => s.name === name) || null;
}

// --- Session Creation ---

export function createSession(name, options = {}) {
  validateName(name, true);

  if (hasSession(name)) {
    throw new MuxError(`Session "${name}" already exists`);
  }

  const { cwd = process.cwd(), group = 'General' } = options;

  // Create session with initial window
  const result = tmux(
    `new-session -d -s "${name}" -c "${cwd}" ` +
    `-x ${options.cols || 120} -y ${options.rows || 40}`
  );

  if (!result.success) {
    throw new MuxError(`Failed to create session: ${result.stderr}`);
  }

  // Set group as user option
  tmux(`set-option -t "${name}" -g agentpeek_group "${group}"`);

  return { name, created: Date.now(), group, cwd };
}

export function killSession(name) {
  validateName(name);
  const result = tmux(`kill-session -t ="${name}"`);
  return result.success;
}

// --- Activity Monitoring ---

export function getActivitySummary() {
  const sessions = listSessions();

  const summary = {
    total: sessions.length,
    active: 0,
    idle: 0,
    busy: 0,
    attached: 0,
    groups: {},
  };

  for (const session of sessions) {
    if (session.busy) {
      summary.busy++;
    } else {
      summary.idle++;
    }

    if (session.attached) {
      summary.attached++;
    }

    if (session.activity > 0) {
      summary.active++;
    }

    const group = session.group;
    if (!summary.groups[group]) {
      summary.groups[group] = { total: 0, busy: 0 };
    }
    summary.groups[group].total++;
    if (session.busy) {
      summary.groups[group].busy++;
    }
  }

  return summary;
}

// --- Export ---

export default {
  validateName,
  hasSession,
  listSessions,
  paneWaiting,
  getSessionInfo,
  createSession,
  killSession,
  getActivitySummary,
  MuxError,
  InvalidName,
};
