/**
 * Push Notification Bridge for PocketDesk
 * Extracted from: claude-code-remote-control (phone notifications for Claude Code)
 * Patterns: ntfy.sh integration, Pushover support, multi-session watching,
 *           notification modes (active/standby/log-only), action buttons,
 *           terminal watcher + parser, tmux session monitoring
 */

const EventEmitter = require('events');
const https = require('https');
const http = require('http');

class PushNotificationBridge extends EventEmitter {
  constructor(config = {}) {
    super();
    this.ntfyTopic = config.ntfyTopic || 'pocketdesk';
    this.ntfyServer = config.ntfyServer || 'https://ntfy.sh';
    this.pushoverToken = config.pushoverToken;
    this.pushoverUser = config.pushoverUser;
    this.mode = config.mode || 'active'; // 'active', 'standby', 'log-only'
    this.sessions = new Map();
    this.notificationLog = [];
    this.lastNotification = 0;
    this.cooldownMs = config.cooldownMs || 5000;
  }

  /**
   * Send a notification via ntfy.sh
   */
  async sendNtfy(title, message, options = {}) {
    if (this.mode === 'log-only') {
      this._log('ntfy', title, message);
      return { sent: false, reason: 'log-only mode' };
    }

    const payload = JSON.stringify({
      topic: this.ntfyTopic,
      title,
      message,
      priority: options.priority || 3,
      tags: options.tags || [],
      actions: options.actions || [],
      click: options.click,
    });

    return new Promise((resolve, reject) => {
      const url = new URL(`${this.ntfyServer}/${this.ntfyTopic}`);
      const req = https.request(url, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Title': title,
          'Priority': String(options.priority || 3),
          'Tags': (options.tags || []).join(','),
        },
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          this._log('ntfy', title, message);
          resolve({ sent: true, status: res.statusCode });
        });
      });

      req.on('error', reject);
      req.write(message);
      req.end();
    });
  }

  /**
   * Send a notification via Pushover
   */
  async sendPushover(title, message, options = {}) {
    if (!this.pushoverToken || !this.pushoverUser) {
      return { sent: false, reason: 'Pushover not configured' };
    }

    if (this.mode === 'log-only') {
      this._log('pushover', title, message);
      return { sent: false, reason: 'log-only mode' };
    }

    const postData = `token=${this.pushoverToken}&user=${this.pushoverUser}&title=${encodeURIComponent(title)}&message=${encodeURIComponent(message)}&priority=${options.priority || 0}`;

    return new Promise((resolve, reject) => {
      const req = https.request('https://api.pushover.net/1/messages.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      }, (res) => {
        let body = '';
        res.on('data', chunk => body += chunk);
        res.on('end', () => {
          this._log('pushover', title, message);
          resolve({ sent: true, status: res.statusCode });
        });
      });
      req.on('error', reject);
      req.write(postData);
      req.end();
    });
  }

  /**
   * Watch a terminal session for Claude Code events
   */
  watchSession(sessionId, config = {}) {
    const session = {
      id: sessionId,
      name: config.name || sessionId,
      backend: config.backend || 'tmux', // 'tmux' or 'native'
      terminal: config.terminal || 'auto',
      status: 'watching',
      lastOutput: '',
      pendingApproval: false,
    };

    this.sessions.set(sessionId, session);
    this.emit('session:watching', session);
    return session;
  }

  /**
   * Process terminal output and detect Claude Code events
   */
  processOutput(sessionId, output) {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    session.lastOutput = output;

    // Detect approval needed
    if (output.includes('Do you want to proceed') || output.includes('Allow') || output.includes('approve')) {
      if (!session.pendingApproval) {
        session.pendingApproval = true;
        this._notifyApproval(session, output);
        return { event: 'approval_needed', sessionId };
      }
    }

    // Detect task completion
    if (output.includes('Done') || output.includes('Completed') || output.includes('Finished')) {
      session.pendingApproval = false;
      this._notifyCompletion(session, output);
      return { event: 'task_completed', sessionId };
    }

    // Detect error
    if (output.includes('Error') || output.includes('Failed') || output.includes('Exception')) {
      this._notifyError(session, output);
      return { event: 'error', sessionId };
    }

    return null;
  }

  /**
   * Set notification mode
   */
  setMode(mode) {
    if (!['active', 'standby', 'log-only'].includes(mode)) {
      throw new Error(`Invalid mode: ${mode}`);
    }
    this.mode = mode;
    this.emit('mode:changed', mode);
  }

  /**
   * Get notification log
   */
  getLog(limit = 50) {
    return this.notificationLog.slice(-limit);
  }

  /**
   * Get session statuses
   */
  getSessions() {
    return Array.from(this.sessions.values());
  }

  async _notifyApproval(session, output) {
    const title = `✋ Approval needed — ${session.name}`;
    const message = output.slice(0, 200);
    const actions = [
      { action: 'http', label: 'Open Terminal', url: '' },
      { action: 'http', label: 'Ignore', url: '' },
    ];

    await this.sendNtfy(title, message, { priority: 4, tags: ['warning', 'hand'], actions });
    await this.sendPushover(title, message, { priority: 1 });
  }

  async _notifyCompletion(session, output) {
    const title = `✅ Task completed — ${session.name}`;
    const message = output.slice(0, 200);
    await this.sendNtfy(title, message, { priority: 2, tags: ['white_check_mark'] });
  }

  async _notifyError(session, output) {
    const title = `❌ Error — ${session.name}`;
    const message = output.slice(0, 200);
    await this.sendNtfy(title, message, { priority: 4, tags: ['rotating_light'] });
    await this.sendPushover(title, message, { priority: 1 });
  }

  _log(service, title, message) {
    this.notificationLog.push({
      service,
      title,
      message,
      timestamp: Date.now(),
    });
    if (this.notificationLog.length > 200) {
      this.notificationLog = this.notificationLog.slice(-200);
    }
  }
}

module.exports = { PushNotificationBridge };
