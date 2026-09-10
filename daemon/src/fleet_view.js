/**
 * Fleet View — Grid-based multi-terminal management.
 *
 * Inspired by terminalcontrol (FleetView).
 * Provides a grid view of multiple terminal sessions with status indicators,
 * notification chips, and focus management.
 *
 * NOTE: ported from TS-syntax-in-.js to plain ESM (it could not be imported
 * under the package's "type": "module" before).
 */

import { randomBytes } from "node:crypto";
import { EventEmitter } from "node:events";

/**
 * Grid view of terminal sessions with status chips + focus management.
 */
export class FleetViewManager extends EventEmitter {
  constructor() {
    super();
    /** @type {Map<string, object>} */
    this.terminals = new Map();
    /** @type {Map<string, object>} */
    this.chips = new Map();
    this.grid = { rows: 2, cols: 2, terminals: [], focusedTerminalId: null };
    this.chipCounter = 0;
  }

  /**
   * Add a terminal to the fleet.
   */
  addTerminal(name, sessionId) {
    const position = this.findNextPosition();

    const terminal = {
      id: randomBytes(8).toString("hex"),
      name,
      sessionId,
      status: "idle",
      statusMessage: "",
      lastActivity: new Date(),
      createdAt: new Date(),
      position,
      size: { cols: 80, rows: 24 },
      isFocused: false,
      notificationPending: false,
    };

    this.terminals.set(terminal.id, terminal);
    this.grid.terminals = Array.from(this.terminals.values());
    this.emit("terminal:added", terminal);
    return terminal;
  }

  /**
   * Remove a terminal from the fleet.
   */
  removeTerminal(terminalId) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return false;

    this.terminals.delete(terminalId);
    this.grid.terminals = Array.from(this.terminals.values());
    this.emit("terminal:removed", terminal);
    return true;
  }

  /**
   * Update terminal status. Waiting/done transitions raise notification chips.
   */
  updateStatus(terminalId, status, message = "") {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return;

    const prevStatus = terminal.status;
    terminal.status = status;
    terminal.statusMessage = message;
    terminal.lastActivity = new Date();

    if (status === "waiting" || (status === "done" && prevStatus !== "done")) {
      this.createChip(terminalId, message || `${status}`, status === "waiting" ? "high" : "medium");
    }

    terminal.notificationPending = status === "waiting";
    this.emit("status:updated", terminal);
  }

  /**
   * Create a notification chip.
   */
  createChip(terminalId, message, priority = "medium") {
    this.chipCounter++;
    const chip = {
      id: `chip-${this.chipCounter}`,
      terminalId,
      message,
      priority,
      createdAt: new Date(),
      dismissed: false,
    };

    this.chips.set(chip.id, chip);
    this.emit("chip:created", chip);
    return chip;
  }

  /**
   * Dismiss a notification chip.
   */
  dismissChip(chipId) {
    const chip = this.chips.get(chipId);
    if (!chip) return false;

    chip.dismissed = true;
    this.emit("chip:dismissed", chip);
    return true;
  }

  /**
   * Focus a terminal (unfocuses others, clears its chips and pending flag).
   */
  focusTerminal(terminalId) {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return false;

    for (const t of this.terminals.values()) {
      t.isFocused = false;
    }

    terminal.isFocused = true;
    terminal.notificationPending = false;
    this.grid.focusedTerminalId = terminalId;

    for (const chip of this.chips.values()) {
      if (chip.terminalId === terminalId && !chip.dismissed) {
        chip.dismissed = true;
      }
    }

    this.emit("terminal:focused", terminal);
    return true;
  }

  /**
   * Resize the grid and relayout terminal positions.
   */
  resizeGrid(rows, cols) {
    this.grid.rows = rows;
    this.grid.cols = cols;
    this.relayout();
    this.emit("grid:resized", this.grid);
  }

  relayout() {
    let pos = 0;
    for (const terminal of this.terminals.values()) {
      terminal.position = {
        row: Math.floor(pos / this.grid.cols),
        col: pos % this.grid.cols,
      };
      pos++;
    }
  }

  findNextPosition() {
    const occupied = new Set(
      Array.from(this.terminals.values()).map((t) => `${t.position.row},${t.position.col}`),
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
   * Get all pending (undismissed) chips.
   */
  getPendingChips() {
    return Array.from(this.chips.values()).filter((c) => !c.dismissed);
  }

  /**
   * Get all terminals.
   */
  getTerminals() {
    return Array.from(this.terminals.values());
  }

  /**
   * Get the focused terminal, if any.
   */
  getFocusedTerminal() {
    if (!this.grid.focusedTerminalId) return undefined;
    return this.terminals.get(this.grid.focusedTerminalId);
  }

  /**
   * Get fleet statistics.
   */
  getStats() {
    const terminals = Array.from(this.terminals.values());
    return {
      totalTerminals: terminals.length,
      activeTerminals: terminals.filter((t) => t.status === "running").length,
      waitingTerminals: terminals.filter((t) => t.status === "waiting").length,
      pendingChips: this.getPendingChips().length,
      grid: { rows: this.grid.rows, cols: this.grid.cols },
    };
  }
}
