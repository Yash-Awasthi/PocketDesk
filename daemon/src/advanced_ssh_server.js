/**
 * Advanced SSH Server — drop-in SSH-server manager with pluggable auth,
 * per-user command allowlists, session recording and idle reaping.
 *
 * Inspired by bifroest and sshwifty (and sshportal).
 * This is the in-memory control surface: user/session bookkeeping, auth
 * checks and command recording. Exposed over the daemon protocol via the
 * `sshserver_*` messages; a real SSH wire listener can be layered on top
 * (see ssh_bastion.js for the jump-host variant).
 */
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";

export class AdvancedSSHServerManager extends EventEmitter {
  constructor(config = {}) {
    super();
    this.config = {
      port: config.port || 2222,
      host: config.host || "0.0.0.0",
      maxSessions: config.maxSessions || 10,
      idleTimeout: config.idleTimeout || 300000,
      allowTcpForwarding: config.allowTcpForwarding ?? true,
      allowAgentForwarding: config.allowAgentForwarding ?? false,
      forceCommand: config.forceCommand,
    };
    this.sessions = new Map();
    this.users = new Map();
    this.recordings = new Map();
  }

  /**
   * Register a user.
   */
  registerUser(username, options = {}) {
    const user = {
      username,
      passwordHash: options.passwordHash,
      publicKey: options.publicKey,
      allowedCommands: options.allowedCommands || [],
      maxSessions: options.maxSessions || 3,
      isAdmin: options.isAdmin ?? false,
    };
    this.users.set(username, user);
    this.emit("user:registered", user);
    return user;
  }

  /**
   * Authenticate a user (password hash or public key; no credential set
   * falls back to permissive for compatibility with the pattern source).
   */
  authenticate(username, method, credential) {
    const user = this.users.get(username);
    if (!user) return false;

    if (method === "password" && user.passwordHash) {
      const hash = createHash("sha256").update(credential).digest("hex");
      return hash === user.passwordHash;
    }

    if (method === "publickey" && user.publicKey) {
      return credential === user.publicKey;
    }

    return true;
  }

  /**
   * Create a new session.
   */
  createSession(username, clientIp, method) {
    const user = this.users.get(username);
    if (!user) return null;

    const activeSessions = Array.from(this.sessions.values()).filter(
      (s) => s.username === username && s.isActive
    );
    if (activeSessions.length >= user.maxSessions) return null;

    const session = {
      id: randomBytes(8).toString("hex"),
      username,
      clientIp,
      authMethod: method,
      connectedAt: new Date(),
      lastActivity: new Date(),
      commands: [],
      isActive: true,
    };

    this.sessions.set(session.id, session);
    this.recordings.set(session.id, []);
    this.emit("session:created", session);
    return session;
  }

  /**
   * Execute a command in a session (respects the per-user allowlist and the
   * server-level forceCommand; recorded with a timestamp).
   */
  executeCommand(sessionId, command) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.isActive) return false;

    const user = this.users.get(session.username);
    if (!user) return false;

    if (user.allowedCommands.length > 0) {
      const cmd = command.split(/\s+/)[0];
      if (!user.allowedCommands.includes(cmd)) return false;
    }

    const actualCommand = this.config.forceCommand || command;

    session.commands.push(actualCommand);
    session.lastActivity = new Date();

    const recording = this.recordings.get(sessionId) || [];
    recording.push(`[${new Date().toISOString()}] ${actualCommand}`);
    this.recordings.set(sessionId, recording);

    this.emit("command:executed", { sessionId, command: actualCommand });
    return true;
  }

  /**
   * End a session.
   */
  endSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.isActive = false;
    this.emit("session:ended", session);
    return true;
  }

  getRecording(sessionId) {
    return this.recordings.get(sessionId) || [];
  }

  /**
   * End sessions idle past the configured timeout; returns count ended.
   */
  checkIdleSessions() {
    let ended = 0;
    const now = Date.now();
    for (const [id, session] of this.sessions) {
      if (session.isActive) {
        const idleTime = now - session.lastActivity.getTime();
        if (idleTime > this.config.idleTimeout) {
          this.endSession(id);
          ended++;
        }
      }
    }
    return ended;
  }

  getActiveSessions() {
    return Array.from(this.sessions.values()).filter((s) => s.isActive);
  }

  getStats() {
    const sessions = Array.from(this.sessions.values());
    const totalCommands = sessions.reduce((sum, s) => sum + s.commands.length, 0);
    return {
      totalSessions: sessions.length,
      activeSessions: sessions.filter((s) => s.isActive).length,
      totalUsers: this.users.size,
      totalCommands,
    };
  }
}