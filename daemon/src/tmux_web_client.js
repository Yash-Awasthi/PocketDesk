/**
 * tmux Web Client — Browser-based tmux session access.
 *
 * Inspired by webtmux and wetty.
 * Provides visual pane layout, touch-friendly controls,
 * and automatic scroll-to-copy-mode for mobile.
 */

import { createHash, randomBytes } from 'crypto';
import { EventEmitter } from 'events';

// ============================================================================
// Types
// ============================================================================

export type TmuxSessionState = 'attached' | 'detached' | 'dead';

export interface TmuxWindow {
  id: number;
  name: string;
  isActive: boolean;
  panes: TmuxPane[];
}

export interface TmuxPane {
  id: number;
  windowId: number;
  isCurrent: boolean;
  width: number;
  height: number;
  command: string;
  output: string[];
  scrollPosition: number;
}

export interface TmuxSession {
  id: string;
  name: string;
  state: TmuxSessionState;
  windows: TmuxWindow[];
  currentWindowId: number;
  createdAt: Date;
  lastActivity: Date;
}

export interface PaneLayout {
  sessionName: string;
  windowId: number;
  panes: { id: number; x: number; y: number; width: number; height: number }[];
}

// ============================================================================
// tmux Web Client Manager
// ============================================================================

export class TmuxWebClientManager extends EventEmitter {
  private sessions: Map<string, TmuxSession> = new Map();
  private scrollBuffers: Map<string, string[]> = new Map();

  /**
   * Create or attach to a tmux session.
   */
  createSession(name: string = 'main'): TmuxSession {
    let session = Array.from(this.sessions.values()).find((s) => s.name === name);

    if (session) {
      session.state = 'attached';
      session.lastActivity = new Date();
      return session;
    }

    session = {
      id: randomBytes(8).toString('hex'),
      name,
      state: 'attached',
      windows: [{
        id: 0,
        name: '0:shell',
        isActive: true,
        panes: [{
          id: 0,
          windowId: 0,
          isCurrent: true,
          width: 80,
          height: 24,
          command: '/bin/sh',
          output: [],
          scrollPosition: 0,
        }],
      }],
      currentWindowId: 0,
      createdAt: new Date(),
      lastActivity: new Date(),
    };

    this.sessions.set(session.id, session);
    this.scrollBuffers.set(session.id, []);
    this.emit('session:created', session);
    return session;
  }

  /**
   * Process terminal output for a pane.
   */
  processOutput(sessionId: string, windowId: number, paneId: number, data: string): void {
    const session = this.sessions.get(sessionId);
    if (!session) return;

    const window = session.windows.find((w) => w.id === windowId);
    if (!window) return;

    const pane = window.panes.find((p) => p.id === paneId);
    if (!pane) return;

    pane.output.push(data);
    if (pane.output.length > 10000) {
      pane.output.shift();
    }

    // Also add to scroll buffer
    const buffer = this.scrollBuffers.get(sessionId) || [];
    buffer.push(data);
    if (buffer.length > 10000) {
      buffer.shift();
    }
    this.scrollBuffers.set(sessionId, buffer);

    session.lastActivity = new Date();

    this.emit('output:pane', {
      sessionId,
      windowId,
      paneId,
      data,
      timestamp: Date.now(),
    });
  }

  /**
   * Send input to a pane.
   */
  sendInput(sessionId: string, windowId: number, paneId: number, data: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.state !== 'attached') return false;

    const window = session.windows.find((w) => w.id === windowId);
    if (!window) return false;

    const pane = window.panes.find((p) => p.id === paneId);
    if (!pane) return false;

    session.lastActivity = new Date();

    this.emit('input:pane', {
      sessionId,
      windowId,
      paneId,
      data,
    });
    return true;
  }

  /**
   * Split a pane.
   */
  splitPane(sessionId: string, windowId: number, direction: 'horizontal' | 'vertical' = 'horizontal'): TmuxPane | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const window = session.windows.find((w) => w.id === windowId);
    if (!window) return null;

    const newPaneId = Math.max(...window.panes.map((p) => p.id)) + 1;
    const newPane: TmuxPane = {
      id: newPaneId,
      windowId,
      isCurrent: false,
      width: direction === 'horizontal' ? Math.floor(80 / 2) : 80,
      height: direction === 'vertical' ? Math.floor(24 / 2) : 24,
      command: '/bin/sh',
      output: [],
      scrollPosition: 0,
    };

    window.panes.push(newPane);
    this.emit('pane:split', { sessionId, windowId, paneId: newPaneId, direction });
    return newPane;
  }

  /**
   * Switch to a different pane.
   */
  switchPane(sessionId: string, windowId: number, paneId: number): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const window = session.windows.find((w) => w.id === windowId);
    if (!window) return false;

    for (const pane of window.panes) {
      pane.isCurrent = pane.id === paneId;
    }

    this.emit('pane:switched', { sessionId, windowId, paneId });
    return true;
  }

  /**
   * Get pane layout for visual display.
   */
  getPaneLayout(sessionId: string, windowId: number): PaneLayout | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    const window = session.windows.find((w) => w.id === windowId);
    if (!window) return null;

    const panes = window.panes.map((pane, index) => {
      const isHorizontal = pane.width < 80;
      return {
        id: pane.id,
        x: isHorizontal ? (index % 2) * pane.width : 0,
        y: isHorizontal ? 0 : index * pane.height,
        width: pane.width,
        height: pane.height,
      };
    });

    return { sessionName: session.name, windowId, panes };
  }

  /**
   * Enter copy mode (scrollback).
   */
  enterCopyMode(sessionId: string, windowId: number, paneId: number): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const window = session.windows.find((w) => w.id === windowId);
    if (!window) return false;

    const pane = window.panes.find((p) => p.id === paneId);
    if (!pane) return false;

    this.emit('pane:copy-mode', { sessionId, windowId, paneId });
    return true;
  }

  /**
   * Scroll in copy mode.
   */
  scroll(sessionId: string, windowId: number, paneId: number, lines: number): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    const window = session.windows.find((w) => w.id === windowId);
    if (!window) return false;

    const pane = window.panes.find((p) => p.id === paneId);
    if (!pane) return false;

    pane.scrollPosition = Math.max(0, pane.scrollPosition + lines);
    this.emit('pane:scrolled', { sessionId, windowId, paneId, position: pane.scrollPosition });
    return true;
  }

  /**
   * Get all sessions.
   */
  listSessions(): TmuxSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Detach from a session.
   */
  detachSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.state = 'detached';
    this.emit('session:detached', session);
    return true;
  }

  /**
   * Get statistics.
   */
  getStats(): {
    totalSessions: number;
    attachedSessions: number;
    totalWindows: number;
    totalPanes: number;
  } {
    const sessions = Array.from(this.sessions.values());
    const totalWindows = sessions.reduce((sum, s) => sum + s.windows.length, 0);
    const totalPanes = sessions.reduce(
      (sum, s) => sum + s.windows.reduce((ws, w) => ws + w.panes.length, 0),
      0
    );

    return {
      totalSessions: sessions.length,
      attachedSessions: sessions.filter((s) => s.state === 'attached').length,
      totalWindows,
      totalPanes,
    };
  }
}
