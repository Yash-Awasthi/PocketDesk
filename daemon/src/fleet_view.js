/**
 * Fleet View — Grid-based multi-terminal management.
 *
 * Inspired by terminalcontrol (FleetView).
 * Provides a grid view of multiple terminal sessions with status indicators,
 * notification chips, and focus management.
 */

import { createHash, randomBytes } from 'crypto';
import { EventEmitter } from 'events';

// ============================================================================
// Types
// ============================================================================

export type AgentStatus = 'idle' | 'running' | 'waiting' | 'done' | 'error';

export interface FleetTerminal {
  id: string;
  name: string;
  sessionId: string;
  status: AgentStatus;
  statusMessage: string;
  lastActivity: Date;
  createdAt: Date;
  position: { row: number; col: number };
  size: { cols: number; rows: number };
  isFocused: boolean;
  notificationPending: boolean;
}

export interface NotificationChip {
  id: string;
  terminalId: string;
  message: string;
  priority: 'low' | 'medium' | 'high';
  createdAt: Date;
  dismissed: boolean;
}

export interface FleetGrid {
  rows: number;
  cols: number;
  terminals: FleetTerminal[];
  focusedTerminalId: string | null;
}

// ============================================================================
// Fleet View Manager
// ============================================================================

export class FleetViewManager extends EventEmitter {
  private terminals: Map<string, FleetTerminal> = new Map();
  private chips: Map<string, NotificationChip> = new Map();
  private grid: FleetGrid = { rows: 2, cols: 2, terminals: [], focusedTerminalId: null };
  private chipCounter = 0;

  /**
   * Add a terminal to the fleet.
   */
  addTerminal(name: string, sessionId: string): FleetTerminal {
    const position = this.findNextPosition();

    const terminal: FleetTerminal = {
      id: randomBytes(8).toString('hex'),
      name,
      sessionId,
      status: 'idle',
      statusMessage: '',
      lastActivity: new Date(),
      createdAt: new Date(),
      position,
      size: { cols: 80, rows: 24 },
      isFocused: false,
      notificationPending: false,
    };

    this.terminals.set(terminal.id, terminal);
    this.grid.terminals = Array.from(this.terminals.values());
    this.emit('terminal:added', terminal);
    return terminal;
  }

  /**
   * Remove a terminal from the fleet.
   */
  removeTerminal(terminalId: string): boolean {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return false;

    this.terminals.delete(terminalId);
    this.grid.terminals = Array.from(this.terminals.values());
    this.emit('terminal:removed', terminal);
    return true;
  }

  /**
   * Update terminal status.
   */
  updateStatus(terminalId: string, status: AgentStatus, message: string = ''): void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return;

    const prevStatus = terminal.status;
    terminal.status = status;
    terminal.statusMessage = message;
    terminal.lastActivity = new Date();

    // Create notification chip for status changes
    if (status === 'waiting' || (status === 'done' && prevStatus !== 'done')) {
      this.createChip(terminalId, message || `${status}`, status === 'waiting' ? 'high' : 'medium');
    }

    // Update visual glow
    terminal.notificationPending = status === 'waiting';

    this.emit('status:updated', terminal);
  }

  /**
   * Create a notification chip.
   */
  createChip(terminalId: string, message: string, priority: 'low' | 'medium' | 'high' = 'medium'): NotificationChip {
    this.chipCounter++;
    const chip: NotificationChip = {
      id: `chip-${this.chipCounter}`,
      terminalId,
      message,
      priority,
      createdAt: new Date(),
      dismissed: false,
    };

    this.chips.set(chip.id, chip);
    this.emit('chip:created', chip);
    return chip;
  }

  /**
   * Dismiss a notification chip.
   */
  dismissChip(chipId: string): boolean {
    const chip = this.chips.get(chipId);
    if (!chip) return false;

    chip.dismissed = true;
    this.emit('chip:dismissed', chip);
    return true;
  }

  /**
   * Focus on a terminal.
   */
  focusTerminal(terminalId: string): boolean {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return false;

    // Unfocus all others
    for (const t of this.terminals.values()) {
      t.isFocused = false;
    }

    terminal.isFocused = true;
    terminal.notificationPending = false;
    this.grid.focusedTerminalId = terminalId;

    // Dismiss related chips
    for (const chip of this.chips.values()) {
      if (chip.terminalId === terminalId && !chip.dismissed) {
        chip.dismissed = true;
      }
    }

    this.emit('terminal:focused', terminal);
    return true;
  }

  /**
   * Resize the grid.
   */
  resizeGrid(rows: number, cols: number): void {
    this.grid.rows = rows;
    this.grid.cols = cols;
    this.relayout();
    this.emit('grid:resized', this.grid);
  }

  /**
   * Relayout terminals in the grid.
   */
  private relayout(): void {
    let pos = 0;
    for (const terminal of this.terminals.values()) {
      terminal.position = {
        row: Math.floor(pos / this.grid.cols),
        col: pos % this.grid.cols,
      };
      pos++;
    }
  }

  /**
   * Find the next available grid position.
   */
  private findNextPosition(): { row: number; col: number } {
    const occupied = new Set(
      Array.from(this.terminals.values()).map(
        (t) => `${t.position.row},${t.position.col}`
      )
    );

    for (let r = 0; r < this.grid.rows; r++) {
      for (let c = 0; c < this.grid.cols; c++) {
        if (!occupied.has(`${r},${c}`)) {
          return { row: r, col: c };
        }
      }
    }

    // All positions occupied, expand grid
    this.grid.cols++;
    return { row: 0, col: this.grid.cols - 1 };
  }

  /**
   * Get all pending chips.
   */
  getPendingChips(): NotificationChip[] {
    return Array.from(this.chips.values()).filter((c) => !c.dismissed);
  }

  /**
   * Get all terminals.
   */
  getTerminals(): FleetTerminal[] {
    return Array.from(this.terminals.values());
  }

  /**
   * Get focused terminal.
   */
  getFocusedTerminal(): FleetTerminal | undefined {
    if (!this.grid.focusedTerminalId) return undefined;
    return this.terminals.get(this.grid.focusedTerminalId);
  }

  /**
   * Get statistics.
   */
  getStats(): {
    totalTerminals: number;
    activeTerminals: number;
    waitingTerminals: number;
    pendingChips: number;
    grid: { rows: number; cols: number };
  } {
    const terminals = Array.from(this.terminals.values());
    return {
      totalTerminals: terminals.length,
      activeTerminals: terminals.filter((t) => t.status === 'running').length,
      waitingTerminals: terminals.filter((t) => t.status === 'waiting').length,
      pendingChips: this.getPendingChips().length,
      grid: { rows: this.grid.rows, cols: this.grid.cols },
    };
  }
}
