/**
 * Slash Command Parser
 *
 * Extracted from agent-tmux-web (inspiration).
 * Parses slash commands from user input, provides autocomplete filtering,
 * and routes commands to handlers.
 */

/**
 * @typedef {Object} SlashCommand
 * @property {string} name - Command name (e.g., '/status')
 * @property {string} description - Short description
 * @property {string} detail - Detailed help text
 * @property {boolean} local - Whether command runs locally (no server roundtrip)
 * @property {string[]} aliases - Alternative names
 */

/**
 * @typedef {Object} ParsedCommand
 * @property {string} name - Command name without '/'
 * @property {string} args - Remaining arguments
 * @property {number} cursorPos - Position in original string
 */

/**
 * Built-in slash commands for PocketDesk
 */
const BUILT_IN_COMMANDS = [
  { name: '/status', description: 'Display session configuration', detail: 'Shows current session status, connected clients, and plugin state.', local: true, aliases: [] },
  { name: '/sessions', description: 'List active sessions', detail: 'Show all running tmux/terminal sessions.', local: true, aliases: ['/ls'] },
  { name: '/attach', description: 'Attach to a session', detail: '/attach <session-name> to start monitoring.', local: false, aliases: ['/a'] },
  { name: '/detach', description: 'Detach from current session', detail: 'Stop monitoring the current session.', local: true, aliases: ['/d'] },
  { name: '/kill', description: 'Kill a session', detail: '/kill <session-name> to terminate.', local: false, aliases: [] },
  { name: '/send', description: 'Send keys to session', detail: '/send <session-name> <keys> to type into terminal.', local: false, aliases: [] },
  { name: '/clear', description: 'Clear terminal output', detail: 'Clear the displayed terminal buffer.', local: true, aliases: [] },
  { name: '/copy', description: 'Copy last output', detail: 'Copy the last visible agent output to clipboard.', local: true, aliases: [] },
  { name: '/help', description: 'Show available commands', detail: 'Display this help message.', local: true, aliases: ['/h', '/?'] },
  { name: '/plugins', description: 'List loaded plugins', detail: 'Show all loaded plugins and their status.', local: true, aliases: [] },
  { name: '/plugin', description: 'Manage a plugin', detail: '/plugin <load|unload|reload> <name>', local: false, aliases: [] },
  { name: '/notify', description: 'Send notification', detail: '/notify <title> <message> to send a notification.', local: false, aliases: [] },
  { name: '/theme', description: 'Switch theme', detail: '/theme <dark|light> to change UI theme.', local: true, aliases: [] },
  { name: '/debug', description: 'Toggle debug mode', detail: 'Enable/disable verbose logging.', local: true, aliases: [] },
  { name: '/export', description: 'Export session data', detail: '/export <format> to export session history.', local: true, aliases: [] },
  { name: '/record', description: 'Start/stop recording', detail: '/record start|stop to record terminal session.', local: false, aliases: [] },
  { name: '/snapshot', description: 'Take session snapshot', detail: 'Capture current session state for replay.', local: false, aliases: [] },
  { name: '/propose', description: 'Create a proposal', detail: '/propose <action> to request approval for an action.', local: false, aliases: [] },
  { name: '/approve', description: 'Approve a proposal', detail: '/approve <proposal-id> to approve pending action.', local: false, aliases: [] },
  { name: '/reject', description: 'Reject a proposal', detail: '/reject <proposal-id> to reject pending action.', local: false, aliases: [] },
];

/**
 * Parse a slash command from user input
 * @param {string} input - User input string
 * @param {number} cursorPos - Cursor position (default: end of string)
 * @returns {ParsedCommand | null}
 */
function parseSlashCommand(input, cursorPos = input.length) {
  const beforeCursor = input.slice(0, cursorPos);
  const lineStart = Math.max(beforeCursor.lastIndexOf('\n') + 1, 0);
  const currentLine = beforeCursor.slice(lineStart);

  if (!currentLine.startsWith('/')) {
    return null;
  }
  // Allow arguments after command name

  const parts = currentLine.slice(1).split(/\s+/);

  return {
    name: parts[0].toLowerCase(),
    args: parts.slice(1).join(' '),
    cursorPos,
  };
}

