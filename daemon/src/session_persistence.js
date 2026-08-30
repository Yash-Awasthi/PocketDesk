/**
 * Session Persistence — Extracted from tmux session persistence patterns.
 *
 * Provides save/restore/snapshot capabilities for terminal sessions,
 * inspired by tmux's session management (tmux-resurrect, tmux-continuum).
 *
 * Key patterns extracted:
 * - Session state serialization (pane layout, environment, scrollback)
 * - Snapshot creation and restoration
 * - Automatic periodic saves
 * - Session migration between servers
 */

import { randomBytes } from 'node:crypto';
import { writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, unlinkSync } from 'node:fs';
import { join } from 'node:path';

// ---------------------------------------------------------------------------
// Session state types
// ---------------------------------------------------------------------------

/**
 * @typedef {Object} PaneState
 * @property {string} id - Pane ID
 * @property {number} width - Pane width
 * @property {number} height - Pane height
 * @property {string} command - Running command
 * @property {string} cwd - Current working directory
 * @property {string[]} environment - Environment variables
 * @property {string} scrollback - Scrollback buffer content
 * @property {number} scrollPosition - Current scroll position
 */

/**
 * @typedef {Object} WindowState
 * @property {string} id - Window ID
 * @property {string} name - Window name
 * @property {number} index - Window index
 * @property {string} layout - Layout layout name
 * @property {PaneState[]} panes - Window panes
 * @property {boolean} active - Whether this is the active window
 */

/**
 * @typedef {Object} SessionSnapshot
 * @property {string} sessionId - Session ID
 * @property {string} name - Session name
 * @property {string} createdAt - ISO timestamp
 * @property {string} savedAt - ISO timestamp
 * @property {WindowState[]} windows - Session windows
 * @property {string} clientIp - Client IP address
 * @property {string} version - Session format version
 * @property {Object} metadata - Additional metadata
 */

// ---------------------------------------------------------------------------
// Persistence manager
// ---------------------------------------------------------------------------

class SessionPersistence {
  /**
   * @param {Object} options
   * @param {string} options.storageDir - Directory for session files
   * @param {number} options.maxSnapshots - Max snapshots per session (default: 10)
   * @param {number} options.autoSaveInterval - Auto-save interval in ms (default: 5min)
   * @param {number} options.maxScrollback - Max scrollback lines to save (default: 10000)
   */
  constructor(options = {}) {
    this.storageDir = options.storageDir || join(process.cwd(), '.sessions');
    this.maxSnapshots = options.maxSnapshots || 10;
    this.autoSaveInterval = options.autoSaveInterval || 5 * 60 * 1000;
    this.maxScrollback = options.maxScrollback || 10000;
    this.VERSION = '1.0.0';

    this._autoSaveTimers = new Map();

    // Ensure storage directory exists
    if (!existsSync(this.storageDir)) {
      mkdirSync(this.storageDir, { recursive: true });
    }
  }

  // -----------------------------------------------------------------------
  // Core save/load
  // -----------------------------------------------------------------------

  /**
   * Save a session snapshot.
   * @param {SessionSnapshot} snapshot
   * @returns {string} Snapshot file path
   */
  saveSnapshot(snapshot) {
    const sessionDir = this._getSessionDir(snapshot.sessionId);
    if (!existsSync(sessionDir)) {
      mkdirSync(sessionDir, { recursive: true });
    }

    // Trim scrollback before saving
    const trimmed = this._trimSnapshot(snapshot);
    trimmed.savedAt = new Date().toISOString();
    trimmed.version = this.VERSION;

    // Write snapshot file
    const filename = `snapshot_${Date.now()}.json`;
    const filepath = join(sessionDir, filename);
    writeFileSync(filepath, JSON.stringify(trimmed, null, 2), 'utf-8');

    // Cleanup old snapshots
    this._cleanupSnapshots(snapshot.sessionId);

    return filepath;
  }

  /**
   * Load the latest snapshot for a session.
   * @param {string} sessionId
   * @returns {SessionSnapshot|null}
   */
  loadLatest(sessionId) {
    const sessionDir = this._getSessionDir(sessionId);
    if (!existsSync(sessionDir)) return null;

    const files = readdirSync(sessionDir)
      .filter(f => f.startsWith('snapshot_') && f.endsWith('.json'))
      .sort()
      .reverse();

    if (files.length === 0) return null;

    const latest = join(sessionDir, files[0]);
    const data = readFileSync(latest, 'utf-8');
    return JSON.parse(data);
  }

