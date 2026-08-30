/**
 * FastAPI Terminal — Python-style terminal server with authentication.
 *
 * Inspired by webterm (Python/FastAPI backend).
 * Provides authenticated terminal access with token-based auth,
 * session management, and multi-user support.
 */

import { spawn, ChildProcess } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { EventEmitter } from 'events';

// ============================================================================
// Types
// ============================================================================

export interface AuthToken {
  token: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
  permissions: ('terminal' | 'files' | 'admin')[];
}

export interface TerminalSession {
  id: string;
  userId: string;
  process: ChildProcess | null;
  status: 'active' | 'idle' | 'closed';
  cols: number;
  rows: number;
  output: string[];
  maxOutput: number;
  createdAt: Date;
  lastActivity: Date;
}

export interface UserProfile {
  id: string;
  username: string;
  passwordHash: string;
  salt: string;
  permissions: ('terminal' | 'files' | 'admin')[];
  createdAt: Date;
  lastLogin?: Date;
  isActive: boolean;
}

// ============================================================================
// FastAPI Terminal Manager
// ============================================================================

export class FastApiTerminalManager extends EventEmitter {
  private users: Map<string, UserProfile> = new Map();
  private tokens: Map<string, AuthToken> = new Map();
  private sessions: Map<string, TerminalSession> = new Map();

  /**
   * Register a new user.
   */
  registerUser(
    username: string,
    password: string,
    permissions: ('terminal' | 'files' | 'admin')[] = ['terminal']
  ): UserProfile {
    const salt = randomBytes(16).toString('hex');
    const passwordHash = this.hashPassword(password, salt);

    const user: UserProfile = {
      id: randomBytes(8).toString('hex'),
      username,
      passwordHash,
      salt,
      permissions,
      createdAt: new Date(),
      isActive: true,
    };

    this.users.set(user.id, user);
    return user;
  }

  /**
   * Authenticate and get a token.
   */
  login(username: string, password: string): AuthToken | null {
    const user = Array.from(this.users.values()).find(
      (u) => u.username === username && u.isActive
    );

    if (!user) return null;

    const hash = this.hashPassword(password, user.salt);
    if (hash !== user.passwordHash) return null;

    const token: AuthToken = {
      token: randomBytes(32).toString('hex'),
      userId: user.id,
      createdAt: new Date(),
      expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000), // 24 hours
      permissions: user.permissions,
    };

    this.tokens.set(token.token, token);
    user.lastLogin = new Date();
    return token;
  }

  /**
   * Validate a token.
   */
  validateToken(tokenStr: string): AuthToken | null {
    const token = this.tokens.get(tokenStr);
    if (!token) return null;
    if (new Date() > token.expiresAt) {
      this.tokens.delete(tokenStr);
      return null;
    }
    return token;
  }

  /**
   * Create a terminal session.
   */
  createSession(
    tokenStr: string,
    cols: number = 80,
    rows: number = 24
  ): TerminalSession | null {
    const token = this.validateToken(tokenStr);
    if (!token || !token.permissions.includes('terminal')) return null;

    const session: TerminalSession = {
      id: randomBytes(16).toString('hex'),
      userId: token.userId,
      process: null,
      status: 'active',
      cols,
      rows,
      output: [],
      maxOutput: 10000,
      createdAt: new Date(),
      lastActivity: new Date(),
    };

    this.sessions.set(session.id, session);
    this.emit('session:created', session);
    return session;
  }

  /**
   * Execute a command in a session.
   */
  executeCommand(sessionId: string, command: string): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'active') {
      return Promise.resolve({ stdout: '', stderr: 'Session not active', exitCode: -1 });
    }

    session.lastActivity = new Date();

    return new Promise((resolve) => {
      const parts = command.split(/\s+/);
      const proc = spawn(parts[0], parts.slice(1), {
        stdio: ['pipe', 'pipe', 'pipe'],
        env: process.env,
      });

      session.process = proc;
      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data: Buffer) => {
        stdout += data.toString();
      });

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      const timeout = setTimeout(() => {
        proc.kill('SIGTERM');
      }, 30000);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        session.process = null;
        session.output.push(stdout);
        while (session.output.join('').length > session.maxOutput) {
          session.output.shift();
        }
        this.emit('command:completed', { sessionId, command, exitCode: code });
        resolve({ stdout, stderr, exitCode: code });
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        session.process = null;
        resolve({ stdout, stderr: err.message, exitCode: -1 });
      });
    });
  }

  /**
   * Get session output.
   */
  getOutput(sessionId: string): string[] {
    const session = this.sessions.get(sessionId);
    return session ? [...session.output] : [];
  }

  /**
   * Close a session.
   */
  closeSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    if (session.process) {
      session.process.kill('SIGTERM');
    }

    session.status = 'closed';
    this.sessions.delete(sessionId);
    this.emit('session:closed', session);
    return true;
  }

  /**
   * Hash a password with salt.
   */
  private hashPassword(password: string, salt: string): string {
    return createHash('sha256').update(`${salt}:${password}`).digest('hex');
  }

  /**
   * Get user by token.
   */
  getUserFromToken(tokenStr: string): UserProfile | null {
    const token = this.validateToken(tokenStr);
    if (!token) return null;
    return this.users.get(token.userId) || null;
  }

  /**
   * Get statistics.
   */
  getStats(): {
    totalUsers: number;
    activeTokens: number;
    activeSessions: number;
  } {
    return {
      totalUsers: this.users.size,
      activeTokens: this.tokens.size,
      activeSessions: this.sessions.size,
    };
  }
}
