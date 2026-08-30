/**
 * Web Terminal — Browser-based terminal with tmux-style persistence.
 *
 * Inspired by terminal-web and ssh2.
 * Provides web-based terminal access with session persistence,
 * reconnection, and mobile-friendly UI.
 */

import { createHash, randomBytes } from 'crypto';
import { EventEmitter } from 'events';

// ============================================================================
// Types
// ============================================================================

export type TerminalStatus = 'active' | 'detached' | 'closed';

export interface WebTerminalSession {
  id: string;
  name: string;
  status: TerminalStatus;
  createdAt: Date;
  lastActivity: Date;
  cols: number;
  rows: number;
  scrollbackBuffer: string[];
  maxScrollback: number;
  environment: Record<string, string>;
  workingDirectory: string;
  pid?: number;
}

export interface TerminalTab {
  id: string;
  sessionId: string;
  title: string;
  isActive: boolean;
  createdAt: Date;
}

export interface MobileKeyBinding {
  id: string;
  label: string;
  keys: string;
  icon: string;
  category: 'function' | 'navigation' | 'control' | 'modifier';
}

// ============================================================================
// Web Terminal Manager
// ============================================================================

export class WebTerminalManager extends EventEmitter {
  private sessions: Map<string, WebTerminalSession> = new Map();
  private tabs: Map<string, TerminalTab> = new Map();
  private outputBuffers: Map<string, string[]> = new Map();

  private readonly mobileKeys: MobileKeyBinding[] = [
    // Function keys
    { id: 'f1', label: 'F1', keys: '\x1bOP', icon: 'F1', category: 'function' },
    { id: 'f2', label: 'F2', keys: '\x1bOQ', icon: 'F2', category: 'function' },
    { id: 'f3', label: 'F3', keys: '\x1bOR', icon: 'F3', category: 'function' },
    { id: 'f4', label: 'F4', keys: '\x1bOS', icon: 'F4', category: 'function' },
    { id: 'f5', label: 'F5', keys: '\x1b[15~', icon: 'F5', category: 'function' },
    { id: 'f6', label: 'F6', keys: '\x1b[17~', icon: 'F6', category: 'function' },
    { id: 'f7', label: 'F7', keys: '\x1b[18~', icon: 'F7', category: 'function' },
    { id: 'f8', label: 'F8', keys: '\x1b[19~', icon: 'F8', category: 'function' },
    { id: 'f9', label: 'F9', keys: '\x1b[20~', icon: 'F9', category: 'function' },
    { id: 'f10', label: 'F10', keys: '\x1b[21~', icon: 'F10', category: 'function' },
    { id: 'f11', label: 'F11', keys: '\x1b[23~', icon: 'F11', category: 'function' },
    { id: 'f12', label: 'F12', keys: '\x1b[24~', icon: 'F12', category: 'function' },

    // Navigation
    { id: 'up', label: 'Up', keys: '\x1b[A', icon: '↑', category: 'navigation' },
    { id: 'down', label: 'Down', keys: '\x1b[B', icon: '↓', category: 'navigation' },
    { id: 'left', label: 'Left', keys: '\x1b[D', icon: '←', category: 'navigation' },
    { id: 'right', label: 'Right', keys: '\x1b[C', icon: '→', category: 'navigation' },
    { id: 'home', label: 'Home', keys: '\x1b[H', icon: '⌂', category: 'navigation' },
    { id: 'end', label: 'End', keys: '\x1b[F', icon: '⤓', category: 'navigation' },
    { id: 'pageup', label: 'PgUp', keys: '\x1b[5~', icon: '⇞', category: 'navigation' },
    { id: 'pagedown', label: 'PgDn', keys: '\x1b[6~', icon: '⇟', category: 'navigation' },

    // Control
    { id: 'ctrl-c', label: 'Ctrl+C', keys: '\x03', icon: '⊘', category: 'control' },
    { id: 'ctrl-d', label: 'Ctrl+D', keys: '\x04', icon: '⏏', category: 'control' },
    { id: 'ctrl-z', label: 'Ctrl+Z', keys: '\x1a', icon: '⏸', category: 'control' },
    { id: 'ctrl-l', label: 'Ctrl+L', keys: '\x0c', icon: '⌧', category: 'control' },
    { id: 'tab', label: 'Tab', keys: '\t', icon: '⇥', category: 'control' },
    { id: 'escape', label: 'Esc', keys: '\x1b', icon: 'Esc', category: 'control' },
    { id: 'enter', label: 'Enter', keys: '\n', icon: '↵', category: 'control' },
    { id: 'backspace', label: 'Bksp', keys: '\x7f', icon: '⌫', category: 'control' },
  ];

