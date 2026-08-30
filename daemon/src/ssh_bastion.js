/**
 * SSH Bastion — Jump host / transparent SSH bastion server.
 *
 * Inspired by sshportal and skerryssh.
 * Provides SSH proxying, session recording, access control,
 * and user/host management.
 */

import { createHash, randomBytes } from 'crypto';
import { EventEmitter } from 'events';

// ============================================================================
// Types
// ============================================================================

export type AccessLevel = 'readonly' | 'limited' | 'admin' | 'superadmin';

export interface BastionUser {
  id: string;
  username: string;
  email?: string;
  publicKey: string;
  accessLevel: AccessLevel;
  createdAt: Date;
  lastLogin?: Date;
  isActive: boolean;
  allowedHosts: string[];
  maxSessions: number;
  tags: string[];
}

export interface BastionHost {
  id: string;
  name: string;
  hostname: string;
  port: number;
  username: string;
  group: string;
  tags: string[];
  createdAt: Date;
  lastConnected?: Date;
  isActive: boolean;
  requiresJumpHost?: string;
  environment: Record<string, string>;
}

export interface SessionRecord {
  id: string;
  userId: string;
  hostId: string;
  startTime: Date;
  endTime?: Date;
  clientIp: string;
  inputBytes: number;
  outputBytes: number;
  commandCount: number;
  isActive: boolean;
  recordingPath?: string;
}

export interface AccessRule {
  id: string;
  userId: string;
  hostId: string;
  accessLevel: AccessLevel;
  allowed: boolean;
  createdAt: Date;
  expiresAt?: Date;
  conditions?: {
    timeOfDay?: { start: string; end: string };
    dayOfWeek?: number[];
    maxDuration?: number;
  };
}

// ============================================================================
// SSH Bastion
// ============================================================================

export class SSHBastion extends EventEmitter {
  private users: Map<string, BastionUser> = new Map();
  private hosts: Map<string, BastionHost> = new Map();
  private sessions: Map<string, SessionRecord> = new Map();
  private accessRules: Map<string, AccessRule> = new Map();

  /**
   * Register a new user.
   */
  registerUser(
    username: string,
    publicKey: string,
    accessLevel: AccessLevel = 'limited',
    email?: string
  ): BastionUser {
    const user: BastionUser = {
      id: randomBytes(8).toString('hex'),
      username,
      email,
      publicKey,
      accessLevel,
      createdAt: new Date(),
      isActive: true,
      allowedHosts: [],
      maxSessions: accessLevel === 'admin' ? 10 : accessLevel === 'superadmin' ? 50 : 3,
      tags: [],
    };

    this.users.set(user.id, user);
    this.emit('user:registered', user);
    return user;
  }

  /**
   * Register a new host.
   */
  registerHost(
    name: string,
    hostname: string,
    port: number,
    username: string,
    group: string = 'default'
  ): BastionHost {
    const host: BastionHost = {
      id: randomBytes(8).toString('hex'),
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
    this.emit('host:registered', host);
    return host;
  }

  /**
   * Create an access rule.
   */
  createAccessRule(
    userId: string,
    hostId: string,
    accessLevel: AccessLevel,
    allowed: boolean = true
  ): AccessRule {
    const rule: AccessRule = {
      id: randomBytes(8).toString('hex'),
      userId,
      hostId,
      accessLevel,
      allowed,
      createdAt: new Date(),
    };

    this.accessRules.set(rule.id, rule);
    return rule;
  }

  /**
   * Check if a user can access a host.
   */
  canAccess(userId: string, hostId: string): { allowed: boolean; reason: string } {
    const user = this.users.get(userId);
    const host = this.hosts.get(hostId);

    if (!user || !user.isActive) return { allowed: false, reason: 'User not found or inactive' };
    if (!host || !host.isActive) return { allowed: false, reason: 'Host not found or inactive' };

    // Check explicit rules
    for (const rule of this.accessRules.values()) {
      if (rule.userId === userId && rule.hostId === hostId) {
        if (rule.expiresAt && rule.expiresAt < new Date()) {
          return { allowed: false, reason: 'Access rule expired' };
        }
        return { allowed: rule.allowed, reason: rule.allowed ? 'Access granted by rule' : 'Access denied by rule' };
      }
    }

    // Check host group access
    if (user.allowedHosts.includes(host.group)) {
      return { allowed: true, reason: 'Access granted by host group' };
    }

    // Default: deny
    return { allowed: false, reason: 'No matching access rule' };
  }

  /**
   * Start a session.
   */
  startSession(userId: string, hostId: string, clientIp: string): SessionRecord | null {
    const access = this.canAccess(userId, hostId);
    if (!access.allowed) return null;

    const user = this.users.get(userId);
    if (!user) return null;

    // Check session limit
    const activeSessions = Array.from(this.sessions.values()).filter(
      (s) => s.userId === userId && s.isActive
    );
    if (activeSessions.length >= user.maxSessions) return null;

    const session: SessionRecord = {
      id: randomBytes(8).toString('hex'),
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
    this.emit('session:started', session);
    return session;
  }

  /**
   * End a session.
   */
  endSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || !session.isActive) return false;

    session.endTime = new Date();
    session.isActive = false;
    this.emit('session:ended', session);
    return true;
  }

  /**
   * Get active sessions for a user.
   */
  getActiveSessions(userId: string): SessionRecord[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.userId === userId && s.isActive
    );
  }

  /**
   * Get session history for a host.
   */
  getHostSessions(hostId: string, limit: number = 50): SessionRecord[] {
    return Array.from(this.sessions.values())
      .filter((s) => s.hostId === hostId)
      .sort((a, b) => b.startTime.getTime() - a.startTime.getTime())
      .slice(0, limit);
  }

  /**
   * Generate user invite token.
   */
  generateInviteToken(email: string, accessLevel: AccessLevel = 'limited'): string {
    const payload = `${email}:${accessLevel}:${Date.now()}`;
    const token = createHash('sha256').update(payload).digest('hex');
    return token.slice(0, 32);
  }

  /**
   * Accept an invite token.
   */
  acceptInvite(
    token: string,
    username: string,
    publicKey: string
  ): BastionUser | null {
    // In production, validate token against stored invites
    // For now, create user directly
    return this.registerUser(username, publicKey, 'limited');
  }

  /**
   * List all users.
   */
  listUsers(): BastionUser[] {
    return Array.from(this.users.values());
  }

  /**
   * List all hosts.
   */
  listHosts(): BastionHost[] {
    return Array.from(this.hosts.values());
  }

  /**
   * Get statistics.
   */
  getStats(): {
    totalUsers: number;
    activeUsers: number;
    totalHosts: number;
    activeHosts: number;
    activeSessions: number;
    totalSessions: number;
  } {
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
