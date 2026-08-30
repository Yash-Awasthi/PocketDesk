/**
 * xterm.js Integration — Browser terminal rendering and PTY layer.
 *
 * Inspired by xterm-pty and xterm.js.
 * Provides configuration and addon management for xterm.js-based
 * terminal rendering in the browser.
 */

import { createHash, randomBytes } from 'crypto';
import { EventEmitter } from 'events';

// ============================================================================
// Types
// ============================================================================

export interface XtermConfig {
  fontSize: number;
  fontFamily: string;
  theme: string;
  cursorBlink: boolean;
  cursorStyle: 'block' | 'underline' | 'bar';
  scrollback: number;
  allowProposedApi: boolean;
  drawBoldTextInBrightColors: boolean;
  minimumContrastRatio: number;
  experimentalRowDelete: boolean;
}

export interface XtermAddon {
  name: string;
  version: string;
  isEnabled: boolean;
  config?: Record<string, unknown>;
}

export interface TerminalState {
  id: string;
  config: XtermConfig;
  addons: XtermAddon[];
  isConnected: boolean;
  scrollPosition: number;
  selectionText: string;
  cursorRow: number;
  cursorCol: number;
  cols: number;
  rows: number;
  createdAt: Date;
  lastActivity: Date;
}

export interface Theme {
  name: string;
  background: string;
  foreground: string;
  cursor: string;
  cursorAccent: string;
  selectionBackground: string;
  black: string;
  red: string;
  green: string;
  yellow: string;
  blue: string;
  magenta: string;
  cyan: string;
  white: string;
  brightBlack: string;
  brightRed: string;
  brightGreen: string;
  brightYellow: string;
  brightBlue: string;
  brightMagenta: string;
  brightCyan: string;
  brightWhite: string;
}

// ============================================================================
// Built-in Themes
// ============================================================================

export const THEMES: Record<string, Theme> = {
  dark: {
    name: 'Dark',
    background: '#1e1e1e',
    foreground: '#d4d4d4',
    cursor: '#d4d4d4',
    cursorAccent: '#1e1e1e',
    selectionBackground: '#264f78',
    black: '#000000',
    red: '#cd3131',
    green: '#0dbc79',
    yellow: '#e5e510',
    blue: '#2472c8',
    magenta: '#bc3fbc',
    cyan: '#11a8cd',
    white: '#e5e5e5',
    brightBlack: '#666666',
    brightRed: '#f14c4c',
    brightGreen: '#23d18b',
    brightYellow: '#f5f543',
    brightBlue: '#3b8eea',
    brightMagenta: '#d670d6',
    brightCyan: '#29b8db',
    brightWhite: '#ffffff',
  },
  solarized: {
    name: 'Solarized',
    background: '#002b36',
    foreground: '#839496',
    cursor: '#839496',
    cursorAccent: '#002b36',
    selectionBackground: '#073642',
    black: '#073642',
    red: '#dc322f',
    green: '#859900',
    yellow: '#b58900',
    blue: '#268bd2',
    magenta: '#d33682',
    cyan: '#2aa198',
    white: '#eee8d5',
    brightBlack: '#586e75',
    brightRed: '#cb4b16',
    brightGreen: '#586e75',
    brightYellow: '#657b83',
    brightBlue: '#839496',
    brightMagenta: '#6c71c4',
    brightCyan: '#93a1a1',
    brightWhite: '#fdf6e3',
  },
  monokai: {
    name: 'Monokai',
    background: '#272822',
    foreground: '#f8f8f2',
    cursor: '#f8f8f0',
    cursorAccent: '#272822',
    selectionBackground: '#49483e',
    black: '#272822',
    red: '#f92672',
    green: '#a6e22e',
    yellow: '#f4bf75',
    blue: '#66d9ef',
    magenta: '#ae81ff',
    cyan: '#a1efe4',
    white: '#f8f8f2',
    brightBlack: '#75715e',
    brightRed: '#f92672',
    brightGreen: '#a6e22e',
    brightYellow: '#f4bf75',
    brightBlue: '#66d9ef',
    brightMagenta: '#ae81ff',
    brightCyan: '#a1efe4',
    brightWhite: '#f9f8f5',
  },
};

