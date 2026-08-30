/**
 * Lightweight Terminal — Simple command/response terminal server.
 *
 * Inspired by web-terminal and webrepl.
 * Provides lightweight terminal access without full TTY emulation,
 * suitable for simple command execution and REPL sessions.
 */

import { spawn, ChildProcess } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { EventEmitter } from 'events';

// ============================================================================
// Types
// ============================================================================

export interface TerminalConfig {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeout: number;
  maxOutputSize: number;
}

export interface TerminalSession {
  id: string;
  config: TerminalConfig;
  process: ChildProcess | null;
  status: 'idle' | 'running' | 'stopped' | 'error';
  output: string[];
  createdAt: Date;
  lastActivity: Date;
  commandHistory: string[];
}

export interface CommandResult {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  duration: number;
  timestamp: Date;
}

// ============================================================================
// Lightweight Terminal Manager
// ============================================================================

export class LightweightTerminalManager extends EventEmitter {
  private sessions: Map<string, TerminalSession> = new Map();
  private results: Map<string, CommandResult[]> = new Map();

  /**
   * Create a new terminal session.
   */
  createSession(config?: Partial<TerminalConfig>): TerminalSession {
    const session: TerminalSession = {
      id: randomBytes(16).toString('hex'),
      config: {
        command: config?.command || '/bin/sh',
        args: config?.args || [],
        cwd: config?.cwd || process.env.HOME || '/tmp',
        env: config?.env || {},
        timeout: config?.timeout || 30000,
        maxOutputSize: config?.maxOutputSize || 100000,
      },
      process: null,
      status: 'idle',
      output: [],
      createdAt: new Date(),
      lastActivity: new Date(),
      commandHistory: [],
    };

    this.sessions.set(session.id, session);
    this.results.set(session.id, []);
    this.emit('session:created', session);
    return session;
  }

  /**
   * Execute a command in a session.
   */
  async executeCommand(sessionId: string, command: string): Promise<CommandResult | null> {
    const session = this.sessions.get(sessionId);
    if (!session || session.status === 'running') return null;

    const startTime = Date.now();
    session.status = 'running';
    session.commandHistory.push(command);
    session.lastActivity = new Date();

    return new Promise((resolve) => {
      const parts = command.split(/\s+/);
      const cmd = parts[0];
      const args = parts.slice(1);

      const proc = spawn(cmd, args, {
        cwd: session.config.cwd,
        env: { ...process.env, ...session.config.env },
        stdio: ['pipe', 'pipe', 'pipe'],
      });

      session.process = proc;

      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        session.output.push(chunk);
        this.emit('output:stream', { sessionId, data: chunk });

        // Trim output
        while (session.output.join('').length > session.config.maxOutputSize) {
          session.output.shift();
        }
      });

      proc.stderr?.on('data', (data: Buffer) => {
        stderr += data.toString();
      });

      // Set timeout
      const timeout = setTimeout(() => {
        proc.kill('SIGTERM');
      }, session.config.timeout);

      proc.on('close', (code) => {
        clearTimeout(timeout);
        session.process = null;
        session.status = 'idle';
        session.lastActivity = new Date();

        const result: CommandResult = {
          command,
          stdout,
          stderr,
          exitCode: code,
          duration: Date.now() - startTime,
          timestamp: new Date(),
        };

        const sessionResults = this.results.get(sessionId) || [];
        sessionResults.push(result);
        this.results.set(sessionId, sessionResults);

        this.emit('command:completed', result);
        resolve(result);
      });

      proc.on('error', (err) => {
        clearTimeout(timeout);
        session.process = null;
        session.status = 'error';
        session.lastActivity = new Date();

        const result: CommandResult = {
          command,
          stdout,
          stderr: err.message,
          exitCode: -1,
          duration: Date.now() - startTime,
          timestamp: new Date(),
        };

        const sessionResults = this.results.get(sessionId) || [];
        sessionResults.push(result);
        this.results.set(sessionId, sessionResults);

        this.emit('command:error', result);
        resolve(result);
      });
    });
  }

  /**
   * Send input to a running process.
   */
  sendInput(sessionId: string, data: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || !session.process || session.status !== 'running') return false;

    session.process.stdin?.write(data);
    session.lastActivity = new Date();
    return true;
  }

  /**
   * Stop a running command.
   */
  stopCommand(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session || !session.process) return false;

    session.process.kill('SIGTERM');
    session.status = 'idle';
    return true;
  }

  /**
   * Close a session.
   */
  closeSession(sessionId: string): boolean {
    const session = this.sessions.get(sessionId);
    if (!session) return false;

    if (session.process) {
      session.process.kill('SIGTERM');
    }

    session.status = 'stopped';
    this.sessions.delete(sessionId);
    this.emit('session:closed', session);
    return true;
  }

  /**
   * Get command history for a session.
   */
  getCommandHistory(sessionId: string): string[] {
    const session = this.sessions.get(sessionId);
    return session ? [...session.commandHistory] : [];
  }

  /**
   * Get command results for a session.
   */
  getResults(sessionId: string, limit: number = 50): CommandResult[] {
    const results = this.results.get(sessionId) || [];
    return results.slice(-limit);
  }

  /**
   * Get all sessions.
   */
  listSessions(): TerminalSession[] {
    return Array.from(this.sessions.values());
  }

  /**
   * Get statistics.
   */
  getStats(): {
    totalSessions: number;
    activeSessions: number;
    totalCommands: number;
  } {
    const sessions = Array.from(this.sessions.values());
    const totalCommands = Array.from(this.results.values()).reduce(
      (sum, r) => sum + r.length,
      0
    );

    return {
      totalSessions: sessions.length,
      activeSessions: sessions.filter((s) => s.status === 'running').length,
      totalCommands,
    };
  }
}
