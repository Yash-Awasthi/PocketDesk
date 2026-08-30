/**
 * Remote Control — Mobile device control for AI agent sessions.
 *
 * Inspired by remotecc (Remote Claude Code).
 * Provides QR code pairing, real-time terminal streaming,
 * quick actions, and auto-reconnect for mobile clients.
 */

import { createHash, randomBytes } from 'crypto';
import { EventEmitter } from 'events';

// ============================================================================
// Types
// ============================================================================

export type ConnectionState = 'disconnected' | 'scanning' | 'pairing' | 'connected' | 'reconnecting';

export interface RemoteSession {
  sessionId: string;
  deviceName: string;
  deviceType: 'ios' | 'android' | 'web';
  connectionState: ConnectionState;
  connectedAt?: Date;
  lastActivity?: Date;
  terminalOutput: string[];
  maxOutputLines: number;
}

export interface PairingPayload {
  sessionId: string;
  pairingCode: string;
  timestamp: number;
  expiresAt: number;
  serverUrl: string;
}

export interface QuickAction {
  id: string;
  label: string;
  keys: string;
  icon?: string;
  category: 'navigation' | 'control' | 'input' | 'custom';
}

export interface TerminalSnapshot {
  lines: string[];
  cursorRow: number;
  cursorCol: number;
  scrollback: number;
  timestamp: Date;
}

// ============================================================================
// Remote Control Manager
// ============================================================================

export class RemoteControlManager extends EventEmitter {
  private sessions: Map<string, RemoteSession> = new Map();
  private pairingCodes: Map<string, PairingPayload> = new Map();
  private outputBuffer: Map<string, string[]> = new Map();

  private quickActions: QuickAction[] = [
    { id: 'yes', label: 'Yes (y)', keys: 'y\n', icon: '✓', category: 'input' },
    { id: 'no', label: 'No (n)', keys: 'n\n', icon: '✗', category: 'input' },
    { id: 'ctrl-c', label: 'Ctrl+C', keys: '\x03', icon: '⊘', category: 'control' },
    { id: 'ctrl-d', label: 'Ctrl+D', keys: '\x04', icon: '⏏', category: 'control' },
    { id: 'tab', label: 'Tab', keys: '\t', icon: '⇥', category: 'navigation' },
    { id: 'enter', label: 'Enter', keys: '\n', icon: '↵', category: 'navigation' },
    { id: 'up', label: 'Up Arrow', keys: '\x1b[A', icon: '↑', category: 'navigation' },
    { id: 'down', label: 'Down Arrow', keys: '\x1b[B', icon: '↓', category: 'navigation' },
    { id: 'left', label: 'Left Arrow', keys: '\x1b[D', icon: '←', category: 'navigation' },
    { id: 'right', label: 'Right Arrow', keys: '\x1b[C', icon: '→', category: 'navigation' },
    { id: 'escape', label: 'Escape', keys: '\x1b', icon: 'Esc', category: 'control' },
    { id: 'home', label: 'Home', keys: '\x1b[H', icon: '⌂', category: 'navigation' },
    { id: 'end', label: 'End', keys: '\x1b[F', icon: '⤓', category: 'navigation' },
    { id: 'pageup', label: 'Page Up', keys: '\x1b[5~', icon: '⇞', category: 'navigation' },
    { id: 'pagedown', label: 'Page Down', keys: '\x1b[6~', icon: '⇟', category: 'navigation' },
  ];

  private maxOutputLines = 500;

  /**
   * Generate a pairing payload for QR code.
   */
  generatePairingPayload(serverUrl: string): PairingPayload {
    const sessionId = randomBytes(16).toString('hex');
    const pairingCode = randomBytes(4).toString('hex').toUpperCase();

    const payload: PairingPayload = {
      sessionId,
      pairingCode,
      timestamp: Date.now(),
      expiresAt: Date.now() + 5 * 60 * 1000, // 5 minutes
      serverUrl,
    };

    this.pairingCodes.set(sessionId, payload);
    return payload;
  }

  /**
   * Verify a pairing code.
   */
  verifyPairing(sessionId: string, pairingCode: string): boolean {
    const payload = this.pairingCodes.get(sessionId);
    if (!payload) return false;
    if (Date.now() > payload.expiresAt) {
      this.pairingCodes.delete(sessionId);
      return false;
    }
    return payload.pairingCode === pairingCode;
  }