  /**
   * Create a new terminal session.
   */
  createSession(
    name: string,
    cols = 80,
    rows = 24,
    environment: Record<string, string> = {}
  ): WebTerminalSession {
    const session: WebTerminalSession = {
      id: randomBytes(16).toString('hex'),
      name,
      status: 'active',
      createdAt: new Date(),
      lastActivity: new Date(),
      cols,
      rows,
      scrollbackBuffer: [],
      maxScrollback: 10000,
      environment: { ...environment, TERM: 'xterm-256color', LANG: 'en_US.UTF-8' },
      workingDirectory: process.env.HOME || '/tmp',
    };

    this.sessions.set(session.id, session);
    this.outputBuffers.set(session.id, []);

    // Create default tab
    this.createTab(session.id, name);

    this.emit('session:created', session);
    return session;
  }

  /**
   * Create a new tab in a session.
   */
  createTab(sessionId: string, title: string = 'Terminal'): TerminalTab | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const tab: TerminalTab = {
      id: randomBytes(8).toString('hex'),
      sessionId,
      title,
      isActive: true,
      createdAt: new Date(),
    };

    this.tabs.set(tab.id, tab);
    this.emit('tab:created', tab);
    return tab;
  }

  /**
   * Process terminal output.
   */
  processOutput(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'active') return;

    const buffer = this.outputBuffers.get(sessionId) || [];
    const lines = data.split('\n');
    buffer.push(...lines);

    // Trim buffer
    while (buffer.length > session.maxScrollback) {
      buffer.shift();
    }

    this.outputBuffers.set(sessionId, buffer);
    session.scrollbackBuffer = buffer;
    session.lastActivity = new Date();

    this.emit('output:stream', { sessionId, data, lines: lines.length });
  }

  /**
   * Send input to terminal.
   */
  sendInput(sessionId: string, data: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'active') return false;

    session.lastActivity = new Date();
    this.emit('input:received', { sessionId, data });
    return true;
  }

  /**
   * Execute a mobile key binding.
   */
  executeMobileKey(sessionId: string, keyId: string): boolean {
    const key = this.mobileKeys.find((k) => k.id === keyId);
    if (!key) return false;
    return this.sendInput(sessionId, key.keys);
  }

  /**
   * Get mobile key bindings.
   */
  getMobileKeys(): MobileKeyBinding[] {
    return [...this.mobileKeys];
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
   * Detach from session (tmux-style).
   */
  detachSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.status = 'detached';
    this.emit('session:detached', session);
    return true;
  }

  /**
   * Reattach to a detached session.
   */
  reattachSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'detached') return false;

    session.status = 'active';
    session.lastActivity = new Date();
    this.emit('session:reattached', session);
    return true;
  }

  /**
   * Close a session.
   */
  closeSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.status = 'closed';
    this.outputBuffers.delete(sessionId);
    this.emit('session:closed', session);
    return true;
  }

  /**
   * Get scrollback buffer.
   */
  getScrollback(sessionId: string, lines?: number): string[] {
    const buffer = this.outputBuffers.get(sessionId) || [];
    if (lines !== undefined) {
      return buffer.slice(-lines);
    }
    return [...buffer];
  }

  /**
   * Get all sessions.
   */
  listSessions(): WebTerminalSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get tabs for a session.
   */
  getSessionTabs(sessionId: string): TerminalTab[] {
    return Array.from(this.tabs.values()).filter((t) => t.sessionId === sessionId);
  }

  /**
   * Get statistics.
   */
  getStats(): {
    totalSessions: number;
    activeSessions: number;
    detachedSessions: number;
    totalTabs: number;
    totalOutputLines: number;
  } {
    const sessions = Array.from(this.sessions.values());
    const totalOutput = Array.from(this.outputBuffers.values()).reduce(
      (sum, buf) => sum + buf.length,
      0
    );

    return {
      totalSessions: sessions.length,
      activeSessions: sessions.filter((s) => s.status === 'active').length,
      detachedSessions: sessions.filter((s) => s.status === 'detached').length,
      totalTabs: this.tabs.size,
      totalOutputLines: totalOutput,
    };
  }
}
