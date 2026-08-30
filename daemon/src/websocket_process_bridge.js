/**
 * WebSocket Process Bridge — Wrap CLI programs as WebSocket servers.
 *
 * Inspired by websocketd.
 * Maps WebSocket connections to process STDIN/STDOUT,
 * allowing any CLI program to be accessed via WebSocket.
 */

import { spawn, ChildProcess } from 'child_process';
import { WebSocketServer, WebSocket } from 'ws';
import { createHash, randomBytes } from 'crypto';
import { EventEmitter } from 'events';

// ============================================================================
// Types
// ============================================================================

export interface ProcessBridgeConfig {
  command: string;
  args: string[];
  port: number;
  host: string;
  maxConnections: number;
  allowAnyOrigin: boolean;
  origin?: string;
}

export interface ProcessBridge {
  id: string;
  config: ProcessBridgeConfig;
  wss: WebSocketServer;
  status: 'listening' | 'stopped';
  connections: Map<string, ProcessConnection>;
  createdAt: Date;
}

export interface ProcessConnection {
  id: string;
  process: ChildProcess;
  ws: WebSocket;
  messageCount: number;
  connectedAt: Date;
}

// ============================================================================
// WebSocket Process Bridge Manager
// ============================================================================

export class WebSocketProcessBridgeManager extends EventEmitter {
  private bridges: Map<string, ProcessBridge> = new Map();

  /**
   * Create a new process bridge.
   */
  createBridge(config: Partial<ProcessBridgeConfig> = {}): ProcessBridge {
    const id = randomBytes(8).toString('hex');

    const bridgeConfig: ProcessBridgeConfig = {
      command: config.command || '/bin/sh',
      args: config.args || [],
      port: config.port || 8080,
      host: config.host || '0.0.0.0',
      maxConnections: config.maxConnections || 10,
      allowAnyOrigin: config.allowAnyOrigin ?? true,
      origin: config.origin,
    };

    const wss = new WebSocketServer({
      port: bridgeConfig.port,
      host: bridgeConfig.host,
    });

    const bridge: ProcessBridge = {
      id,
      config: bridgeConfig,
      wss,
      status: 'listening',
      connections: new Map(),
      createdAt: new Date(),
    };

    wss.on('connection', (ws, req) => {
      this.handleConnection(bridge, ws, req);
    });

    wss.on('error', (err) => {
      this.emit('bridge:error', { bridgeId: id, error: err.message });
    });

    this.bridges.set(id, bridge);
    this.emit('bridge:created', bridge);
    return bridge;
  }

  /**
   * Handle a new WebSocket connection.
   */
  private handleConnection(
    bridge: ProcessBridge,
    ws: WebSocket,
    req: any
  ): void {
    const connId = randomBytes(8).toString('hex');

    // Check connection limit
    if (bridge.connections.size >= bridge.config.maxConnections) {
      ws.close(1013, 'Too many connections');
      return;
    }

    // Check origin
    if (!bridge.config.allowAnyOrigin) {
      const origin = req.headers.origin;
      if (bridge.config.origin && origin !== bridge.config.origin) {
        ws.close(1008, 'Origin not allowed');
        return;
      }
    }

    // Spawn process
    const proc = spawn(bridge.config.command, bridge.config.args, {
      stdio: ['pipe', 'pipe', 'pipe'],
      env: process.env,
    });

    const connection: ProcessConnection = {
      id: connId,
      process: proc,
      ws,
      messageCount: 0,
      connectedAt: new Date(),
    };

    bridge.connections.set(connId, connection);

    // Pipe WebSocket to process STDIN
    ws.on('message', (data: Buffer | string) => {
      const msg = typeof data === 'string' ? data : data.toString();
      proc.stdin?.write(msg + '\n');
      connection.messageCount++;
    });

    // Pipe process STDOUT to WebSocket
    proc.stdout?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter((l) => l);
      for (const line of lines) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(line);
        }
      }
    });

    // Pipe process STDERR to WebSocket (as error messages)
    proc.stderr?.on('data', (data: Buffer) => {
      const lines = data.toString().split('\n').filter((l) => l);
      for (const line of lines) {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ error: line }));
        }
      }
    });

    // Handle process exit
    proc.on('close', (code) => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.close(1000, `Process exited with code ${code}`);
      }
      bridge.connections.delete(connId);
      this.emit('connection:process-exited', { bridgeId: bridge.id, connId, code });
    });

    // Handle WebSocket close
    ws.on('close', () => {
      proc.kill('SIGTERM');
      bridge.connections.delete(connId);
      this.emit('connection:closed', { bridgeId: bridge.id, connId });
    });

    ws.on('error', () => {
      proc.kill('SIGTERM');
      bridge.connections.delete(connId);
    });

    this.emit('connection:opened', { bridgeId: bridge.id, connId });
  }

  /**
   * Stop a bridge.
   */
  stopBridge(bridgeId: string): boolean {
    const bridge = this.bridges.get(bridgeId);
    if (!bridge) return false;

    // Close all connections
    for (const [connId, conn] of bridge.connections) {
      conn.process.kill('SIGTERM');
      conn.ws.close(1001, 'Bridge shutting down');
    }

    bridge.wss.close();
    bridge.status = 'stopped';
    bridge.connections.clear();
    this.bridges.delete(bridgeId);
    this.emit('bridge:stopped', bridge);
    return true;
  }

  /**
   * Get all bridges.
   */
  getBridges(): ProcessBridge[] {
    return Array.from(this.bridges.values());
  }

  /**
   * Get bridge by ID.
   */
  getBridge(bridgeId: string): ProcessBridge | undefined {
    return this.bridges.get(bridgeId);
  }

  /**
   * Get statistics.
   */
  getStats(): {
    totalBridges: number;
    activeBridges: number;
    totalConnections: number;
  } {
    const bridges = Array.from(this.bridges.values());
    const totalConnections = bridges.reduce((sum, b) => sum + b.connections.size, 0);

    return {
      totalBridges: bridges.length,
      activeBridges: bridges.filter((b) => b.status === 'listening').length,
      totalConnections,
    };
  }
}
