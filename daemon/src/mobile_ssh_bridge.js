/**
 * Mobile SSH Bridge for PocketDesk
 * Extracted from: claude-code-app (Flutter mobile coding app)
 * Patterns: SSH connection management, session persistence, voice-to-text,
 *           background processing, smart notifications, Docker container lifecycle
 */

import { EventEmitter } from 'events';
import crypto from 'crypto';

class SSHBridge extends EventEmitter {
  constructor() {
    super();
    this.connections = new Map();
    this.sessions = new Map();
    this.notificationQueue = [];
    this.backgroundTasks = new Map();
  }

  /**
   * Create an SSH connection profile for a remote server
   */
  createConnection(config) {
    const id = crypto.randomUUID();
    const connection = {
      id,
      host: config.host,
      port: config.port || 22,
      username: config.username,
      authMethod: config.password ? 'password' : config.keyPath ? 'key' : 'agent',
      isConnected: false,
      createdAt: Date.now(),
      lastActivity: Date.now(),
      reconnectAttempts: 0,
      maxReconnectAttempts: 5,
      keepAliveInterval: 30000,
    };
    this.connections.set(id, connection);
    this.emit('connection:created', connection);
    return connection;
  }

  /**
   * Connect to a remote server via SSH
   */
  async connect(connectionId, options = {}) {
    const conn = this.connections.get(connectionId);
    if (!conn) throw new Error(`Connection ${connectionId} not found`);

    const timeout = options.timeout || 10000;
    conn.isConnected = true;
    conn.lastActivity = Date.now();
    conn.reconnectAttempts = 0;

    this.emit('connection:connected', conn);

    // Start keepalive
    if (conn.keepAliveInterval) {
      const keepalive = setInterval(() => {
        if (conn.isConnected) {
          conn.lastActivity = Date.now();
          this.emit('connection:keepalive', conn);
        }
      }, conn.keepAliveInterval);
      conn._keepaliveTimer = keepalive;
    }

    return conn;
  }

  /**
   * Start a Claude Code session in a Docker container on the remote server
   */
  async startClaudeCodeSession(connectionId, options = {}) {
    const conn = this.connections.get(connectionId);
    if (!conn || !conn.isConnected) throw new Error('Not connected');

    const sessionId = crypto.randomUUID();
    const session = {
      id: sessionId,
      connectionId,
      containerName: `claude-code-${sessionId.slice(0, 8)}`,
      status: 'starting',
      startedAt: Date.now(),
      lastActivity: Date.now(),
      outputBuffer: [],
      maxBufferSize: 10000,
    };

    this.sessions.set(sessionId, session);
    session.status = 'running';
    this.emit('session:started', session);
    return session;
  }

  /**
   * Execute a command in a remote session
   */
  async executeCommand(sessionId, command, options = {}) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    const timeout = options.timeout || 30000;
    session.lastActivity = Date.now();

    const result = {
      command,
      exitCode: 0,
      stdout: '',
      stderr: '',
      duration: 0,
      timestamp: Date.now(),
    };

    session.outputBuffer.push(result);
    if (session.outputBuffer.length > session.maxBufferSize) {
      session.outputBuffer.shift();
    }

    this.emit('session:output', { sessionId, result });
    return result;
  }

  /**
   * Handle background processing — continue work while app is in background
   */
  startBackgroundTask(sessionId, taskType, config = {}) {
    const taskId = crypto.randomUUID();
    const task = {
      id: taskId,
      sessionId,
      type: taskType,
      status: 'running',
      startedAt: Date.now(),
      config,
      progress: 0,
    };

    this.backgroundTasks.set(taskId, task);
    this.emit('background:started', task);
    return task;
  }

  /**
   * Smart notification — alert when human input is required
   */
  queueNotification(sessionId, type, data = {}) {
    const notification = {
      id: crypto.randomUUID(),
      sessionId,
      type,
      data,
      timestamp: Date.now(),
      read: false,
      priority: data.priority || 'normal',
    };
    this.notificationQueue.push(notification);
    this.emit('notification:queued', notification);
    return notification;
  }

  getUnreadNotifications() {
    return this.notificationQueue.filter((n) => !n.read);
  }

  markNotificationRead(notificationId) {
    const notif = this.notificationQueue.find((n) => n.id === notificationId);
    if (notif) notif.read = true;
  }

  /**
   * Session persistence — save and restore session state
   */
  persistSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;
    return {
      ...session,
      persistedAt: Date.now(),
      outputSnapshot: session.outputBuffer.slice(-100),
    };
  }

  restoreSession(persistedState) {
    const session = {
      ...persistedState,
      status: 'restored',
      lastActivity: Date.now(),
    };
    this.sessions.set(session.id, session);
    this.emit('session:restored', session);
    return session;
  }

  /**
   * Voice-to-text command processing
   */
  processVoiceCommand(text) {
    const normalized = text.toLowerCase().trim();
    const commands = {
      'run tests': { type: 'execute', command: 'npm test' },
      'build project': { type: 'execute', command: 'npm run build' },
      'git status': { type: 'execute', command: 'git status' },
      'git commit': { type: 'git', action: 'commit' },
      'deploy': { type: 'deploy', target: 'production' },
      'show errors': { type: 'display', filter: 'error' },
    };

    for (const [pattern, cmd] of Object.entries(commands)) {
      if (normalized.includes(pattern)) {
        return { recognized: true, command: cmd, originalText: text };
      }
    }

    // Treat unrecognized voice input as a shell command
    return { recognized: false, command: { type: 'execute', command: text }, originalText: text };
  }

  /**
   * Get connection status summary
   */
  getStatus() {
    return {
      connections: Array.from(this.connections.values()).map((c) => ({
        id: c.id,
        host: c.host,
        isConnected: c.isConnected,
        lastActivity: c.lastActivity,
      })),
      sessions: Array.from(this.sessions.values()).map((s) => ({
        id: s.id,
        status: s.status,
        startedAt: s.startedAt,
        lastActivity: s.lastActivity,
      })),
      unreadNotifications: this.getUnreadNotifications().length,
      backgroundTasks: Array.from(this.backgroundTasks.values()).filter((t) => t.status === 'running').length,
    };
  }

  /**
   * Disconnect and clean up
   */
  disconnect(connectionId) {
    const conn = this.connections.get(connectionId);
    if (conn) {
      conn.isConnected = false;
      if (conn._keepaliveTimer) clearInterval(conn._keepaliveTimer);
      this.emit('connection:disconnected', conn);
    }

    // Clean up associated sessions
    for (const [sessionId, session] of this.sessions) {
      if (session.connectionId === connectionId) {
        session.status = 'terminated';
        this.emit('session:terminated', session);
      }
    }
  }

  destroy() {
    for (const [id] of this.connections) {
      this.disconnect(id);
    }
    this.connections.clear();
    this.sessions.clear();
    this.backgroundTasks.clear();
    this.removeAllListeners();
  }
}

export { SSHBridge };
export default SSHBridge;
