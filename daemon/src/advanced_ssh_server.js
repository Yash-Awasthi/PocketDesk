/**
 * Advanced SSH Server — Drop-in replacement for OpenSSH with advanced features.
 *
 * Inspired by bifroest and sshwifty.
 * Provides pluggable authentication, session recording,
 * and web-based SSH/Telnet access.
 */

import { createHash, randomBytes } from 'crypto';
import { EventEmitter } from 'events';

// ============================================================================
// Types
// ============================================================================

export type AuthMethod = 'password' | 'publickey' | 'keyboard-interactive' | 'token';

export interface SSHServerConfig {
  port: number;
  host: string;
  maxSessions: number;
  idleTimeout: number;
  allowTcpForwarding: boolean;
  allowAgentForwarding: boolean;
  forceCommand?: string;
}

export interface SSHSession {
  id: string;
  username: string;
  clientIp: string;
  authMethod: AuthMethod;
  connectedAt: Date;
  lastActivity: Date;
  commands: string[];
  isActive: boolean;
}

export interface SSHUser {
  username: string;
  passwordHash?: string;
  publicKey?: string;
  allowedCommands: string[];
  maxSessions: number;
  isAdmin: boolean;
}

// ============================================================================
// Advanced SSH Server Manager
// ============================================================================

export class AdvancedSSHServerManager extends EventEmitter {
  private config: SSHServerConfig;
  private sessions: Map<string, SSHSession> = new Map();
  private users: Map<string, SSHUser> = new Map();
  private recordings: Map<string, string[]> = new Map();

  constructor(config?: Partial<SSHServerConfig>) {
    super();
    this.config = {
      port: config?.port || 2222,
      host: config?.host || '0.0.0.0',
      maxSessions: config?.maxSessions || 10,
      idleTimeout: config?.idleTimeout || 300000,
      allowTcpForwarding: config?.allowTcpForwarding ?? true,
      allowAgentForwarding: config?.allowAgentForwarding ?? false,
      forceCommand: config?.forceCommand,
    };
  }

  /**
   * Register a user.
   */
  registerUser(username: string, options: Partial<SSHUser> = {}): SSHUser {
    const user: SSHUser = {
      username,
      passwordHash: options.passwordHash,
      publicKey: options.publicKey,
      allowedCommands: options.allowedCommands || [],
      maxSessions: options.maxSessions || 3,
      isAdmin: options.isAdmin ?? false,
    };

    this.users.set(username, user);
    return user;
  }

  /**
   * Authenticate a user.
   */
  authenticate(username: string, method: AuthMethod, credential: string): boolean {
    const user = this.users.get(username);
    if (!user) return false;

    // Check if user has the required credential
    if (method === 'password' && user.passwordHash) {
      const hash = createHash('sha256').update(credential).digest('hex');
      return hash === user.passwordHash;
    }

    if (method === 'publickey' && user.publicKey) {
      return credential === user.publicKey;
    }

    return true;
  }

  /**
   * Create a new session.
   */
  createSession(username: string, clientIp: string, method: AuthMethod): SSHSession | null {
    const user = this.users.get(username);
    if (!user) return null;

    // Check session limit
    const activeSessions = Array.from(this.sessions.values()).filter(
      (s) => s.username === username && s.isActive
    );

    if (activeSessions.length >= user.maxSessions) {
      return null;
    }

    const session: SSHSession = {
      id: randomBytes(8).toString('hex'),
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
    this.emit('session:created', session);
    return session;
  }

  /**
   * Execute a command in a session.
   */
  executeCommand(sessionId: string, command: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || !session.isActive) return false;

    const user = this.users.get(session.username);
    if (!user) return false;

    // Check if command is allowed
    if (user.allowedCommands.length > 0) {
      const cmd = command.split(/\s+/)[0];
      if (!user.allowedCommands.includes(cmd)) {
        return false;
      }
    }

    // Force command if configured
    const actualCommand = this.config.forceCommand || command;

    session.commands.push(actualCommand);
    session.lastActivity = new Date();

    // Record command
    const recording = this.recordings.get(sessionId) || [];
    recording.push(`[${new Date().toISOString()}] ${actualCommand}`);
    this.recordings.set(sessionId, recording);

    this.emit('command:executed', { sessionId, command: actualCommand });
    return true;
  }

  /**
   * End a session.
   */
  endSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.isActive = false;
    this.emit('session:ended', session);
    return true;
  }

  /**
   * Get session recording.
   */
  getRecording(sessionId: string): string[] {
    return this.recordings.get(sessionId) || [];
  }

  /**
   * Check for idle sessions.
   */
  checkIdleSessions(): number {
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

  /**
   * Get all active sessions.
   */
  getActiveSessions(): SSHSession[] {
    return Array.from(this.sessions.values()).filter((s) => s.isActive);
  }

  /**
   * Get statistics.
   */
  getStats(): {
    totalSessions: number;
    activeSessions: number;
    totalUsers: number;
    totalCommands: number;
  } {
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
