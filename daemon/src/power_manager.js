/**
 * Power Manager
 *
 * Extracted from orca (inspiration).
 * Prevents system sleep when agents are active with platform-specific
 * assertions, stale status detection, and auto-mode switching.
 */

import { execSync } from 'child_process';

// --- Constants ---

const STATUS_STALE_AFTER_MS = 2 * 60 * 60 * 1000; // 2 hours

const AWAKE_MODES = ['off', 'auto', 'on'];

// --- Types ---

/**
 * @typedef {'off' | 'auto' | 'on'} AwakeMode
 */

/**
 * @typedef {Object} AgentStatus
 * @property {string} agentId
 * @property {'running' | 'idle' | 'stopped'} state
 * @property {number} receivedAt
 */

/**
 * @typedef {Object} PowerStatus
 * @property {AwakeMode} mode
 * @property {boolean} active
 */

// --- Platform Detection ---

function getPlatform() {
  const platform = process.platform;
  if (platform === 'darwin') return 'macos';
  if (platform === 'linux') return 'linux';
  if (platform === 'win32') return 'windows';
  return 'unknown';
}

// --- Awake Assertions ---

class MacosAssertion {
  constructor(logger = console) {
    this.logger = logger;
    this.assertionId = null;
  }

  start(reason) {
    if (this.assertionId !== null) return;
    try {
      // macOS: use pmset to prevent sleep
      execSync('pmset -a sleep 0', { stdio: 'ignore' });
      this.assertionId = Date.now();
      this.logger.debug(`[power] macOS sleep disabled: ${reason}`);
    } catch (e) {
      this.logger.warn(`[power] Failed to disable macOS sleep: ${e.message}`);
    }
  }

  stop(reason) {
    if (this.assertionId === null) return;
    try {
      execSync('pmset -a sleep 1', { stdio: 'ignore' });
      this.assertionId = null;
      this.logger.debug(`[power] macOS sleep restored: ${reason}`);
    } catch (e) {
      this.logger.warn(`[power] Failed to restore macOS sleep: ${e.message}`);
    }
  }

  dispose() {
    if (this.assertionId !== null) {
      this.stop('dispose');
    }
  }
}

class LinuxAssertion {
  constructor(logger = console) {
    this.logger = logger;
    this.inhibited = false;
  }

  start(reason) {
    if (this.inhibited) return;
    try {
      execSync('systemd-inhibit --what=idle --who=PocketDesk --why="' + reason + '" --mode=block &', { stdio: 'ignore' });
      this.inhibited = true;
      this.logger.debug(`[power] Linux idle inhibited: ${reason}`);
    } catch (e) {
      this.logger.warn(`[power] Failed to inhibit Linux idle: ${e.message}`);
    }
  }

  stop(reason) {
    if (!this.inhibited) return;
    this.inhibited = false;
    this.logger.debug(`[power] Linux idle uninhibited: ${reason}`);
  }

  dispose() {
    this.stop('dispose');
  }
}

class WindowsAssertion {
  constructor(logger = console) {
    this.logger = logger;
    this.executed = false;
  }

  start(reason) {
    if (this.executed) return;
    try {
      // Windows: use powercfg to prevent sleep
      execSync('powercfg /change standby-timeout-ac 0', { stdio: 'ignore' });
      this.executed = true;
      this.logger.debug(`[power] Windows standby disabled: ${reason}`);
    } catch (e) {
      this.logger.warn(`[power] Failed to disable Windows standby: ${e.message}`);
    }
  }

  stop(reason) {
    if (!this.executed) return;
    try {
      execSync('powercfg /change standby-timeout-ac 30', { stdio: 'ignore' });
      this.executed = false;
      this.logger.debug(`[power] Windows standby restored: ${reason}`);
    } catch (e) {
      this.logger.warn(`[power] Failed to restore Windows standby: ${e.message}`);
    }
  }

  dispose() {
    this.stop('dispose');
  }
}

// --- Power Manager ---

export class PowerManager {
  constructor(options = {}) {
    this.mode = options.mode || 'auto';
    this.statuses = [];
    this.listeners = new Set();
    this.staleTimer = null;
    this.now = options.now || (() => Date.now());
    this.logger = options.logger || console;

    const platform = options.platform || getPlatform();
    if (platform === 'macos') {
      this.assertion = new MacosAssertion(this.logger);
    } else if (platform === 'linux') {
      this.assertion = new LinuxAssertion(this.logger);
    } else {
      this.assertion = new WindowsAssertion(this.logger);
    }
  }

  setMode(mode) {
    if (!AWAKE_MODES.includes(mode)) {
      throw new Error(`Invalid mode: ${mode}. Must be one of: ${AWAKE_MODES.join(', ')}`);
    }
    if (this.mode === mode) return;
    this.mode = mode;
    this.refresh('settings-change');
  }

  setStatuses(statuses) {
    this.statuses = statuses.map(s => ({ ...s }));
    this.refresh('status-change');
  }

  addStatus(status) {
    const existing = this.statuses.findIndex(s => s.agentId === status.agentId);
    if (existing >= 0) {
      this.statuses[existing] = { ...status };
    } else {
      this.statuses.push({ ...status });
    }
    this.refresh('status-change');
  }

  removeStatus(agentId) {
    this.statuses = this.statuses.filter(s => s.agentId !== agentId);
    this.refresh('status-change');
  }

  getStatus() {
    const runningCount = this.getEligibleRunningCount();
    return {
      mode: this.mode,
      active: this.mode === 'on' || (this.mode === 'auto' && runningCount > 0),
    };
  }

  subscribe(listener) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  dispose() {
    this.clearStaleTimer();
    this.assertion.dispose();
  }

  // --- Private ---

  getEligibleRunningCount() {
    const now = this.now();
    return this.statuses.filter(s =>
      s.state === 'running' && (now - s.receivedAt) < STATUS_STALE_AFTER_MS
    ).length;
  }

  refresh(reason) {
    this.scheduleStaleTimer();
    const runningCount = this.getEligibleRunningCount();
    const shouldBlock = this.mode === 'on' || (this.mode === 'auto' && runningCount > 0);

    if (shouldBlock) {
      this.assertion.start(reason);
    } else {
      this.assertion.stop(reason);
    }

    this.publishStatus(shouldBlock);
  }

  publishStatus(active) {
    const status = { mode: this.mode, active };
    for (const listener of this.listeners) {
      try {
        listener(status);
      } catch (e) {
        this.logger.warn(`[power] Listener error: ${e.message}`);
      }
    }
  }

  scheduleStaleTimer() {
    this.clearStaleTimer();
    this.staleTimer = setTimeout(() => this.refresh('stale-check'), STATUS_STALE_AFTER_MS);
  }

  clearStaleTimer() {
    if (this.staleTimer !== null) {
      clearTimeout(this.staleTimer);
      this.staleTimer = null;
    }
  }
}

// --- Helpers ---

export function normalizeAwakeMode(mode) {
  if (typeof mode !== 'string') return 'off';
  const normalized = mode.toLowerCase().trim();
  if (AWAKE_MODES.includes(normalized)) return normalized;
  return 'off';
}

export function isStatusStale(status, now = Date.now()) {
  return (now - status.receivedAt) >= STATUS_STALE_AFTER_MS;
}

export default {
  PowerManager,
  normalizeAwakeMode,
  isStatusStale,
};
