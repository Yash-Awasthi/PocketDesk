/**
 * Bridge Server — mobile control of coding sessions.
 * Extracted from ccpocket — bridge server patterns for remote session control.
 */

const http = require('http');
const crypto = require('crypto');
const { URL } = require('url');
const { SessionMonitor } = require('./session_monitor');

class BridgeServer {
  constructor(port = 8765) {
    this.port = port;
    this.server = null;
    this.sessionMonitor = new SessionMonitor();
    this.pendingApprovals = new Map();
    this.connections = new Map();
    this.authTokens = new Map();
  }

  start() {
    this.sessionMonitor.start();
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    this.server.listen(this.port, () => {
      console.log(`Bridge Server running on port ${this.port}`);
      this.printQRCode();
    });
  }

  stop() {
    this.sessionMonitor.stop();
    if (this.server) {
      this.server.close();
    }
  }

  handleRequest(req, res) {
    const url = new URL(req.url, `http://localhost:${this.port}`);
    const path = url.pathname;

    // CORS
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    // Auth check
    const token = req.headers.authorization?.replace('Bearer ', '');
    if (token && !this.validateToken(token)) {
      this.sendJSON(res, 401, { error: 'Unauthorized' });
      return;
    }

    try {
      switch (path) {
        case '/api/sessions':
          this.handleSessions(req, res);
          break;
        case '/api/session':
          this.handleSessionDetail(req, res, url);
          break;
        case '/api/approve':
          this.handleApproval(req, res);
          break;
        case '/api/reject':
          this.handleRejection(req, res);
          break;
        case '/api/stats':
          this.handleStats(req, res);
          break;
        case '/health':
          this.sendJSON(res, 200, { status: 'ok', uptime: process.uptime() });
          break;
        default:
          this.sendJSON(res, 404, { error: 'Not found' });
      }
    } catch (err) {
      this.sendJSON(res, 500, { error: err.message });
    }
  }

  handleSessions(req, res) {
    const sessions = this.sessionMonitor.getActiveSessions();
    this.sendJSON(res, 200, {
      sessions: sessions.map(s => ({
        id: s.id,
        pid: s.pid,
        processName: s.processName,
        status: s.status,
        createdAt: s.createdAt,
        messageCount: s.messageCount,
      })),
    });
  }

  handleSessionDetail(req, res, url) {
    const sessionId = url.searchParams.get('id');
    const sessions = this.sessionMonitor.getActiveSessions();
    const session = sessions.find(s => s.id === sessionId);
    if (!session) {
      this.sendJSON(res, 404, { error: 'Session not found' });
      return;
    }
    this.sendJSON(res, 200, { session });
  }

  handleApproval(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const { approvalId } = JSON.parse(body);
      const approval = this.pendingApprovals.get(approvalId);
      if (approval) {
        approval.resolve(true);
        this.pendingApprovals.delete(approvalId);
        this.sendJSON(res, 200, { approved: true });
      } else {
        this.sendJSON(res, 404, { error: 'Approval not found' });
      }
    });
  }

  handleRejection(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const { approvalId } = JSON.parse(body);
      const approval = this.pendingApprovals.get(approvalId);
      if (approval) {
        approval.resolve(false);
        this.pendingApprovals.delete(approvalId);
        this.sendJSON(res, 200, { approved: false });
      } else {
        this.sendJSON(res, 404, { error: 'Approval not found' });
      }
    });
  }

  handleStats(req, res) {
    const stats = this.sessionMonitor.getSessionStats();
    this.sendJSON(res, 200, stats);
  }

  requestApproval(action, description) {
    return new Promise((resolve) => {
      const id = crypto.randomUUID();
      this.pendingApprovals.set(id, {
        action,
        description,
        createdAt: Date.now(),
        resolve,
      });

      // Auto-reject after 5 minutes
      setTimeout(() => {
        if (this.pendingApprovals.has(id)) {
          this.pendingApprovals.get(id).resolve(false);
          this.pendingApprovals.delete(id);
        }
      }, 5 * 60 * 1000);
    });
  }

  generateAuthToken() {
    const token = crypto.randomBytes(32).toString('hex');
    this.authTokens.set(token, { createdAt: Date.now() });
    return token;
  }

  validateToken(token) {
    return this.authTokens.has(token);
  }

  printQRCode() {
    const connectionUrl = `http://localhost:${this.port}`;
    console.log(`\n  Scan QR code to connect:`);
    console.log(`  ${connectionUrl}`);
    console.log(`  Or visit in browser for QR code\n`);
  }

  sendJSON(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }
}

module.exports = { BridgeServer };
