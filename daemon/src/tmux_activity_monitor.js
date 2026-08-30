/**
 * Tmux Activity Monitor
 *
 * Extracted from agent-tmux-web (inspiration).
 * Detects session state (working, waiting, idle) from terminal output.
 * Strips ANSI codes, detects working/waiting prompts, completion signals.
 */

// ANSI escape sequence pattern
const ANSI_PATTERN = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~])/g;

// OSC sequence pattern (terminal titles, etc.)
const OSC_PATTERN = /\u001b\][^\u0007]*(?:\u0007|\u001b\\)/g;

// Decorative line patterns (borders, dividers)
const DECORATIVE_PATTERN = /^[╭╰├┤│─━═└┘┌┐┴┬┼-]{5,}$/;

// Working indicators
const WORKING_PATTERNS = [
  /(?:working|thinking|running).*?(?:interrupt|esc|ctrl-c)/i,
  /(?:esc|ctrl-c)\s+to\s+interrupt/i,
  /(?:esc|ctrl-c)\s+interrupt/i,
  /press\s+(?:esc|ctrl-c)\s+to\s+interrupt/i,
];

// Completion indicators
const COMPLETION_PATTERNS = [
  /\bgoal achieved\b/i,
  /^worked for \d/i,
  /\btask complete\b/i,
  /\bdone\b/i,
  /\bcompleted\b/i,
];

// Confirmation prompt indicators
const CONFIRMATION_PATTERNS = [
  /press enter to confirm/i,
  /esc to go back/i,
  /^replace goal\?/i,
  /\b(allow|approve|permission|permissions|authorize|confirm|proceed|continue)\b.*\?/i,
  /(?:\?|which\s+\w+|what\s+\w+|should i|do you want|please choose)/i,
];