// ============================================================================
// xterm Integration Manager
// ============================================================================

export class XtermIntegrationManager extends EventEmitter {
  private terminals: Map<string, TerminalState> = new Map();
  private defaultConfig: XtermConfig;

  constructor() {
    super();
    this.defaultConfig = {
      fontSize: 14,
      fontFamily: 'Menlo, Monaco, "Courier New", monospace',
      theme: 'dark',
      cursorBlink: true,
      cursorStyle: 'block',
      scrollback: 10000,
      allowProposedApi: true,
      drawBoldTextInBrightColors: true,
      minimumContrastRatio: 1,
      experimentalRowDelete: false,
    };
  }

  /**
   * Create a new terminal state.
   */
  createTerminal(config?: Partial<XtermConfig>): TerminalState {
    const terminal: TerminalState = {
      id: randomBytes(8).toString('hex'),
      config: { ...this.defaultConfig, ...config },
      addons: [],
      isConnected: false,
      scrollPosition: 0,
      selectionText: '',
      cursorRow: 0,
      cursorCol: 0,
      cols: 80,
      rows: 24,
      createdAt: new Date(),
      lastActivity: new Date(),
    };

    // Add default addons
    terminal.addons = [
      { name: 'fit', version: '1.0.0', isEnabled: true },
      { name: 'web-links', version: '1.0.0', isEnabled: true },
      { name: 'search', version: '1.0.0', isEnabled: false },
    ];

    this.terminals.set(terminal.id, terminal);
    this.emit('terminal:created', terminal);
    return terminal;
  }

  /**
   * Enable an addon.
   */
  enableAddon(terminalId: string, addonName: string): boolean {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return false;

    const addon = terminal.addons.find((a) => a.name === addonName);
    if (!addon) return false;

    addon.isEnabled = true;
    this.emit('addon:enabled', { terminalId, addonName });
    return true;
  }

  /**
   * Disable an addon.
   */
  disableAddon(terminalId: string, addonName: string): boolean {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return false;

    const addon = terminal.addons.find((a) => a.name === addonName);
    if (!addon) return false;

    addon.isEnabled = false;
    this.emit('addon:disabled', { terminalId, addonName });
    return true;
  }

  /**
   * Update terminal config.
   */
  updateConfig(terminalId: string, config: Partial<XtermConfig>): boolean {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return false;

    terminal.config = { ...terminal.config, ...config };
    this.emit('config:updated', { terminalId, config: terminal.config });
    return true;
  }

  /**
   * Get theme colors.
   */
  getTheme(themeName: string): Theme | undefined {
    return THEMES[themeName];
  }

  /**
   * List available themes.
   */
  listThemes(): string[] {
    return Object.keys(THEMES);
  }

  /**
   * Update cursor position.
   */
  updateCursor(terminalId: string, row: number, col: number): void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return;

    terminal.cursorRow = row;
    terminal.cursorCol = col;
    terminal.lastActivity = new Date();
  }

  /**
   * Update selection.
   */
  updateSelection(terminalId: string, text: string): void {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return;

    terminal.selectionText = text;
    terminal.lastActivity = new Date();
  }

  /**
   * Get terminal state.
   */
  getTerminal(terminalId: string): TerminalState | undefined {
    return this.terminals.get(terminalId);
  }

  /**
   * List all terminals.
   */
  listTerminals(): TerminalState[] {
    return Array.from(this.terminals.values());
  }

  /**
   * Remove a terminal.
   */
  removeTerminal(terminalId: string): boolean {
    const terminal = this.terminals.get(terminalId);
    if (!terminal) return false;

    this.terminals.delete(terminalId);
    this.emit('terminal:removed', terminal);
    return true;
  }

  /**
   * Get statistics.
   */
  getStats(): {
    totalTerminals: number;
    connectedTerminals: number;
    totalAddons: number;
  } {
    const terminals = Array.from(this.terminals.values());
    const totalAddons = terminals.reduce((sum, t) => sum + t.addons.length, 0);

    return {
      totalTerminals: terminals.length,
      connectedTerminals: terminals.filter((t) => t.isConnected).length,
      totalAddons,
    };
  }
}
