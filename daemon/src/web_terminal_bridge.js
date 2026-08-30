/**
 * Web Terminal Bridge — Turn CLI tools into web applications.
 *
 * Inspired by tty2web.
 * Provides bidirectional terminal-to-web conversion with file transfer,
 * API support, and reverse proxy capabilities.
 */

import { createHash, randomBytes } from 'crypto';
import { EventEmitter } from 'events';
import { readFileSync, writeFileSync, existsSync } from 'fs';

// ============================================================================
// Types
// ============================================================================

export type BridgeMode = 'bind' | 'reverse' | 'api';

export interface WebTerminalConfig {
  command: string;
  args: string[];
  mode: BridgeMode;
  port: number;
  host: string;
  title: string;
  readOnly: boolean;
  enableFileTransfer: boolean;
  enableApi: boolean;
  password?: string;
  certFile?: string;
  keyFile?: string;
}

export interface BridgeSession {
  id: string;
  config: WebTerminalConfig;
  status: 'starting' | 'running' | 'stopped' | 'error';
  pid?: number;
  startedAt: Date;
  lastActivity: Date;
  viewerCount: number;
  inputCount: number;
  outputCount: number;
}

export interface FileTransfer {
  id: string;
  sessionId: string;
  filename: string;
  direction: 'upload' | 'download';
  size: number;
  progress: number;
  status: 'pending' | 'transferring' | 'completed' | 'error';
  startedAt: Date;
  completedAt?: Date;
}

export interface ApiCommand {
  id: string;
  sessionId: string;
  command: string;
  args: string[];
  stdout: string;
  stderr: string;
  exitCode: number;
  startedAt: Date;
  completedAt: Date;
}

// ============================================================================
// Web Terminal Bridge Manager
// ============================================================================

export class WebTerminalBridgeManager extends EventEmitter {
  private sessions: Map<string, BridgeSession> = new Map();
  private transfers: Map<string, FileTransfer> = new Map();
  private apiCommands: Map<string, ApiCommand> = new Map();

  /**
   * Create a new web terminal bridge.
   */
  createBridge(config: Partial<WebTerminalConfig> = {}): BridgeSession {
    const session: BridgeSession = {
      id: randomBytes(16).toString('hex'),
      config: {
        command: config.command || '/bin/sh',
        args: config.args || [],
        mode: config.mode || 'bind',
        port: config.port || 8080,
        host: config.host || '0.0.0.0',
        title: config.title || 'Terminal',
        readOnly: config.readOnly ?? false,
        enableFileTransfer: config.enableFileTransfer ?? true,
        enableApi: config.enableApi ?? true,
        password: config.password,
        certFile: config.certFile,
        keyFile: config.keyFile,
      },
      status: 'starting',
      startedAt: new Date(),
      lastActivity: new Date(),
      viewerCount: 0,
      inputCount: 0,
      outputCount: 0,
    };

    this.sessions.set(session.id, session);

    // Simulate startup
    setTimeout(() => {
      session.status = 'running';
      this.emit('bridge:started', session);
    }, 100);

    return session;
  }

  /**
   * Stop a bridge session.
   */
  stopBridge(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    session.status = 'stopped';
    this.emit('bridge:stopped', session);
    return true;
  }

  /**
   * Process terminal output from a bridge.
   */
  processOutput(sessionId: string, data: string): void {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'running') return;

    session.outputCount++;
    session.lastActivity = new Date();

    this.emit('output:web', {
      sessionId,
      data,
      timestamp: Date.now(),
    });
  }

  /**
   * Send input to a bridge.
   */
  sendInput(sessionId: string, data: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || session.status !== 'running') return false;
    if (session.config.readOnly) return false;

    session.inputCount++;
    session.lastActivity = new Date();

    this.emit('input:web', {
      sessionId,
      data,
      timestamp: Date.now(),
    });
    return true;
  }

  /**
   * Upload a file to the bridge.
   */
  uploadFile(sessionId: string, filename: string, data: Buffer): FileTransfer | null {
    const session = this.sessions.get(sessionId);
    if (!session || !session.config.enableFileTransfer) return null;

    const transfer: FileTransfer = {
      id: randomBytes(8).toString('hex'),
      sessionId,
      filename,
      direction: 'upload',
      size: data.length,
      progress: 100,
      status: 'completed',
      startedAt: new Date(),
      completedAt: new Date(),
    };

    this.transfers.set(transfer.id, transfer);
    this.emit('file:uploaded', transfer);
    return transfer;
  }

  /**
   * Download a file from the bridge.
   */
  downloadFile(sessionId: string, filepath: string): FileTransfer | null {
    const session = this.sessions.get(sessionId);
    if (!session || !session.config.enableFileTransfer) return null;

    const transfer: FileTransfer = {
      id: randomBytes(8).toString('hex'),
      sessionId,
      filename: filepath.split('/').pop() || filepath,
      direction: 'download',
      size: 0,
      progress: 0,
      status: 'pending',
      startedAt: new Date(),
    };

    this.transfers.set(transfer.id, transfer);

    // Simulate download
    setTimeout(() => {
      transfer.progress = 100;
      transfer.status = 'completed';
      transfer.completedAt = new Date();
      this.emit('file:downloaded', transfer);
    }, 500);

    return transfer;
  }

  /**
   * Execute a command via API.
   */
  executeApiCommand(sessionId: string, command: string, args: string[] = []): ApiCommand | null {
    const session = this.sessions.get(sessionId);
    if (!session || !session.config.enableApi) return null;

    const apiCmd: ApiCommand = {
      id: randomBytes(8).toString('hex'),
      sessionId,
      command,
      args,
      stdout: '',
      stderr: '',
      exitCode: 0,
      startedAt: new Date(),
      completedAt: new Date(),
    };

    this.apiCommands.set(apiCmd.id, apiCmd);

    // Simulate execution
    this.emit('api:command', apiCmd);

    return apiCmd;
  }

  /**
   * Get all active bridges.
   */
  getActiveBridges(): BridgeSession[] {
    return Array.from(this.sessions.values()).filter((s) => s.status === 'running');
  }

  /**
   * Get transfers for a session.
   */
  getSessionTransfers(sessionId: string): FileTransfer[] {
    return Array.from(this.transfers.values()).filter((t) => t.sessionId === sessionId);
  }

  /**
   * Get API commands for a session.
   */
  getSessionApiCommands(sessionId: string): ApiCommand[] {
    return Array.from(this.apiCommands.values()).filter((c) => c.sessionId === sessionId);
  }

  /**
   * Get statistics.
   */
  getStats(): {
    totalBridges: number;
    activeBridges: number;
    totalTransfers: number;
    totalApiCommands: number;
  } {
    return {
      totalBridges: this.sessions.size,
      activeBridges: Array.from(this.sessions.values()).filter((s) => s.status === 'running').length,
      totalTransfers: this.transfers.size,
      totalApiCommands: this.apiCommands.size,
    };
  }
}
