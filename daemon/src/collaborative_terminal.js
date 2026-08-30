/**
 * Collaborative Terminal — Web-based collaborative terminal sessions.
 *
 * Inspired by sshx and stevesapp.
 * Provides browser-based terminal access with multi-user collaboration,
 * cursor sharing, and real-time synchronization.
 */

import { createHash, randomBytes } from 'crypto';
import { EventEmitter } from 'events';

// ============================================================================
// Types
// ============================================================================

export type TerminalState = 'active' | 'idle' | 'disconnected' | 'archived';

export interface TerminalSession {
  id: string;
  name: string;
  owner: string;
  state: TerminalState;
  createdAt: Date;
  lastActivity: Date;
  cols: number;
  rows: number;
  scrollbackBuffer: string[];
  maxScrollback: number;
}

export interface Collaborator {
  id: string;
  sessionId: string;
  name: string;
  color: string;
  cursorRow: number;
  cursorCol: number;
  isActive: boolean;
  connectedAt: Date;
  lastSeen: Date;
  permissions: 'readonly' | 'readwrite' | 'admin';
}

export interface TerminalOutput {
  sessionId: string;
  data: string;
  timestamp: number;
  sequence: number;
}

export interface CursorPosition {
  collaboratorId: string;
  row: number;
  col: number;
  sessionId: string;
}

// ============================================================================
// Collaborative Terminal Manager
// ============================================================================

export class CollaborativeTerminal extends EventEmitter {
  private sessions: Map<string, TerminalSession> = new Map();
  private collaborators: Map<string, Collaborator> = new Map();
  private outputBuffers: Map<string, TerminalOutput[]> = new Map();
  private sequenceCounters: Map<string, number> = new Map();

  // Colors for collaborators
  private readonly COLORS = [
    '#FF6B6B', '#4ECDC4', '#45B7D1', '#96CEB4',
    '#FFEAA7', '#DDA0DD', '#98D8C8', '#F7DC6F',
    '#BB8FCE', '#85C1E9', '#F1948A', '#82E0AA',
  ];

  private colorIndex = 0;

  /**
   * Create a new collaborative terminal session.
   */
  createSession(name: string, owner: string, cols = 80, rows = 24): TerminalSession {
    const session: TerminalSession = {
      id: randomBytes(16).toString('hex'),
      name,
      owner,
      state: 'active',
      createdAt: new Date(),
      lastActivity: new Date(),
      cols,
      rows,
      scrollbackBuffer: [],
      maxScrollback: 10000,
    };

    this.sessions.set(session.id, session);
    this.outputBuffers.set(session.id, []);
    this.sequenceCounters.set(session.id, 0);
    this.emit('session:created', session);
    return session;
  }

  /**
   * Join a session as a collaborator.
   */
  joinSession(
    sessionId: string,
    name: string,
    permissions: 'readonly' | 'readwrite' | 'admin' = 'readwrite'
  ): Collaborator | null {
    const session = this.sessions.get(sessionId);
    if (!session || session.state !== 'active') return null;

    const collaborator: Collaborator = {
      id: randomBytes(8).toString('hex'),
      sessionId,
      name,
      color: this.nextColor(),
      cursorRow: 0,
      cursorCol: 0,
      isActive: true,
      connectedAt: new Date(),
      lastSeen: new Date(),
      permissions,
    };

    this.collaborators.set(collaborator.id, collaborator);
    this.emit('collaborator:joined', collaborator);
    return collaborator;
  }

  /**
   * Leave a session.
   */
  leaveSession(collaboratorId: string): boolean {
    const collaborator = this.collaborators.get(collaboratorId);
    if (!collaborator) return false;

    collaborator.isActive = false;
    this.collaborators.delete(collaboratorId);
    this.emit('collaborator:left', collaborator);
    return true;
  }

  /**
   * Process terminal output and broadcast to collaborators.
   */
  processOutput(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const buffer = this.outputBuffers.get(sessionId) || [];
    const sequence = (this.sequenceCounters.get(sessionId) || 0) + 1;
    this.sequenceCounters.set(sessionId, sequence);

    const output: TerminalOutput = {
      sessionId,
      data,
      timestamp: Date.now(),
      sequence,
    };

    buffer.push(output);

    // Trim scrollback
    while (buffer.length > session.maxScrollback) {
      buffer.shift();
    }

    this.outputBuffers.set(sessionId, buffer);
    session.scrollbackBuffer.push(data);
    while (session.scrollbackBuffer.length > session.maxScrollback) {
      session.scrollbackBuffer.shift();
    }

    session.lastActivity = new Date();
    this.emit('output:broadcast', output);
  }

  /**
   * Send input from a collaborator.
   */
  sendInput(collaboratorId: string, data: string): boolean {
    const collaborator = this.collaborators.get(collaboratorId);
    if (!collaborator || collaborator.permissions === 'readonly') return false;

    collaborator.lastSeen = new Date();
    this.emit('input:received', { collaboratorId, sessionId: collaborator.sessionId, data });
    return true;
  }

  /**
   * Update cursor position.
   */
  updateCursor(collaboratorId: string, row: number, col: number): void {
    const collaborator = this.collaborators.get(collaboratorId);
    if (!collaborator) return;

    collaborator.cursorRow = row;
    collaborator.cursorCol = col;
    collaborator.lastSeen = new Date();

    const position: CursorPosition = {
      collaboratorId,
      row,
      col,
      sessionId: collaborator.sessionId,
    };

    this.emit('cursor:moved', position);
  }

  /**
   * Get scrollback buffer for a session.
   */
  getScrollback(sessionId: string, fromSequence?: number): TerminalOutput[] {
    const buffer = this.outputBuffers.get(sessionId) || [];
    if (fromSequence !== undefined) {
      return buffer.filter((o) => o.sequence > fromSequence);
    }
    return [...buffer];
  }

  /**
   * Get active collaborators for a session.
   */
  getCollaborators(sessionId: string): Collaborator[] {
    return Array.from(this.collaborators.values()).filter(
      (c) => c.sessionId === sessionId && c.isActive
    );
  }

  /**
   * Resize terminal.
   */
  resize(sessionId: string, cols: number, rows: number): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.cols = cols;
    session.rows = rows;
    this.emit('terminal:resized', { sessionId, cols, rows });
    return true;
  }

  /**
   * Archive a session.
   */
  archiveSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.state = 'archived';
    this.emit('session:archived', session);
    return true;
  }

  /**
   * Get all sessions.
   */
  listSessions(): TerminalSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get session info.
   */
  getSession(sessionId: string): TerminalSession | undefined {
    return this.sessions.get(sessionId);
  }

  /**
   * Get next color for collaborator.
   */
  private nextColor(): string {
    const color = this.COLORS[this.colorIndex % this.COLORS.length];
    this.colorIndex++;
    return color;
  }

  /**
   * Get statistics.
   */
  getStats(): {
    totalSessions: number;
    activeSessions: number;
    totalCollaborators: number;
    totalOutputLines: number;
  } {
    const sessions = Array.from(this.sessions.values());
    const totalOutput = Array.from(this.outputBuffers.values()).reduce(
      (sum, buf) => sum + buf.length,
      0
    );

    return {
      totalSessions: sessions.length,
      activeSessions: sessions.filter((s) => s.state === 'active').length,
      totalCollaborators: this.collaborators.size,
      totalOutputLines: totalOutput,
    };
  }
}
