/**
 * Session Monitor — real-time session status tracking.
 * Extracted from c9watch — process scanning, session discovery, status tracking.
 */

const { execSync, spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');
const EventEmitter = require('events');

const SESSION_SCAN_INTERVAL = 5000;
const SESSION_HISTORY_FILE = path.join(os.homedir(), '.pocketdesk', 'session_history.json');

class SessionMonitor extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.history = [];
    this.scanTimer = null;
    this.loadHistory();
  }

  start() {
    this.scanTimer = setInterval(() => this.scanSessions(), SESSION_SCAN_INTERVAL);
    this.scanSessions();
  }

  stop() {
    if (this.scanTimer) {
      clearInterval(this.scanTimer);
      this.scanTimer = null;
    }
  }

  scanSessions() {
    const currentPids = new Set();
    try {
      const output = execSync('tasklist /FO CSV /NH 2>NUL || ps aux 2>/dev/null', {
        encoding: 'utf-8',
        timeout: 5000,
      });

      const lines = output.split('\n').filter(Boolean);
      for (const line of lines) {
        const parts = line.split(',').map(s => s.replace(/"/g, '').trim());
        const processName = parts[0]?.toLowerCase() || '';
        const pid = parseInt(parts[1]);

        if (processName.includes('node') || processName.includes('claude') || processName.includes('python')) {
          if (!isNaN(pid)) {
            currentPids.add(pid);
            if (!this.sessions.has(pid)) {
              const session = this.createSession(pid, processName);
              this.sessions.set(pid, session);
              this.emit('session:discovered', session);
            }
          }
        }
      }
    } catch (e) {
      // Fallback: check common ports
    }

    for (const [pid, session] of this.sessions) {
      if (!currentPids.has(pid)) {
        session.status = 'terminated';
        session.terminatedAt = Date.now();
        this.emit('session:terminated', session);
        this.history.push(session);
        this.sessions.delete(pid);
        this.saveHistory();
      }
    }
  }

  createSession(pid, processName) {
    return {
      id: `session-${pid}-${Date.now()}`,
      pid,
      processName,
      status: 'active',
      createdAt: Date.now(),
      messageCount: 0,
      metadata: {},
    };
  }

  updateSession(pid, updates) {
    const session = this.sessions.get(pid);
    if (session) {
      Object.assign(session, updates);
      this.emit('session:updated', session);
    }
  }

  recordMessage(pid) {
    const session = this.sessions.get(pid);
    if (session) {
      session.messageCount = (session.messageCount || 0) + 1;
    }
  }

  getActiveSessions() {
    return Array.from(this.sessions.values()).filter(s => s.status === 'active');
  }

  getHistory(limit = 50) {
    return this.history.slice(-limit);
  }

  getSessionStats() {
    const active = this.getActiveSessions();
    const totalMessages = active.reduce((sum, s) => sum + (s.messageCount || 0), 0);
    return {
      activeCount: active.length,
      totalMessages,
      historyCount: this.history.length,
    };
  }

  loadHistory() {
    try {
      if (fs.existsSync(SESSION_HISTORY_FILE)) {
        this.history = JSON.parse(fs.readFileSync(SESSION_HISTORY_FILE, 'utf-8'));
      }
    } catch (e) {
      this.history = [];
    }
  }

  saveHistory() {
    try {
      const dir = path.dirname(SESSION_HISTORY_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(SESSION_HISTORY_FILE, JSON.stringify(this.history.slice(-500), null, 2));
    } catch (e) {
      // Silent fail
    }
  }
}

module.exports = { SessionMonitor };
