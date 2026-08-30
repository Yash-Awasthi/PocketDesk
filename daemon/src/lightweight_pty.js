/**
 * Lightweight PTY — Tiny cross-platform PTY implementation.
 *
 * Inspired by zigpty.
 * Provides a lightweight PTY layer for Node.js without native dependencies,
 * suitable for terminal emulators, remote shells, and AI agents.
 */

import { spawn, ChildProcess } from 'child_process';
import { createHash, randomBytes } from 'crypto';
import { EventEmitter } from 'events';

// ============================================================================
// Types
// ============================================================================

export interface PtyConfig {
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
  uid?: number;
  gid?: number;
}

export interface PtyProcess {
  id: string;
  config: PtyConfig;
  process: ChildProcess;
  status: 'running' | 'exited' | 'error';
  exitCode: number | null;
  startTime: Date;
  exitTime?: Date;
  output: string[];
  maxOutput: number;
}

// ============================================================================
// Lightweight PTY Manager
// ============================================================================

export class LightweightPtyManager extends EventEmitter {
  private processes: Map<string, PtyProcess> = new Map();

  /**
   * Spawn a new PTY process.
   */
  spawn(config: Partial<PtyConfig> = {}): PtyProcess {
    const ptyConfig: PtyConfig = {
      command: config.command || '/bin/sh',
      args: config.args || [],
      cwd: config.cwd || process.env.HOME || '/tmp',
      env: { ...process.env, ...config.env, TERM: 'xterm-256color', LANG: 'en_US.UTF-8' },
      cols: config.cols || 80,
      rows: config.rows || 24,
    };

    const proc = spawn(ptyConfig.command, ptyConfig.args, {
      cwd: ptyConfig.cwd,
      env: ptyConfig.env,
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    const id = randomBytes(8).toString('hex');
    const ptyProcess: PtyProcess = {
      id,
      config: ptyConfig,
      process: proc,
      status: 'running',
      exitCode: null,
      startTime: new Date(),
      output: [],
      maxOutput: 10000,
    };

    // Capture output
    proc.stdout?.on('data', (data: Buffer) => {
      const text = data.toString();
      ptyProcess.output.push(text);
      while (ptyProcess.output.join('').length > ptyProcess.maxOutput) {
        ptyProcess.output.shift();
      }
      this.emit('output', { id, data: text });
    });

    proc.stderr?.on('data', (data: Buffer) => {
      this.emit('error-output', { id, data: data.toString() });
    });

    proc.on('close', (code) => {
      ptyProcess.status = 'exited';
      ptyProcess.exitCode = code;
      ptyProcess.exitTime = new Date();
      this.emit('exit', { id, code });
    });

    proc.on('error', (err) => {
      ptyProcess.status = 'error';
      ptyProcess.exitTime = new Date();
      this.emit('error', { id, error: err.message });
    });

    this.processes.set(id, ptyProcess);
    this.emit('spawn', { id, command: ptyConfig.command });
    return ptyProcess;
  }

  /**
   * Write input to a PTY process.
   */
  write(id: string, data: string): boolean {
    const pty = this.processes.get(id);
    if (!pty || pty.status !== 'running') return false;

    pty.process.stdin?.write(data);
    return true;
  }

  /**
   * Resize a PTY process.
   */
  resize(id: string, cols: number, rows: number): boolean {
    const pty = this.processes.get(id);
    if (!pty || pty.status !== 'running') return false;

    // In a real PTY, this would use ioctl to resize
    pty.config.cols = cols;
    pty.config.rows = rows;
    this.emit('resize', { id, cols, rows });
    return true;
  }

  /**
   * Kill a PTY process.
   */
  kill(id: string, signal: string = 'SIGTERM'): boolean {
    const pty = this.processes.get(id);
    if (!pty || pty.status !== 'running') return false;

    pty.process.kill(signal);
    return true;
  }

  /**
   * Get output from a PTY process.
   */
  getOutput(id: string, lines?: number): string[] {
    const pty = this.processes.get(id);
    if (!pty) return [];

    if (lines !== undefined) {
      return pty.output.slice(-lines);
    }
    return [...pty.output];
  }

  /**
   * Get all running processes.
   */
  getRunning(): PtyProcess[] {
    return Array.from(this.processes.values()).filter((p) => p.status === 'running');
  }

  /**
   * Get all processes.
   */
  getAll(): PtyProcess[] {
    return Array.from(this.processes.values());
  }

  /**
   * Get process by ID.
   */
  get(id: string): PtyProcess | undefined {
    return this.processes.get(id);
  }

  /**
   * Remove a process.
   */
  remove(id: string): boolean {
    const pty = this.processes.get(id);
    if (!pty) return false;

    if (pty.status === 'running') {
      pty.process.kill('SIGKILL');
    }

    this.processes.delete(id);
    return true;
  }

  /**
   * Get statistics.
   */
  getStats(): {
    total: number;
    running: number;
    exited: number;
    error: number;
  } {
    const processes = Array.from(this.processes.values());
    return {
      total: processes.length,
      running: processes.filter((p) => p.status === 'running').length,
      exited: processes.filter((p) => p.status === 'exited').length,
      error: processes.filter((p) => p.status === 'error').length,
    };
  }

  /**
   * Kill all processes.
   */
  killAll(): number {
    let killed = 0;
    for (const [id, pty] of this.processes) {
      if (pty.status === 'running') {
        pty.process.kill('SIGKILL');
        killed++;
      }
    }
    return killed;
  }
}