// Prompt line patterns
const PROMPT_PATTERNS = [
  /^\$\s/,
  /^#\s/,
  /^>\s/,
  /\$\s*$/,
  /^[\w@]+:[~\/].*[$#]\s/,
];

/**
 * Strip ANSI escape sequences from output
 * @param {string} output - Raw terminal output
 * @returns {string} Cleaned output
 */
function cleanOutput(output) {
  return output
    .replace(ANSI_PATTERN, '')
    .replace(OSC_PATTERN, '');
}

/**
 * Check if a line is decorative (borders, dividers)
 * @param {string} line - Single line of output
 * @returns {boolean}
 */
function isDecorativeLine(line) {
  const compact = line.replace(/\s/g, '');
  return DECORATIVE_PATTERN.test(compact) || /^worked for \d/i.test(line);
}

/**
 * Extract meaningful tail lines from output
 * @param {string} output - Terminal output
 * @param {number} lineCount - Number of lines to extract
 * @returns {string[]} Meaningful lines
 */
function meaningfulTail(output, lineCount = 12) {
  return cleanOutput(output)
    .split(/\r?\n/)
    .map(line => line.trim())
    .filter(line => line && !isDecorativeLine(line))
    .slice(-lineCount);
}

/**
 * Find last index matching predicate
 * @param {string[]} lines
 * @param {(line: string) => boolean} predicate
 * @returns {number} Index or -1
 */
function lastIndexWhere(lines, predicate) {
  for (let i = lines.length - 1; i >= 0; i--) {
    if (predicate(lines[i])) return i;
  }
  return -1;
}

/**
 * Check if output looks like tmux is working (agent processing)
 * @param {string} output - Terminal output
 * @returns {boolean}
 */
function looksLikeTmuxWorking(output) {
  const tail = meaningfulTail(output, 12);
  const lastWorkingLine = lastIndexWhere(tail, isWorkingLine);
  if (lastWorkingLine === -1) return false;
  return lastWorkingLine >= lastWaitingLineIndex(tail);
}

/**
 * Check if output looks like tmux is waiting for input
 * @param {string} output - Terminal output
 * @returns {boolean}
 */
function looksLikeTmuxWaitingForInput(output) {
  if (!output.trim()) return false;
  const tail = meaningfulTail(output, 12);
  const lastWaitingLine = lastWaitingLineIndex(tail);
  return lastWaitingLine !== -1 && lastWaitingLine > lastIndexWhere(tail, isWorkingLine);
}

/**
 * Check if output indicates task completion
 * @param {string} output - Terminal output
 * @returns {boolean}
 */
function looksLikeCompleted(output) {
  const tail = meaningfulTail(output, 6);
  return lastIndexWhere(tail, isCompletionLine) !== -1;
}

/**
 * Check if a line indicates working state
 */
function isWorkingLine(line) {
  const normalized = line.toLowerCase();
  return WORKING_PATTERNS.some(p => p.test(normalized));
}

/**
 * Check if a line indicates completion
 */
function isCompletionLine(line) {
  return COMPLETION_PATTERNS.some(p => p.test(line));
}

/**
 * Check if a line is a confirmation prompt
 */
function isConfirmationPromptLine(line) {
  return CONFIRMATION_PATTERNS.some(p => p.test(line));
}

/**
 * Check if a line looks like a shell/CLI prompt
 */
function isPromptLine(line) {
  return PROMPT_PATTERNS.some(p => p.test(line));
}

/**
 * Find the last waiting line index in meaningful tail
 */
function lastWaitingLineIndex(lines) {
  const promptStart = Math.max(0, lines.length - 4);
  const lastExplicitSignal = lastIndexWhere(
    lines,
    line => isCompletionLine(line) || isConfirmationPromptLine(line)
  );
  const promptIndex = lastIndexWhere(
    lines.slice(promptStart),
    isPromptLine
  );
  return Math.max(
    lastExplicitSignal,
    promptIndex === -1 ? -1 : promptStart + promptIndex
  );
}

/**
 * Get session state from terminal output
 * @param {string} output - Terminal output
 * @returns {'working' | 'waiting' | 'completed' | 'idle'}
 */
function getSessionState(output) {
  if (!output || !output.trim()) return 'idle';
  if (looksLikeCompleted(output)) return 'completed';
  if (looksLikeTmuxWorking(output)) return 'working';
  if (looksLikeTmuxWaitingForInput(output)) return 'waiting';
  return 'idle';
}

/**
 * State change callback
 * @callback StateChangeCallback
 * @param {string} sessionId
 * @param {string} newState
 * @param {string} oldState
 */

/**
 * Create an activity monitor for multiple sessions
 */
class TmuxActivityMonitor {
  constructor() {
    this.states = new Map();
    this.listeners = [];
    this.pollIntervals = new Map();
  }

  /**
   * Subscribe to state changes
   * @param {StateChangeCallback} callback
   */
  onStateChange(callback) {
    this.listeners.push(callback);
    return () => {
      this.listeners = this.listeners.filter(cb => cb !== callback);
    };
  }

  /**
   * Update session output and detect state change
   * @param {string} sessionId
   * @param {string} output
   * @returns {{ state: string, changed: boolean }}
   */
  update(sessionId, output) {
    const oldState = this.states.get(sessionId) || 'idle';
    const newState = getSessionState(output);
    this.states.set(sessionId, newState);

    const changed = oldState !== newState;
    if (changed) {
      for (const listener of this.listeners) {
        listener(sessionId, newState, oldState);
      }
    }

    return { state: newState, changed };
  }

  /**
   * Get current state for a session
   * @param {string} sessionId
   * @returns {string}
   */
  getState(sessionId) {
    return this.states.get(sessionId) || 'idle';
  }

  /**
   * Get all session states
   * @returns {Map<string, string>}
   */
  getAllStates() {
    return new Map(this.states);
  }

  /**
   * Remove a session
   * @param {string} sessionId
   */
  removeSession(sessionId) {
    this.states.delete(sessionId);
    if (this.pollIntervals.has(sessionId)) {
      clearInterval(this.pollIntervals.get(sessionId));
      this.pollIntervals.delete(sessionId);
    }
  }
}

export {
  cleanOutput,
  meaningfulTail,
  looksLikeTmuxWorking,
  looksLikeTmuxWaitingForInput,
  looksLikeCompleted,
  getSessionState,
  isWorkingLine,
  isCompletionLine,
  isConfirmationPromptLine,
  isPromptLine,
  TmuxActivityMonitor,
  WORKING_PATTERNS,
  COMPLETION_PATTERNS,
  CONFIRMATION_PATTERNS,
};