  /**
   * Load a specific snapshot by timestamp.
   * @param {string} sessionId
   * @param {string} timestamp - ISO timestamp or snapshot filename
   * @returns {SessionSnapshot|null}
   */
  loadSnapshot(sessionId, timestamp) {
    const sessionDir = this._getSessionDir(sessionId);
    if (!existsSync(sessionDir)) return null;

    const files = readdirSync(sessionDir)
      .filter(f => f.startsWith('snapshot_') && f.endsWith('.json'));

    for (const file of files) {
      const filepath = join(sessionDir, file);
      const data = JSON.parse(readFileSync(filepath, 'utf-8'));
      if (data.savedAt === timestamp || file.includes(timestamp)) {
        return data;
      }
    }

    return null;
  }

  /**
   * List all snapshots for a session.
   * @param {string} sessionId
   * @returns {Array<{filename: string, savedAt: string, windowCount: number}>}
   */
  listSnapshots(sessionId) {
    const sessionDir = this._getSessionDir(sessionId);
    if (!existsSync(sessionDir)) return [];

    return readdirSync(sessionDir)
      .filter(f => f.startsWith('snapshot_') && f.endsWith('.json'))
      .sort()
      .reverse()
      .map(f => {
        const filepath = join(sessionDir, f);
        const data = JSON.parse(readFileSync(filepath, 'utf-8'));
        return {
          filename: f,
          savedAt: data.savedAt,
          windowCount: (data.windows || []).length,
        };
      });
  }

  // -----------------------------------------------------------------------
  // Auto-save management
  // -----------------------------------------------------------------------

  /**
   * Start auto-saving a session at regular intervals.
   * @param {string} sessionId
   * @param {Function} snapshotProvider - Called to get current SessionSnapshot
   */
  startAutoSave(sessionId, snapshotProvider) {
    this.stopAutoSave(sessionId);

    const timer = setInterval(async () => {
      try {
        const snapshot = await snapshotProvider();
        if (snapshot) {
          this.saveSnapshot(snapshot);
        }
      } catch (err) {
        console.error(`[persistence] Auto-save failed for ${sessionId}:`, err.message);
      }
    }, this.autoSaveInterval);

    this._autoSaveTimers.set(sessionId, timer);
  }

  /**
   * Stop auto-saving a session.
   * @param {string} sessionId
   */
  stopAutoSave(sessionId) {
    const timer = this._autoSaveTimers.get(sessionId);
    if (timer) {
      clearInterval(timer);
      this._autoSaveTimers.delete(sessionId);
    }
  }

  /**
   * Stop all auto-save timers.
   */
  stopAll() {
    for (const [id, timer] of this._autoSaveTimers) {
      clearInterval(timer);
    }
    this._autoSaveTimers.clear();
  }

  // -----------------------------------------------------------------------
  // Session restore
  // -----------------------------------------------------------------------

  /**
   * Restore a session from a snapshot.
   * Returns the snapshot data for the caller to reconstruct.
   * @param {string} sessionId
   * @param {string} [timestamp] - Specific snapshot, defaults to latest
   * @returns {{snapshot: SessionSnapshot, restored: boolean, message: string}}
   */
  restoreSession(sessionId, timestamp) {
    const snapshot = timestamp
      ? this.loadSnapshot(sessionId, timestamp)
      : this.loadLatest(sessionId);

    if (!snapshot) {
      return {
        snapshot: null,
        restored: false,
        message: `No snapshot found for session ${sessionId}`,
      };
    }

    // Validate version compatibility
    if (snapshot.version !== this.VERSION) {
      return {
        snapshot,
        restored: false,
        message: `Snapshot version ${snapshot.version} incompatible with current ${this.VERSION}`,
      };
    }

    return {
      snapshot,
      restored: true,
      message: `Session restored from ${snapshot.savedAt}`,
    };
  }

  // -----------------------------------------------------------------------
  // Session migration (export/import)
  // -----------------------------------------------------------------------

  /**
   * Export a session to a portable format.
   * @param {string} sessionId
   * @returns {string} JSON string
   */
  exportSession(sessionId) {
    const snapshot = this.loadLatest(sessionId);
    if (!snapshot) return '';

    return JSON.stringify({
      exportedAt: new Date().toISOString(),
      format: 'pocketdesk-session-export',
      version: this.VERSION,
      snapshot,
    }, null, 2);
  }