/**
 * Check if input starts with a slash command
 * @param {string} input
 * @returns {boolean}
 */
function isSlashCommand(input) {
  return input.trimStart().startsWith('/');
}

/**
 * Get the slash query for autocomplete
 * @param {string} input - User input
 * @param {number} cursorPos - Cursor position
 * @returns {{ start: number, end: number, query: string } | null}
 */
function getSlashQuery(input, cursorPos) {
  const beforeCursor = input.slice(0, cursorPos);
  const lineStart = Math.max(beforeCursor.lastIndexOf('\n') + 1, 0);
  const currentLine = beforeCursor.slice(lineStart);

  if (!currentLine.startsWith('/')) {
    return null;
  }
  // Allow arguments after command name

  return {
    start: lineStart,
    end: cursorPos,
    query: currentLine.slice(1).toLowerCase(),
  };
}

/**
 * Rank a command against a query for autocomplete
 * @param {SlashCommand} command
 * @param {string} query
 * @returns {number | null} Rank (lower = better), null if no match
 */
function rankCommand(command, query) {
  const name = command.name.slice(1).toLowerCase(); // Remove leading /
  const normalized = query.replace(/^\//, '').toLowerCase();

  if (!normalized) return 0; // Show all when no query

  // Exact match
  if (name === normalized) return 0;

  // Starts with query
  if (name.startsWith(normalized)) return 1;

  // Contains query
  if (name.includes(normalized)) return 2;

  // Alias match
  for (const alias of command.aliases) {
    if (alias.toLowerCase().startsWith(normalized)) return 1;
    if (alias.toLowerCase().includes(normalized)) return 2;
  }

  // Fuzzy match (all characters present in order)
  let qi = 0;
  for (let ni = 0; ni < name.length && qi < normalized.length; ni++) {
    if (name[ni] === normalized[qi]) qi++;
  }
  if (qi === normalized.length) return 3;

  return null; // No match
}

/**
 * Filter commands for autocomplete
 * @param {string} query
 * @param {SlashCommand[]} commands
 * @param {number} maxResults
 * @returns {SlashCommand[]}
 */
function filterCommands(query, commands = BUILT_IN_COMMANDS, maxResults = 10) {
  const normalized = query.trim().replace(/^\//, '').toLowerCase();

  return commands
    .map((command, index) => ({
      command,
      index,
      rank: rankCommand(command, normalized),
    }))
    .filter(entry => entry.rank !== null)
    .sort((a, b) => (a.rank ?? 0) - (b.rank ?? 0) || a.index - b.index)
    .map(entry => entry.command)
    .slice(0, maxResults);
}

/**
 * Find a command by name
 * @param {string} name - Command name (with or without /)
 * @param {SlashCommand[]} commands
 * @returns {SlashCommand | undefined}
 */
function findCommand(name, commands = BUILT_IN_COMMANDS) {
  const normalized = name.startsWith('/') ? name : `/${name}`;
  return commands.find(
    cmd => cmd.name === normalized || cmd.aliases.includes(normalized)
  );
}

/**
 * Execute a slash command
 * @param {string} input - Full user input
 * @param {Object} context - Execution context
 * @returns {{ success: boolean, message: string, result?: any }}
 */
function executeCommand(input, context = {}) {
  const parsed = parseSlashCommand(input);
  if (!parsed) {
    return { success: false, message: 'Not a slash command' };
  }

  const command = findCommand(parsed.name);
  if (!command) {
    return { success: false, message: `Unknown command: /${parsed.name}` };
  }

  // Check if handler exists in context
  const handler = context.handlers?.[command.name];
  if (handler) {
    try {
      const result = handler(parsed.args, context);
      return { success: true, message: result?.message || 'Command executed', result };
    } catch (err) {
      return { success: false, message: `Error: ${err.message}` };
    }
  }

  // Default response for commands without handlers
  return {
    success: true,
    message: `${command.name}: ${command.detail}`,
    result: { command: command.name, args: parsed.args },
  };
}

export {
  BUILT_IN_COMMANDS,
  parseSlashCommand,
  isSlashCommand,
  getSlashQuery,
  filterCommands,
  findCommand,
  executeCommand,
  rankCommand,
};
