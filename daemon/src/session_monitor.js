/**
 * Session Monitor — real-time session status tracking.
 * Extracted from c9watch — process scanning, session discovery, status tracking.
 *
 * NOTE: ported from CJS to ESM (it could not be imported under the package's
 * "type": "module" before). History persists under the daemon data dir
 * (POCKETDESK_DATA), not a hardcoded ~/.pocketdesk.
 */

import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { EventEmitter } from "node:events";

const SESSION_SCAN_INTERVAL = 5000;
const DATA_DIR = process.env.POCKETDESK_DATA || ".pocketdesk";
const SESSION_HISTORY_FILE = path.join(os.homedir(), DATA_DIR, "session_history.json");

export class SessionMonitor extends EventEmitter {
  constructor() {
    super();
    this.sessions = new Map();
    this.history = [];
    this.scanTimer = null;
    this.loadHistory();
  }

  start() {
    if (this.scanTimer) return;
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
      // Windows tasklist is CSV; Linux ps aux is whitespace-separated — one
      // command per platform, parsed accordingly (the old `tasklist || ps`
      // fallback parsed Linux output as CSV and found nothing).
      const isWin = process.platform === "win32";
      const output = execSync(isWin ? "tasklist /FO CSV /NH" : "ps aux", {
        encoding: "utf-8",
        timeout: 5000,
      });

      const lines = output.split("\n").filter(Boolean);
      for (const line of lines) {
        let processName = "";
        let pid = NaN;
        if (isWin) {
          const parts = line.split(",").map((s) => s.replace(/"/g, "").trim());
          processName = parts[0]?.toLowerCase() || "";
          pid = parseInt(parts[1]);
        } else {
          const parts = line.trim().split(/\s+/);
          pid = parseInt(parts[1]);
          processName = (parts[10] || parts[0] || "").toLowerCase();
        }

        if (processName.includes("node") || processName.includes("claude") || processName.includes("python")) {
          if (!isNaN(pid)) {
            currentPids.add(pid);
            if (!this.sessions.has(pid)) {
              const session = this.createSession(pid, processName);
              this.sessions.set(pid, session);
              this.emit("session:discovered", session);
            }
          }
        }
      }
    } catch {
      // Fallback: check common ports
    }

    for (const [pid, session] of this.sessions) {
      if (!currentPids.has(pid)) {
        session.status = "terminated";
        session.terminatedAt = Date.now();
        this.emit("session:terminated", session);
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
      status: "active",
      createdAt: Date.now(),
      messageCount: 0,
      metadata: {},
    };
  }

  updateSession(pid, updates) {
    const session = this.sessions.get(pid);
    if (session) {
      Object.assign(session, updates);
      this.emit("session:updated", session);
    }
  }

  recordMessage(pid) {
    const session = this.sessions.get(pid);
    if (session) {
      session.messageCount = (session.messageCount || 0) + 1;
    }
  }

  getActiveSessions() {
    return Array.from(this.sessions.values()).filter((s) => s.status === "active");
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
        this.history = JSON.parse(fs.readFileSync(SESSION_HISTORY_FILE, "utf-8"));
      }
    } catch {
      this.history = [];
    }
  }

  saveHistory() {
    try {
      const dir = path.dirname(SESSION_HISTORY_FILE);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(SESSION_HISTORY_FILE, JSON.stringify(this.history.slice(-500), null, 2));
    } catch {
      // Silent fail
    }
  }
}
