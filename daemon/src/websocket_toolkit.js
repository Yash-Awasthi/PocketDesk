/**
 * WebSocket Toolkit — Netcat/curl/socat for WebSockets.
 *
 * Inspired by websocat.
 * Provides WebSocket utility functions for testing, debugging,
 * and bridging connections.
 */

import { WebSocket, WebSocketServer } from 'ws';
import { createHash, randomBytes } from 'crypto';
import { EventEmitter } from 'events';

// ============================================================================
// Types
// ============================================================================

export interface WsConnection {
  id: string;
  url: string;
  protocol: string;
  status: 'connecting' | 'open' | 'closing' | 'closed';
  connectedAt: Date;
  lastMessageAt: Date;
  messageCount: number;
  bytesReceived: number;
  bytesSent: number;
}

export interface WsMessage {
  connectionId: string;
  data: string | Buffer;
  isBinary: boolean;
  timestamp: number;
}

export interface WsServerInstance {
  id: string;
  port: number;
  path: string;
  status: 'listening' | 'stopped';
  clientCount: number;
  createdAt: Date;
}

// ============================================================================
// WebSocket Toolkit
// ============================================================================

export class WebSocketToolkit extends EventEmitter {
  private connections: Map<string, WsConnection> = new Map();
  private servers: Map<string, WsServerInstance> = new Map();
  private sockets: Map<string, WebSocket> = new Map();
  private serverInstances: Map<string, WebSocketServer> = new Map();

  /**
   * Connect to a WebSocket server.
   */
  connect(url: string, protocols?: string[]): WsConnection {
    const id = randomBytes(8).toString('hex');

    const connection: WsConnection = {
      id,
      url,
      protocol: protocols?.[0] || 'ws',
      status: 'connecting',
      connectedAt: new Date(),
      lastMessageAt: new Date(),
      messageCount: 0,
      bytesReceived: 0,
      bytesSent: 0,
    };

    this.connections.set(id, connection);

    try {
      const ws = new WebSocket(url, protocols);
      this.sockets.set(id, ws);

      ws.on('open', () => {
        connection.status = 'open';
        this.emit('connection:open', connection);
      });

      ws.on('message', (data: Buffer | string, isBinary: boolean) => {
        connection.messageCount++;
        connection.bytesReceived += typeof data === 'string' ? Buffer.byteLength(data) : data.length;
        connection.lastMessageAt = new Date();

        const msg: WsMessage = {
          connectionId: id,
          data,
          isBinary,
          timestamp: Date.now(),
        };

        this.emit('message:received', msg);
      });

      ws.on('close', () => {
        connection.status = 'closed';
        this.sockets.delete(id);
        this.emit('connection:closed', connection);
      });

      ws.on('error', (err) => {
        connection.status = 'closed';
        this.emit('connection:error', { connectionId: id, error: err.message });
      });
    } catch (err) {
      connection.status = 'closed';
    }

    return connection;
  }

  /**
   * Send a message to a connection.
   */
  send(connectionId: string, data: string | Buffer): boolean {
    const ws = this.sockets.get(connectionId);
    const connection = this.connections.get(connectionId);
    if (!ws || !connection || connection.status !== 'open') return false;

    ws.send(data);
    connection.bytesSent += typeof data === 'string' ? Buffer.byteLength(data) : data.length;
    connection.lastMessageAt = new Date();
    return true;
  }

  /**
   * Close a connection.
   */
  close(connectionId: string, code = 1000, reason = 'client close'): boolean {
    const ws = this.sockets.get(connectionId);
    if (!ws) return false;

    ws.close(code, reason);
    return true;
  }

  /**
   * Start a WebSocket server.
   */
  startServer(port: number, path: string = '/'): WsServerInstance {
    const id = randomBytes(8).toString('hex');

    const wss = new WebSocketServer({ port, path });
    this.serverInstances.set(id, wss);

    const instance: WsServerInstance = {
      id,
      port,
      path,
      status: 'listening',
      clientCount: 0,
      createdAt: new Date(),
    };

    this.servers.set(id, instance);

    wss.on('connection', (ws, req) => {
      instance.clientCount++;
      const clientId = randomBytes(8).toString('hex');

      this.emit('server:client-connected', {
        serverId: id,
        clientId,
        ip: req.socket.remoteAddress,
      });

      ws.on('message', (data) => {
        this.emit('server:message', {
          serverId: id,
          clientId,
          data,
        });
      });

      ws.on('close', () => {
        instance.clientCount--;
        this.emit('server:client-disconnected', { serverId: id, clientId });
      });
    });

    this.emit('server:started', instance);
    return instance;
  }

  /**
   * Stop a WebSocket server.
   */
  stopServer(serverId: string): boolean {
    const wss = this.serverInstances.get(serverId);
    const instance = this.servers.get(serverId);
    if (!wss || !instance) return false;

    wss.close();
    instance.status = 'stopped';
    this.servers.delete(serverId);
    this.serverInstances.delete(serverId);
    this.emit('server:stopped', instance);
    return true;
  }

  /**
   * Broadcast a message to all clients of a server.
   */
  broadcast(serverId: string, data: string | Buffer): number {
    const wss = this.serverInstances.get(serverId);
    if (!wss) return 0;

    let count = 0;
    wss.clients.forEach((client) => {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
        count++;
      }
    });
    return count;
  }

  /**
   * Get all connections.
   */
  getConnections(): WsConnection[] {
    return Array.from(this.connections.values());
  }

  /**
   * Get all servers.
   */
  getServers(): WsServerInstance[] {
    return Array.from(this.servers.values());
  }

  /**
   * Get statistics.
   */
  getStats(): {
    totalConnections: number;
    activeConnections: number;
    totalServers: number;
    activeServers: number;
    totalMessages: number;
  } {
    const connections = Array.from(this.connections.values());
    return {
      totalConnections: connections.length,
      activeConnections: connections.filter((c) => c.status === 'open').length,
      totalServers: this.servers.size,
      activeServers: Array.from(this.servers.values()).filter((s) => s.status === 'listening').length,
      totalMessages: connections.reduce((sum, c) => sum + c.messageCount, 0),
    };
  }
}
