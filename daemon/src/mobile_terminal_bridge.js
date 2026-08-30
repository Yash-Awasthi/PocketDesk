/**
 * Mobile Terminal Bridge — Connect to tmux sessions from mobile devices.
 *
 * Inspired by termote and tmux-mobile-vokako.
 * Provides WebSocket-based terminal access optimized for mobile,
 * with file browsing and agent chat integration.
 */

import { createHash, randomBytes } from 'crypto';
import { EventEmitter } from 'events';

// ============================================================================
// Types
// ============================================================================

export type ConnectionProtocol = 'websocket' | 'webrtc' | 'polling';

export interface MobileConnection {
  id: string;
  deviceName: string;
  deviceType: 'ios' | 'android' | 'web' | 'desktop';
  protocol: ConnectionProtocol;
  isConnected: boolean;
  connectedAt: Date;
  lastPing: Date;
  latencyMs: number;
  sessionId: string;
}

export interface TmuxSession {
  name: string;
  windows: number;
  attached: boolean;
  createdAt: Date;
  lastActivity: Date;
}

export interface FileEntry {
  name: string;
  path: string;
  isDirectory: boolean;
  size: number;
  modifiedAt: Date;
  permissions: string;
}

export interface AgentMessage {
  id: string;
  role: 'user' | 'assistant' | 'system';
  content: string;
  timestamp: Date;
  sessionId: string;
}

// ============================================================================
// Mobile Terminal Bridge
// ============================================================================

export class MobileTerminalBridge extends EventEmitter {
  private connections: Map<string, MobileConnection> = new Map();
  private sessions: Map<string, TmuxSession> = new Map();
  private fileCache: Map<string, FileEntry[]> = new Map();
  private chatHistory: Map<string, AgentMessage[]> = new Map();
  private pingInterval: NodeJS.Timeout | null = null;

  constructor() {
    super();
    this.startPingLoop();
  }

  /**
   * Register a mobile connection.
   */
  registerConnection(
    deviceName: string,
    deviceType: 'ios' | 'android' | 'web' | 'desktop',
    protocol: ConnectionProtocol = 'websocket'
  ): MobileConnection {
    const connection: MobileConnection = {
      id: randomBytes(16).toString('hex'),
      deviceName,
      deviceType,
      protocol,
      isConnected: true,
      connectedAt: new Date(),
      lastPing: new Date(),
      latencyMs: 0,
      sessionId: '',
    };

    this.connections.set(connection.id, connection);
    this.emit('connection:registered', connection);
    return connection;
  }

  /**
   * Connect to a tmux session.
   */
  connectToSession(connectionId: string, sessionName: string): boolean {
    const connection = this.connections.get(connectionId);
    if (!connection) return false;

    connection.sessionId = sessionName;
    connection.isConnected = true;
    connection.connectedAt = new Date();

    // Register tmux session if not exists
    if (!this.sessions.has(sessionName)) {
      this.sessions.set(sessionName, {
        name: sessionName,
        windows: 1,
        attached: true,
        createdAt: new Date(),
        lastActivity: new Date(),
      });
    }

    this.emit('session:connected', { connectionId, sessionName });
    return true;
  }

  /**
   * Process terminal output for mobile display.
   */
  processOutput(sessionName: string, data: string): void {
    const session = this.sessions.get(sessionName);
    if (session) {
      session.lastActivity = new Date();
    }

    // Find connected devices for this session
    for (const connection of this.connections.values()) {
      if (connection.sessionId === sessionName && connection.isConnected) {
        this.emit('output:mobile', {
          connectionId: connection.id,
          sessionName,
          data,
          timestamp: Date.now(),
        });
      }
    }
  }

  /**
   * Send input from mobile device.
   */
  sendInput(connectionId: string, data: string): boolean {
    const connection = this.connections.get(connectionId);
    if (!connection || !connection.isConnected) return false;

    this.emit('input:mobile', {
      connectionId,
      sessionId: connection.sessionId,
      data,
    });
    return true;
  }

