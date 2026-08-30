/**
 * Telegram CLI Bridge for PocketDesk
 * Extracted from: claude-cli-telegram (Claude Code CLI via Telegram)
 * Patterns: Bot message handling, CLI command execution, streaming output,
 *           session management, approval flow, voice input, git integration
 */

const EventEmitter = require('events');
const { spawn } = require('child_process');

class TelegramCLIBridge extends EventEmitter {
  constructor(config = {}) {
    super();
    this.botToken = config.botToken;
    this.chatId = config.chatId;
    this.cliPath = config.cliPath || 'claude';
    this.sessions = new Map();
    this.pendingApprovals = new Map();
    this.commandHistory = [];
    this.maxHistory = 100;
  }

  /**
   * Process incoming Telegram message
   */
  async handleMessage(message) {
    const { text, chatId, userId, messageId } = message;
    this.commandHistory.push({ text, userId, timestamp: Date.now() });
    if (this.commandHistory.length > this.maxHistory) {
      this.commandHistory.shift();
    }

    // Command routing
    if (text.startsWith('/')) {
      return this.handleCommand(text, chatId, userId);
    }

    // Free-form message → send to Claude Code CLI
    return this.executeCLI(text, chatId);
  }

  /**
   * Handle slash commands
   */
  async handleCommand(text, chatId, userId) {
    const [command, ...args] = text.split(' ');

    switch (command.toLowerCase()) {
      case '/start':
        return { text: '🤖 PocketDesk Telegram Bridge\nSend any message to interact with your terminal.', format: 'markdown' };

      case '/status':
        return this.getStatus();

      case '/sessions':
        return this.listSessions();

      case '/new':
        return this.newSession(chatId);

      case '/switch':
        return this.switchSession(args[0], chatId);

      case '/shell':
        return this.executeShell(args.join(' '), chatId);

      case '/git':
        return this.executeGit(args.join(' '), chatId);

      case '/approve':
        return this.handleApproval(args[0], true, chatId);

      case '/deny':
        return this.handleApproval(args[0], false, chatId);

      case '/system':
        return this.getSystemInfo();

      default:
        return { text: `Unknown command: ${command}\nType /help for available commands.`, format: 'text' };
    }
  }

  /**
   * Execute Claude Code CLI command
   */
  async executeCLI(prompt, chatId) {
    const sessionId = this.getOrCreateSession(chatId);
    const session = this.sessions.get(sessionId);

    session.status = 'running';
    session.lastPrompt = prompt;

    return new Promise((resolve) => {
      const proc = spawn(this.cliPath, ['--print', prompt], {
        cwd: session.cwd || process.cwd(),
        env: { ...process.env },
        timeout: 120000,
      });

      let stdout = '';
      let stderr = '';

      proc.stdout.on('data', (data) => {
        stdout += data.toString();
        this.emit('output', { sessionId, data: data.toString(), stream: 'stdout' });
      });

      proc.stderr.on('data', (data) => {
        stderr += data.toString();
        this.emit('output', { sessionId, data: data.toString(), stream: 'stderr' });
      });

      proc.on('close', (code) => {
        session.status = 'idle';
        session.output = stdout;
        session.lastExitCode = code;

        if (code !== 0 && stderr) {
          resolve({ text: `⚠️ CLI exited with code ${code}\n\n${stderr.slice(0, 500)}`, format: 'text' });
        } else {
          const truncated = stdout.length > 4000 ? stdout.slice(0, 4000) + '\n\n... (truncated)' : stdout;
          resolve({ text: truncated || '(no output)', format: 'markdown' });
        }
      });

      proc.on('error', (error) => {
        session.status = 'error';
        resolve({ text: `❌ Error: ${error.message}`, format: 'text' });
      });
    });
  }

  /**
   * Execute raw shell command
   */
  async executeShell(command, chatId) {
    if (!command) return { text: 'Usage: /shell <command>', format: 'text' };

    const dangerous = ['rm -rf', 'sudo', 'mkfs', 'dd if=', ':(){', 'fork bomb'];
    if (dangerous.some(d => command.toLowerCase().includes(d))) {
      const approvalId = require('crypto').randomUUID();
      this.pendingApprovals.set(approvalId, { command, chatId, timestamp: Date.now() });
      return {
        text: `⚠️ Dangerous command detected. Reply with:\n/approve ${approvalId}\n\nto proceed.`,
        format: 'text',
      };
    }

    return new Promise((resolve) => {
      const proc = spawn('bash', ['-c', command], { timeout: 30000 });
      let output = '';

      proc.stdout.on('data', (data) => { output += data.toString(); });
      proc.stderr.on('data', (data) => { output += data.toString(); });

      proc.on('close', (code) => {
        const truncated = output.length > 3000 ? output.slice(0, 3000) + '\n... (truncated)' : output;
        resolve({ text: `Exit: ${code}\n\n${truncated || '(no output)'}`, format: 'text' });
      });
    });
  }

  /**
   * Execute git command
   */
  async executeGit(args, chatId) {
    if (!args) {
      return this.executeShell('git status', chatId);
    }
    return this.executeShell(`git ${args}`, chatId);
  }

  /**
   * Handle approval/denial of dangerous commands
   */
  async handleApproval(approvalId, approved, chatId) {
    const pending = this.pendingApprovals.get(approvalId);
    if (!pending) return { text: 'No pending approval found.', format: 'text' };

    this.pendingApprovals.delete(approvalId);

    if (approved) {
      this.emit('approved', { command: pending.command, userId: chatId });
      return this.executeShell(pending.command, chatId);
    } else {
      this.emit('denied', { command: pending.command, userId: chatId });
      return { text: '❌ Command denied.', format: 'text' };
    }
  }

  /**
   * Session management
   */
  getOrCreateSession(chatId) {
    if (!this.sessions.has(chatId)) {
      this.sessions.set(chatId, {
        id: chatId,
        cwd: process.cwd(),
        status: 'idle',
        createdAt: Date.now(),
        output: '',
        lastPrompt: '',
        lastExitCode: 0,
      });
    }
    return chatId;
  }

  newSession(chatId) {
    this.sessions.set(chatId, {
      id: `session-${Date.now()}`,
      cwd: process.cwd(),
      status: 'idle',
      createdAt: Date.now(),
      output: '',
      lastPrompt: '',
      lastExitCode: 0,
    });
    return { text: '✅ New session created.', format: 'text' };
  }

  switchSession(sessionId, chatId) {
    if (this.sessions.has(sessionId)) {
      return { text: `✅ Switched to session ${sessionId}`, format: 'text' };
    }
    return { text: `Session ${sessionId} not found.`, format: 'text' };
  }

  listSessions() {
    const sessions = Array.from(this.sessions.entries()).map(([id, s]) => {
      const age = Math.round((Date.now() - s.createdAt) / 60000);
      return `${id}: ${s.status} (${age}min old)`;
    });
    return { text: `Sessions:\n${sessions.join('\n') || 'None'}`, format: 'text' };
  }

  /**
   * System info
   */
  getSystemInfo() {
    const info = {
      platform: process.platform,
      arch: process.arch,
      nodeVersion: process.version,
      uptime: Math.round(process.uptime()),
      memoryMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      activeSessions: this.sessions.size,
      pendingApprovals: this.pendingApprovals.size,
    };
    return { text: '```' + JSON.stringify(info, null, 2) + '```', format: 'markdown' };
  }

  getStatus() {
    return {
      text: `🟢 Running\nSessions: ${this.sessions.size}\nApprovals pending: ${this.pendingApprovals.size}`,
      format: 'text',
    };
  }
}

module.exports = { TelegramCLIBridge };
