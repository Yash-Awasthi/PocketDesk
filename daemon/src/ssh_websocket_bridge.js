/**
 * SSH WebSocket Bridge — SSH to WebSocket bridge.
 *
 * Inspired by wssh.
 * Terminates SSH at the bridge level and wraps PTY output
 * in JSON for WebSocket delivery to web clients.
 */

import { createHash, randomBytes } from 'crypto';
import { EventEmitter } from 'events';

// ============================================================================
// Types
// ============================================================================

export interface BridgeConfig {
  sshHost: string;
  sshPort: number;
  sshUser: string;
  sshPassword?: string;
  sshKeyPath?: string;
  wsPort: number;
  wsHost: string;
  maxConnections: number;
  idleTimeout: number;
}

export interface SSHConnection {
  id: string;
  host: string;
  port: number;
  user: string;
  status: 'connecting' | 'connected' | 'disconnected' | 'error';
  connectedAt?: Date;
  lastActivity: Date;
  wsClientId: string;
}

export interface PTYMessage {
  type: 'output' | 'input' | 'resize' | 'error' | 'exit';
  data: string | Buffer;
  timestamp: number;
  exitCode?: number;
}

// ============================================================================
// SSH WebSocket Bridge Manager
// ============================================================================

export class SSHWebSocketBridgeManager extends EventEmitter {
  private connections: Map<string, SSHConnection> = new Map();
  private config: BridgeConfig;

  constructor(config?: Partial<BridgeConfig>) {
    super();
    this.config = {
      sshHost: config?.sshHost || 'localhost',
      sshPort: config?.sshPort || 22,
      sshUser: config?.sshUser || 'root',
      sshPassword: config?.sshPassword,
      sshKeyPath: config?.sshKeyPath,
      wsPort: config?.wsPort || 8080,
      wsHost: config?.wsHost || '0.0.0.0',
      maxConnections: config?.maxConnections || 10,
      idleTimeout: config?.idleTimeout || 300000,
    };
  }

  /**
   * Create a new SSH connection via WebSocket.
   */
  createConnection(
    wsClientId: string,
    host?: string,
    port?: number,
    user?: string
  ): SSHConnection | null {
    // Check connection limit
    const activeCount = Array.from(this.connections.values()).filter(
      (c) => c.status === 'connected'
    ).length;

    if (activeCount >= this.config.maxConnections) {
      return null;
    }

    const connection: SSHConnection = {
      id: randomBytes(8).toString('hex'),
      host: host || this.config.sshHost,
      port: port || this.config.sshPort,
      user: user || this.config.sshUser,
      status: 'connecting',
      lastActivity: new Date(),
      wsClientId,
    };

    this.connections.set(connection.id, connection);

    // Simulate connection
    setTimeout(() => {
      connection.status = 'connected';
      connection.connectedAt = new Date();
      this.emit('ssh:connected', connection);
    }, 100);

    return connection;
  }

  /**
   * Process SSH output and send to WebSocket client.
   */
  processOutput(connectionId: string, data: string): void {
    const connection = this.connections.get(connectionId);
    if (!connection || connection.status !== 'connected') return;

    connection.lastActivity = new Date();

    const message: PTYMessage = {
      type: 'output',
      data,
      timestamp: Date.now(),
    };

    this.emit('ssh:output', {
      connectionId,
      wsClientId: connection.wsClientId,
      message,
    });
  }

  /**
   * Send input from WebSocket to SSH.
   */
  sendInput(connectionId: string, data: string): boolean {
    const connection = this.connections.get(connectionId);
    if (!connection || connection.status !== 'connected') return false;

    connection.lastActivity = new Date();

    const message: PTYMessage = {
      type: 'input',
      data,
      timestamp: Date.now(),
    };

    this.emit('ssh:input', {
      connectionId,
      message,
    });
    return true;
  }

  /**
   * Resize the SSH PTY.
   */
  resize(connectionId: string, cols: number, rows: number): boolean {
    const connection = this.connections.get(connectionId);
    if (!connection || connection.status !== 'connected') return false;

    const message: PTYMessage = {
      type: 'resize',
      data: `${cols}x${rows}`,
      timestamp: Date.now(),
    };

    this.emit('ssh:resize', {
      connectionId,
      cols,
      rows,
    });
    return true;
  }

  /**
   * Disconnect an SSH connection.
   */
  disconnect(connectionId: string): boolean {
    const connection = this.connections.get(connectionId);
    if (!connection) return false;

    connection.status = 'disconnected';
    this.emit('ssh:disconnected', connection);
    this.connections.delete(connectionId);
    return true;
  }

  /**
   * Check for idle connections and disconnect them.
   */
  checkIdleConnections(): number {
    let disconnected = 0;
    const now = Date.now();

    for (const [id, connection] of this.connections) {
      if (connection.status === 'connected') {
        const idleTime = now - connection.lastActivity.getTime();
        if (idleTime > this.config.idleTimeout) {
          this.disconnect(id);
          disconnected++;
        }
      }
    }

    return disconnected;
  }

  /**
   * Get all connections.
   */
  getConnections(): SSHConnection[] {
    return Array.from(this.connections.values());
  }

  /**
   * Get connection by ID.
   */
  getConnection(connectionId: string): SSHConnection | undefined {
    return this.connections.get(connectionId);
  }

  /**
   * Get statistics.
   */
  getStats(): {
    totalConnections: number;
    activeConnections: number;
    config: BridgeConfig;
  } {
    return {
      totalConnections: this.connections.size,
      activeConnections: Array.from(this.connections.values()).filter(
        (c) => c.status === 'connected'
      ).length,
      config: this.config,
    };
  }
}
