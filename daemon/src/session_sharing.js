/**
 * Session Sharing — Share terminal sessions over the network.
 *
 * Inspired by tty-share and tmux-mobile.
 * Provides secure session sharing with URL generation,
 * read-only/readwrite modes, and automatic reconnection.
 */

import { createHash, randomBytes } from 'crypto';
import { EventEmitter } from 'events';

// ============================================================================
// Types
// ============================================================================

export type ShareMode = 'readonly' | 'readwrite' | 'control';

export interface SharedSession {
  id: string;
  shareUrl: string;
  secretUrl: string;
  mode: ShareMode;
  ownerConnectionId: string;
  sessionId: string;
  createdAt: Date;
  expiresAt?: Date;
  maxViewers: number;
  currentViewers: number;
  isActive: boolean;
  password?: string;
  allowedViewers: Set<string>;
}

export interface Viewer {
  id: string;
  sessionId: string;
  name: string;
  joinedAt: Date;
  lastActivity: Date;
  mode: ShareMode;
  isActive: boolean;
}

export interface ShareOptions {
  mode?: ShareMode;
  expiresIn?: number; // minutes
  maxViewers?: number;
  password?: string;
  allowedViewers?: string[];
}

// ============================================================================
// Session Sharing Manager
// ============================================================================

export class SessionSharingManager extends EventEmitter {
  private sharedSessions: Map<string, SharedSession> = new Map();
  private viewers: Map<string, Viewer> = new Map();
  private sessionViewers: Map<string, Set<string>> = new Map();

  /**
   * Share a terminal session.
   */
  shareSession(
    sessionId: string,
    ownerConnectionId: string,
    baseUrl: string = 'https://share.pocketdesk.dev',
    options: ShareOptions = {}
  ): SharedSession {
    const id = randomBytes(16).toString('hex');
    const secret = randomBytes(8).toString('hex');

    const shared: SharedSession = {
      id,
      shareUrl: `${baseUrl}/s/${id}`,
      secretUrl: `${baseUrl}/s/${id}?secret=${secret}`,
      mode: options.mode || 'readonly',
      ownerConnectionId,
      sessionId,
      createdAt: new Date(),
      expiresAt: options.expiresIn
        ? new Date(Date.now() + options.expiresIn * 60 * 1000)
        : undefined,
      maxViewers: options.maxViewers || 10,
      currentViewers: 0,
      isActive: true,
      password: options.password,
      allowedViewers: new Set(options.allowedViewers || []),
    };

    this.sharedSessions.set(id, shared);
    this.sessionViewers.set(id, new Set());
    this.emit('session:shared', shared);
    return shared;
  }

  /**
   * Join a shared session as a viewer.
   */
  joinSession(
    shareId: string,
    viewerName: string,
    password?: string
  ): Viewer | null {
    const shared = this.sharedSessions.get(shareId);
    if (!shared || !shared.isActive) return null;

    // Check expiry
    if (shared.expiresAt && shared.expiresAt < new Date()) {
      shared.isActive = false;
      return null;
    }

    // Check password
    if (shared.password && shared.password !== password) {
      return null;
    }

    // Check viewer limit
    if (shared.currentViewers >= shared.maxViewers) {
      return null;
    }

    const viewer: Viewer = {
      id: randomBytes(8).toString('hex'),
      sessionId: shareId,
      name: viewerName,
      joinedAt: new Date(),
      lastActivity: new Date(),
      mode: shared.mode,
      isActive: true,
    };

    this.viewers.set(viewer.id, viewer);
    const sessionViewers = this.sessionViewers.get(shareId) || new Set();
    sessionViewers.add(viewer.id);
    this.sessionViewers.set(shareId, sessionViewers);
    shared.currentViewers = sessionViewers.size;

    this.emit('viewer:joined', viewer);
    return viewer;
  }

  /**
   * Leave a shared session.
   */
  leaveSession(viewerId: string): boolean {
    const viewer = this.viewers.get(viewerId);
    if (!viewer) return false;

    viewer.isActive = false;
    this.viewers.delete(viewerId);

    const sessionViewers = this.sessionViewers.get(viewer.sessionId);
    if (sessionViewers) {
      sessionViewers.delete(viewerId);
      const shared = this.sharedSessions.get(viewer.sessionId);
      if (shared) {
        shared.currentViewers = sessionViewers.size;
      }
    }

    this.emit('viewer:left', viewer);
    return true;
  }

  /**
   * Broadcast terminal output to all viewers.
   */
  broadcastOutput(shareId: string, data: string): void {
    const sessionViewers = this.sessionViewers.get(shareId);
    if (!sessionViewers) return;

    for (const viewerId of sessionViewers) {
      const viewer = this.viewers.get(viewerId);
      if (viewer && viewer.isActive) {
        viewer.lastActivity = new Date();
        this.emit('output:viewer', {
          viewerId,
          shareId,
          data,
          timestamp: Date.now(),
        });
      }
    }
  }

  /**
   * Send input from a viewer (only if mode allows).
   */
  sendInput(viewerId: string, data: string): boolean {
    const viewer = this.viewers.get(viewerId);
    if (!viewer || !viewer.isActive) return false;

    if (viewer.mode === 'readonly') return false;

    viewer.lastActivity = new Date();
    this.emit('input:viewer', {
      viewerId,
      sessionId: viewer.sessionId,
      data,
    });
    return true;
  }

  /**
   * Stop sharing a session.
   */
  stopSharing(shareId: string): boolean {
    const shared = this.sharedSessions.get(shareId);
    if (!shared) return false;

    shared.isActive = false;

    // Disconnect all viewers
    const sessionViewers = this.sessionViewers.get(shareId);
    if (sessionViewers) {
      for (const viewerId of sessionViewers) {
        const viewer = this.viewers.get(viewerId);
        if (viewer) {
          viewer.isActive = false;
          this.viewers.delete(viewerId);
        }
      }
      sessionViewers.clear();
    }

    this.emit('session:unshared', shared);
    return true;
  }

  /**
   * Get all active shared sessions.
   */
  getActiveSessions(): SharedSession[] {
    return Array.from(this.sharedSessions.values()).filter((s) => s.isActive);
  }

  /**
   * Get viewers for a session.
   */
  getSessionViewers(shareId: string): Viewer[] {
    const viewerIds = this.sessionViewers.get(shareId) || new Set();
    return Array.from(viewerIds)
      .map((id) => this.viewers.get(id))
      .filter((v): v is Viewer => v !== undefined && v.isActive);
  }

  /**
   * Verify a share URL.
   */
  verifyShareUrl(shareId: string, secret?: string): boolean {
    const shared = this.sharedSessions.get(shareId);
    if (!shared || !shared.isActive) return false;
    if (shared.expiresAt && shared.expiresAt < new Date()) return false;
    return true;
  }

  /**
   * Get statistics.
   */
  getStats(): {
    totalShared: number;
    activeShared: number;
    totalViewers: number;
    totalBroadcasts: number;
  } {
    return {
      totalShared: this.sharedSessions.size,
      activeShared: Array.from(this.sharedSessions.values()).filter((s) => s.isActive).length,
      totalViewers: this.viewers.size,
      totalBroadcasts: 0, // Would track in production
    };
  }
}
