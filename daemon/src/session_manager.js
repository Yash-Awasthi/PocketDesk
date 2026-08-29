/**
 * Session Manager
 * Extracted from sshx's session management patterns
 * Features: multiplexed sessions, state synchronization, graceful shutdown
 */

class SessionManager {
  constructor(options = {}) {
    this.sessions = new Map();
    this.maxSessions = options.maxSessions || 100;
    this.sessionTimeout = options.sessionTimeout || 3600000; // 1 hour
    this.cleanupInterval = options.cleanupInterval || 60000; // 1 minute
    
    // Start cleanup timer
    this.cleanupTimer = setInterval(() => this.cleanupOldSessions(), this.cleanupInterval);
  }

  /**
   * Create a new session with multiplexed state
   * Inspired by sshx's session architecture
   */
  createSession(sessionId, options = {}) {
    if (this.sessions.size >= this.maxSessions) {
      throw new Error('Max sessions reached');
    }

    const session = {
      id: sessionId,
      createdAt: Date.now(),
      lastAccessedAt: Date.now(),
      state: {
        terminal: {
          buffer: [],
          history: [],
          cursor: { x: 0, y: 0 },
          size: { cols: options.cols || 80, rows: options.rows || 24 }
        },
        users: new Map(),
        cursors: new Map(),
        canvas: { zoom: 1, offsetX: 0, offsetY: 0 },
        metadata: options.metadata || {}
      },
      listeners: new Map(),
      closed: false
    };

    this.sessions.set(sessionId, session);
    this.emit(sessionId, 'session:created', { sessionId });
    
    return session;
  }

  /**
   * Get session by ID with access tracking
   */
  getSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    
    session.lastAccessedAt = Date.now();
    return session;
  }

  /**
   * Update session state atomically
   * Inspired by sshx's state synchronization
   */
  updateState(sessionId, path, value) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error('Session not found');
    
    // Navigate to the path and set value
    const parts = path.split('.');
    let current = session.state;
    
    for (let i = 0; i < parts.length - 1; i++) {
      if (!current[parts[i]]) {
        current[parts[i]] = {};
      }
      current = current[parts[i]];
    }
    
    const oldValue = current[parts[parts.length - 1]];
    current[parts[parts.length - 1]] = value;
    
    this.emit(sessionId, 'state:updated', { path, oldValue, newValue: value });
    
    return { path, oldValue, newValue: value };
  }

  /**
   * Add user to session
   */
  addUser(sessionId, userId, userData = {}) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error('Session not found');
    
    session.state.users.set(userId, {
      ...userData,
      joinedAt: Date.now(),
      lastActive: Date.now()
    });
    
    this.emit(sessionId, 'user:joined', { userId, userData });
    
    return session.state.users.get(userId);
  }

  /**
   * Remove user from session
   */
  removeUser(sessionId, userId) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error('Session not found');
    
    const user = session.state.users.get(userId);
    session.state.users.delete(userId);
    session.state.cursors.delete(userId);
    
    this.emit(sessionId, 'user:left', { userId, user });
    
    return user;
  }

  /**
   * Update cursor position for a user
   */
  updateCursor(sessionId, userId, position) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error('Session not found');
    
    session.state.cursors.set(userId, {
      ...position,
      timestamp: Date.now()
    });
    
    this.emit(sessionId, 'cursor:updated', { userId, position });
  }

  /**
   * Write to terminal buffer
   */
  writeToTerminal(sessionId, data) {
    const session = this.getSession(sessionId);
    if (!session) throw new Error('Session not found');
    
    session.state.terminal.buffer.push({
      ...data,
      timestamp: Date.now()
    });
    
    // Keep buffer size manageable
    if (session.state.terminal.buffer.length > 10000) {
      session.state.terminal.buffer = session.state.terminal.buffer.slice(-5000);
    }
    
    this.emit(sessionId, 'terminal:output', data);
  }

  /**
   * Event listener system
   */
  on(sessionId, event, callback) {
    if (!this.listeners) this.listeners = new Map();
    
    const key = `${sessionId}:${event}`;
    if (!this.listeners.has(key)) {
      this.listeners.set(key, new Set());
    }
    
    this.listeners.get(key).add(callback);
    
    // Return unsubscribe function
    return () => {
      this.listeners.get(key)?.delete(callback);
    };
  }

  /**
   * Emit event to listeners
   */
  emit(sessionId, event, data) {
    if (!this.listeners) return;
    
    const key = `${sessionId}:${event}`;
    const listeners = this.listeners.get(key);
    
    if (listeners) {
      for (const callback of listeners) {
        try {
          callback(data);
        } catch (error) {
          console.error(`Error in session event listener: ${error.message}`);
        }
      }
    }
  }

  /**
   * Close session gracefully
   * Inspired by sshx's graceful shutdown
   */
  closeSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return false;
    
    session.closed = true;
    this.emit(sessionId, 'session:closed', { sessionId });
    
    // Clean up listeners
    if (this.listeners) {
      for (const key of this.listeners.keys()) {
        if (key.startsWith(sessionId)) {
          this.listeners.delete(key);
        }
      }
    }
    
    this.sessions.delete(sessionId);
    
    return true;
  }

  /**
   * Cleanup old sessions
   */
  cleanupOldSessions() {
    const now = Date.now();
    
    for (const [sessionId, session] of this.sessions) {
      if (now - session.lastAccessedAt > this.sessionTimeout) {
        console.log(`[SessionManager] Cleaning up expired session: ${sessionId}`);
        this.closeSession(sessionId);
      }
    }
  }

  /**
   * Get session statistics
   */
  getStats() {
    return {
      totalSessions: this.sessions.size,
      maxSessions: this.maxSessions,
      activeSessions: Array.from(this.sessions.values()).filter(s => !s.closed).length,
      oldestSession: this.sessions.size > 0 
        ? Math.min(...Array.from(this.sessions.values()).map(s => s.createdAt))
        : null
    };
  }

  /**
   * Graceful shutdown
   */
  shutdown() {
    clearInterval(this.cleanupTimer);
    
    // Close all sessions
    for (const sessionId of this.sessions.keys()) {
      this.closeSession(sessionId);
    }
    
    console.log('[SessionManager] Shutdown complete');
  }
}

module.exports = SessionManager;