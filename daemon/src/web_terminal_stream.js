/**
 * Web Terminal with Streaming Output
 * Extracted from: claude-web (Rust+WebSocket terminal UI for Claude CLI)
 * Patterns: Stream-json output, multi-session with --resume,
 *           persistent chat history, terminal-style UI, monospace rendering
 */

const EventEmitter = require('events');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const os = require('os');

class WebTerminalStream extends EventEmitter {
  constructor(config = {}) {
    super();
    this.cliPath = config.cliPath || 'claude';
    this.historyDir = config.historyDir || path.join(os.homedir(), '.claude-web');
    this.sessions = new Map();
    this.messageQueues = new Map();
  }

  /**
   * Initialize history directory
   */
  init() {
    if (!fs.existsSync(this.historyDir)) {
      fs.mkdirSync(this.historyDir, { recursive: true });
    }
  }

  /**
   * Create or resume a session
   */
  createSession(sessionId, options = {}) {
    this.init();
    const historyFile = path.join(this.historyDir, `${sessionId}.json`);

    const session = {
      id: sessionId,
      resumeSessionId: options.resumeSessionId || null,
      cwd: options.cwd || process.cwd(),
      model: options.model,
      historyFile,
      messages: [],
      status: 'idle',
      createdAt: Date.now(),
    };

    // Load existing history
    if (fs.existsSync(historyFile)) {
      try {
        const data = JSON.parse(fs.readFileSync(historyFile, 'utf-8'));
        session.messages = data.messages || [];
        session.resumeSessionId = data.resumeSessionId;
      } catch { /* ignore corrupted history */ }
    }

    this.sessions.set(sessionId, session);
    this.emit('session:created', session);
    return session;
  }

  /**
   * Send a message and stream the response
   */
  async sendMessage(sessionId, message) {
    const session = this.sessions.get(sessionId);
    if (!session) throw new Error(`Session ${sessionId} not found`);

    session.status = 'thinking';
    this.emit('session:thinking', { sessionId });

    // Add user message to history
    session.messages.push({
      role: 'user',
      content: message,
      timestamp: Date.now(),
    });

    // Build CLI args
    const args = ['-p', message, '--output-format', 'stream-json'];
    if (session.resumeSessionId) {
      args.push('--resume', session.resumeSessionId);
    }
    if (session.model) {
      args.push('--model', session.model);
    }

    return new Promise((resolve, reject) => {
      const proc = spawn(this.cliPath, args, {
        cwd: session.cwd,
        env: { ...process.env },
      });

      let fullOutput = '';
      let buffer = '';

      proc.stdout.on('data', (chunk) => {
        buffer += chunk.toString();
        const lines = buffer.split('\n');
        buffer = lines.pop(); // Keep incomplete line in buffer

        for (const line of lines) {
          if (!line.trim()) continue;
          try {
            const parsed = JSON.parse(line);
            this.emit('stream:chunk', { sessionId, data: parsed });

            if (parsed.type === 'assistant' && parsed.content) {
              fullOutput += parsed.content;
            }
          } catch {
            // Plain text output
            this.emit('stream:text', { sessionId, text: line });
            fullOutput += line + '\n';
          }
        }
      });

      proc.stderr.on('data', (chunk) => {
        this.emit('stream:error', { sessionId, text: chunk.toString() });
      });

      proc.on('close', (code) => {
        session.status = 'idle';

        // Add assistant message to history
        session.messages.push({
          role: 'assistant',
          content: fullOutput,
          timestamp: Date.now(),
          exitCode: code,
        });

        // Save history
        this._saveHistory(session);
        this.emit('session:idle', { sessionId });
        resolve({ sessionId, output: fullOutput, exitCode: code });
      });

      proc.on('error', (error) => {
        session.status = 'error';
        this.emit('session:error', { sessionId, error: error.message });
        reject(error);
      });
    });
  }

  /**
   * Get session history
   */
  getHistory(sessionId, limit = 50) {
    const session = this.sessions.get(sessionId);
    if (!session) return [];
    return session.messages.slice(-limit);
  }

  /**
   * List all sessions
   */
  listSessions() {
    return Array.from(this.sessions.values()).map(s => ({
      id: s.id,
      messageCount: s.messages.length,
      status: s.status,
      createdAt: s.createdAt,
    }));
  }

  /**
   * Delete a session
   */
  deleteSession(sessionId) {
    const session = this.sessions.get(sessionId);
    if (session && fs.existsSync(session.historyFile)) {
      fs.unlinkSync(session.historyFile);
    }
    this.sessions.delete(sessionId);
  }

  _saveHistory(session) {
    try {
      fs.writeFileSync(session.historyFile, JSON.stringify({
        resumeSessionId: session.resumeSessionId,
        messages: session.messages,
      }, null, 2));
    } catch (error) {
      this.emit('error', { sessionId: session.id, error: error.message });
    }
  }
}

module.exports = { WebTerminalStream };