  /**
   * Import a session from a portable format.
   * @param {string} exportData - JSON string from exportSession
   * @returns {{sessionId: string, imported: boolean, message: string}}
   */
  importSession(exportData) {
    try {
      const data = JSON.parse(exportData);

      if (data.format !== 'pocketdesk-session-export') {
        return { sessionId: '', imported: false, message: 'Invalid export format' };
      }

      const snapshot = data.snapshot;
      // Generate new session ID to avoid conflicts
      snapshot.sessionId = `imported_${randomBytes(8).toString('hex')}`;

      this.saveSnapshot(snapshot);

      return {
        sessionId: snapshot.sessionId,
        imported: true,
        message: `Session imported as ${snapshot.sessionId}`,
      };
    } catch (err) {
      return { sessionId: '', imported: false, message: `Import failed: ${err.message}` };
    }
  }

  // -----------------------------------------------------------------------
  // Utilities
  // -----------------------------------------------------------------------

  /**
   * Delete all snapshots for a session.
   * @param {string} sessionId
   */
  deleteSession(sessionId) {
    this.stopAutoSave(sessionId);

    const sessionDir = this._getSessionDir(sessionId);
    if (!existsSync(sessionDir)) return;

    const files = readdirSync(sessionDir).filter(f => f.endsWith('.json'));
    for (const file of files) {
      unlinkSync(join(sessionDir, file));
    }
  }

  /**
   * Get storage stats.
   * @returns {{sessionCount: number, totalSnapshots: number, storageDir: string}}
   */
  getStats() {
    let totalSnapshots = 0;
    let sessionCount = 0;

    if (existsSync(this.storageDir)) {
      const entries = readdirSync(this.storageDir);
      for (const entry of entries) {
        const sessionDir = join(this.storageDir, entry);
        try {
          const files = readdirSync(sessionDir).filter(f => f.endsWith('.json'));
          if (files.length > 0) {
            sessionCount++;
            totalSnapshots += files.length;
          }
        } catch {
          // Skip non-directory entries
        }
      }
    }

    return { sessionCount, totalSnapshots, storageDir: this.storageDir };
  }

  // -----------------------------------------------------------------------
  // Internal
  // -----------------------------------------------------------------------

  _getSessionDir(sessionId) {
    return join(this.storageDir, sessionId);
  }

  _trimSnapshot(snapshot) {
    const trimmed = { ...snapshot };
    if (trimmed.windows) {
      trimmed.windows = trimmed.windows.map(win => ({
        ...win,
        panes: (win.panes || []).map(pane => ({
          ...pane,
          scrollback: pane.scrollback
            ? pane.scrollback.split('\n').slice(-this.maxScrollback).join('\n')
            : '',
        })),
      }));
    }
    return trimmed;
  }

  _cleanupSnapshots(sessionId) {
    const sessionDir = this._getSessionDir(sessionId);
    if (!existsSync(sessionDir)) return;

    const files = readdirSync(sessionDir)
      .filter(f => f.startsWith('snapshot_') && f.endsWith('.json'))
      .sort();

    while (files.length > this.maxSnapshots) {
      const oldest = files.shift();
      try {
        unlinkSync(join(sessionDir, oldest));
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Helper: create a snapshot from WebSocket session state
// ---------------------------------------------------------------------------

/**
 * Create a snapshot from a live session's state.
 * @param {Object} session - Active session object
 * @returns {SessionSnapshot}
 */
function createSnapshotFromSession(session) {
  return {
    sessionId: session.id || session.sessionId,
    name: session.name || `session-${Date.now()}`,
    createdAt: session.createdAt || new Date().toISOString(),
    savedAt: new Date().toISOString(),
    windows: (session.windows || []).map(win => ({
      id: win.id,
      name: win.name,
      index: win.index || 0,
      layout: win.layout || 'even-horizontal',
      panes: (win.panes || []).map(pane => ({
        id: pane.id,
        width: pane.cols || 80,
        height: pane.rows || 24,
        command: pane.command || 'bash',
        cwd: pane.cwd || process.env.HOME || '~',
        environment: Object.entries(pane.env || {}).map(([k, v]) => `${k}=${v}`),
        scrollback: pane.scrollback || '',
        scrollPosition: pane.scrollPosition || 0,
      })),
      active: win.active || false,
    })),
    clientIp: session.clientIp || 'unknown',
    version: '1.0.0',
    metadata: {
      platform: process.platform,
      nodeVersion: process.version,
      terminalSize: session.terminalSize || { cols: 80, rows: 24 },
    },
  };
}

export {
  SessionPersistence,
  createSnapshotFromSession,
};