  /**
   * Complete pairing and create a remote session.
   */
  completePairing(sessionId: string, deviceName: string, deviceType: 'ios' | 'android' | 'web'): RemoteSession {
    this.pairingCodes.delete(sessionId);

    const session: RemoteSession = {
      sessionId,
      deviceName,
      deviceType,
      connectionState: 'connected',
      connectedAt: new Date(),
      lastActivity: new Date(),
      terminalOutput: [],
      maxOutputLines: this.maxOutputLines,
    };

    this.sessions.set(sessionId, session);
    this.outputBuffer.set(sessionId, []);
    this.emit('session:connected', session);
    return session;
  }

  /**
   * Process terminal output and send to connected devices.
   */
  processTerminalOutput(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.connectionState !== 'connected') return;

    // Buffer output
    const buffer = this.outputBuffer.get(sessionId) || [];
    const lines = data.split('\n');
    buffer.push(...lines);

    // Trim to max lines
    while (buffer.length > session.maxOutputLines) {
      buffer.shift();
    }

    this.outputBuffer.set(sessionId, buffer);
    session.terminalOutput = buffer;
    session.lastActivity = new Date();

    this.emit('output:stream', { sessionId, data, lines: lines.length });
  }

  /**
   * Get terminal snapshot for a session.
   */
  getTerminalSnapshot(sessionId: string): TerminalSnapshot | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    return {
      lines: [...(this.outputBuffer.get(sessionId) || [])],
      cursorRow: 0,
      cursorCol: 0,
      scrollback: 0,
      timestamp: new Date(),
    };
  }

  /**
   * Send input from mobile device to terminal.
   */
  sendInput(sessionId: string, input: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.connectionState !== 'connected') return false;

    session.lastActivity = new Date();
    this.emit('input:received', { sessionId, input });
    return true;
  }

  /**
   * Execute a quick action.
   */
  executeQuickAction(sessionId: string, actionId: string): boolean {
    const action = this.quickActions.find((a) => a.id === actionId);
    if (!action) return false;
    return this.sendInput(sessionId, action.keys);
  }

  /**
   * Get available quick actions.
   */
  getQuickActions(): QuickAction[] {
    return [...this.quickActions];
  }

  /**
   * Register a custom quick action.
   */
  registerQuickAction(action: Omit<QuickAction, 'id'>): QuickAction {
    const newAction: QuickAction = {
      ...action,
      id: randomBytes(4).toString('hex'),
    };
    this.quickActions.push(newAction);
    return newAction;
  }

  /**
   * Handle disconnection.
   */
  handleDisconnect(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.connectionState = 'disconnected';
      this.emit('session:disconnected', session);
    }
  }

  /**
   * Attempt reconnection.
   */
  attemptReconnect(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.connectionState = 'reconnecting';
    this.emit('session:reconnecting', session);

    // In production, would attempt WebSocket reconnection
    return true;
  }

  /**
   * Reconnect successful.
   */
  reconnectSuccess(sessionId: string): void {
    const session = this.sessions.get(sessionId);
    if (session) {
      session.connectionState = 'connected';
      session.connectedAt = new Date();
      this.emit('session:reconnected', session);
    }
  }

  /**
   * Get all active sessions.
   */
  getActiveSessions(): RemoteSession[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.connectionState === 'connected'
    );
  }

  /**
   * Disconnect a session.
   */
  disconnectSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.connectionState = 'disconnected';
    this.outputBuffer.delete(sessionId);
    this.emit('session:disconnected', session);
    return true;
  }

  /**
   * Get statistics.
   */
  getStats(): {
    totalSessions: number;
    activeSessions: number;
    totalOutputLines: number;
    pendingPairings: number;
  } {
    const sessions = Array.from(this.sessions.values());
    const totalOutput = Array.from(this.outputBuffer.values()).reduce(
      (sum, buf) => sum + buf.length,
      0
    );

    return {
      totalSessions: sessions.length,
      activeSessions: sessions.filter((s) => s.connectionState === 'connected').length,
      totalOutputLines: totalOutput,
      pendingPairings: this.pairingCodes.size,
    };
  }
}
