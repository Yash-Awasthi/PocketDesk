/**
 * SSH Bastion — jump-host / transparent SSH bastion manager.
 *
 * Inspired by sshportal, ssh_bastion_cardea and skerryssh.
 * Provides users/hosts registry, access rules (with expiry and time
 * conditions), session recording and invite tokens. Exposed over the daemon
 * protocol via the `bastion_*` messages.
 */
import { createHash, randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";

export class SSHBastion extends EventEmitter {
  constructor() {
    super();
    this.users = new Map();
    this.hosts = new Map();
    this.sessions = new Map();
    this.accessRules = new Map();
    this.invites = new Map();
  }

  /**
   * Register a new user.
   */
  registerUser(username, publicKey, accessLevel = "limited", email) {
    const user = {
      id: randomBytes(8).toString("hex"),
      username,
      email,
      publicKey,
      accessLevel,
      createdAt: new Date(),
      isActive: true,
      allowedHosts: [],
      maxSessions: accessLevel === "admin" ? 10 : accessLevel === "superadmin" ? 50 : 3,
      tags: [],
    };
    this.users.set(user.id, user);
    this.emit("user:registered", user);
    return user;
  }

  /**
   * Register a new host.
   */
  registerHost(name, hostname, port, username, group = "default") {
    const host = {
      id: randomBytes(8).toString("hex"),
      name,
      hostname,
      port,
      username,
      group,
      tags: [],
      createdAt: new Date(),
      isActive: true,
      environment: {},
    };
    this.hosts.set(host.id, host);
    this.emit("host:registered", host);
    return host;
  }

  /**
   * Create an access rule (explicit allow/deny for a user→host pair).
   */
  createAccessRule(userId, hostId, accessLevel, allowed = true, options = {}) {
    const rule = {
      id: randomBytes(8).toString("hex"),
      userId,
      hostId,
      accessLevel,
      allowed,
      createdAt: new Date(),
      expiresAt: options.expiresAt ? new Date(options.expiresAt) : undefined,
      conditions: options.conditions,
    };
    this.accessRules.set(rule.id, rule);
    this.emit("access:created", rule);
    return rule;
  }

  /**
   * Check if a user can access a host.
   */
  canAccess(userId, hostId) {
    const user = this.users.get(userId);
    const host = this.hosts.get(hostId);

    if (!user || !user.isActive) return { allowed: false, reason: "User not found or inactive" };
    if (!host || !host.isActive) return { allowed: false, reason: "Host not found or inactive" };

    // Explicit rules win (first match); expired rules deny.
    for (const rule of this.accessRules.values()) {
      if (rule.userId === userId && rule.hostId === hostId) {
        if (rule.expiresAt && rule.expiresAt < new Date()) {
          return { allowed: false, reason: "Access rule expired" };
        }
        return { allowed: rule.allowed, reason: rule.allowed ? "Access granted by rule" : "Access denied by rule" };
      }
    }

    // Host-group access falls back to the user's allowedHosts.
    if (user.allowedHosts.includes(host.group)) {
      return { allowed: true, reason: "Access granted by host group" };
    }

    return { allowed: false, reason: "No matching access rule" };
  }

  /**
   * Start a session (denied unless canAccess passes and the user is under
   * their session limit).
   */
  startSession(userId, hostId, clientIp) {
    const access = this.canAccess(userId, hostId);
    if (!access.allowed) return null;

    const user = this.users.get(userId);
    if (!user) return null;

    const activeSessions = Array.from(this.sessions.values()).filter(
      (s) => s.userId === userId && s.isActive
    );
    if (activeSessions.length >= user.maxSessions) return null;

    const session = {
      id: randomBytes(8).toString("hex"),
      userId,
      hostId,
      startTime: new Date(),
      clientIp,
      inputBytes: 0,
      outputBytes: 0,
      commandCount: 0,
      isActive: true,
    };

    this.sessions.set(session.id, session);
    user.lastLogin = new Date();
    this.emit("session:started", session);
    return session;
  }

  endSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session || !session.isActive) return false;

    session.endTime = new Date();
    session.isActive = false;
    this.emit("session:ended", session);
    return true;
  }

  getActiveSessions(userId) {
    return Array.from(this.sessions.values()).filter(
      (s) => s.userId === userId && s.isActive
    );
  }

  getHostSessions(hostId, limit = 50) {
    return Array.from(this.sessions.values())
      .filter((s) => s.hostId === hostId)
      .sort((a, b) => b.startTime.getTime() - a.startTime.getTime())
      .slice(0, limit);
  }

  /**
   * Generate a user invite token (stored so acceptInvite can validate it).
   */
  generateInviteToken(email, accessLevel = "limited") {
    const payload = `${email}:${accessLevel}:${Date.now()}`;
    const token = createHash("sha256").update(payload).digest("hex").slice(0, 32);
    this.invites.set(token, { email, accessLevel, createdAt: new Date(), used: false });
    return token;
  }

  /**
   * Accept an invite token (validates against generated invites).
   */
  acceptInvite(token, username, publicKey) {
    const invite = this.invites.get(token);
    if (!invite || invite.used) return null;
    invite.used = true;
    return this.registerUser(username, publicKey, invite.accessLevel, invite.email);
  }

  listUsers() {
    return Array.from(this.users.values());
  }

  listHosts() {
    return Array.from(this.hosts.values());
  }

  listAccessRules() {
    return Array.from(this.accessRules.values());
  }

  getStats() {
    const users = Array.from(this.users.values());
    const hosts = Array.from(this.hosts.values());
    const sessions = Array.from(this.sessions.values());
    return {
      totalUsers: users.length,
      activeUsers: users.filter((u) => u.isActive).length,
      totalHosts: hosts.length,
      activeHosts: hosts.filter((h) => h.isActive).length,
      activeSessions: sessions.filter((s) => s.isActive).length,
      totalSessions: sessions.length,
    };
  }
}