  /**
   * Send a command to tmux.
   */
  sendTmuxCommand(connectionId: string, command: string): boolean {
    return this.sendInput(connectionId, `\x01${command}`);
  }

  /**
   * List available tmux sessions.
   */
  listSessions(): TmuxSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Browse files in session directory.
   */
  browseFiles(sessionName: string, path: string = '.'): FileEntry[] {
    const cacheKey = `${sessionName}:${path}`;
    const cached = this.fileCache.get(cacheKey);
    if (cached) return cached;

    // In production, would read actual files via tmux
    // For now, return mock data
    const files: FileEntry[] = [
      { name: '..', path: '..', isDirectory: true, size: 0, modifiedAt: new Date(), permissions: 'drwxr-xr-x' },
      { name: 'src', path: 'src', isDirectory: true, size: 0, modifiedAt: new Date(), permissions: 'drwxr-xr-x' },
      { name: 'package.json', path: 'package.json', isDirectory: false, size: 1234, modifiedAt: new Date(), permissions: '-rw-r--r--' },
      { name: 'README.md', path: 'README.md', isDirectory: false, size: 5678, modifiedAt: new Date(), permissions: '-rw-r--r--' },
    ];

    this.fileCache.set(cacheKey, files);
    return files;
  }

  /**
   * Send a chat message to an AI agent.
   */
  sendChatMessage(sessionName: string, role: 'user' | 'assistant' | 'system', content: string): AgentMessage {
    const messages = this.chatHistory.get(sessionName) || [];

    const message: AgentMessage = {
      id: randomBytes(8).toString('hex'),
      role,
      content,
      timestamp: new Date(),
      sessionId: sessionName,
    };

    messages.push(message);
    this.chatHistory.set(sessionName, messages);
    this.emit('chat:message', message);
    return message;
  }

  /**
   * Get chat history for a session.
   */
  getChatHistory(sessionName: string, limit: number = 50): AgentMessage[] {
    const messages = this.chatHistory.get(sessionName) || [];
    return messages.slice(-limit);
  }

  /**
   * Ping a connection to check latency.
   */
  ping(connectionId: string): number {
    const connection = this.connections.get(connectionId);
    if (!connection) return -1;

    const start = Date.now();
    connection.lastPing = new Date();
    connection.latencyMs = Date.now() - start;
    return connection.latencyMs;
  }

  /**
   * Start periodic ping loop.
   */
  private startPingLoop(): void {
    this.pingInterval = setInterval(() => {
      for (const connection of this.connections.values()) {
        if (connection.isConnected) {
          this.ping(connection.id);
        }
      }
    }, 30000); // Every 30 seconds
  }

  /**
   * Disconnect a mobile connection.
   */
  disconnect(connectionId: string): boolean {
    const connection = this.connections.get(connectionId);
    if (!connection) return false;

    connection.isConnected = false;
    this.emit('connection:disconnected', connection);
    return true;
  }

  /**
   * Get all connections.
   */
  getConnections(): MobileConnection[] {
    return Array.from(this.connections.values());
  }

  /**
   * Get active connections for a session.
   */
  getSessionConnections(sessionName: string): MobileConnection[] {
    return Array.from(this.connections.values()).filter(
      (c) => c.sessionId === sessionName && c.isConnected
    );
  }

  /**
   * Get statistics.
   */
  getStats(): {
    totalConnections: number;
    activeConnections: number;
    totalSessions: number;
    totalMessages: number;
  } {
    const connections = Array.from(this.connections.values());
    const totalMessages = Array.from(this.chatHistory.values()).reduce(
      (sum, msgs) => sum + msgs.length,
      0
    );

    return {
      totalConnections: connections.length,
      activeConnections: connections.filter((c) => c.isConnected).length,
      totalSessions: this.sessions.size,
      totalMessages,
    };
  }

  /**
   * Clean up resources.
   */
  destroy(): void {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
    }
  }
}
