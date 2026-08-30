/**
 * Mobile Bridge Server — mobile control of coding sessions.
 * Extracted from claude-code-mobile — bridge server patterns.
 */

const http = require('http');
const crypto = require('crypto');
const { WebSocket } = require('ws');

class MobileBridgeServer {
  constructor(port = 8766) {
    this.port = port;
    this.server = null;
    this.wss = null;
    this.clients = new Map();
    this.sessions = new Map();
    this.authTokens = new Map();
  }

  start() {
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    this.server.listen(this.port, () => {
      console.log(`Mobile Bridge running on port ${this.port}`);
    });
  }

  handleRequest(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    if (req.method === 'OPTIONS') {
      res.writeHead(200);
      res.end();
      return;
    }

    const url = new URL(req.url, `http://localhost:${this.port}`);

    switch (url.pathname) {
      case '/api/sessions':
        this.sendJSON(res, 200, {
          sessions: Array.from(this.sessions.values()),
        });
        break;
      case '/api/token':
        const token = this.generateToken();
        this.sendJSON(res, 200, { token });
        break;
      case '/api/session/create':
        this.handleCreateSession(req, res);
        break;
      default:
        this.sendJSON(res, 404, { error: 'Not found' });
    }
  }

  handleCreateSession(req, res) {
    let body = '';
    req.on('data', chunk => { body += chunk; });
    req.on('end', () => {
      const { workspace, agent } = JSON.parse(body);
      const session = {
        id: crypto.randomUUID(),
        workspace,
        agent: agent || 'claude',
        status: 'active',
        createdAt: Date.now(),
      };
      this.sessions.set(session.id, session);
      this.sendJSON(res, 200, { session });
    });
  }

  generateToken() {
    const token = crypto.randomBytes(32).toString('hex');
    this.authTokens.set(token, { createdAt: Date.now() });
    return token;
  }

  sendJSON(res, status, data) {
    res.writeHead(status, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(data));
  }
}

module.exports = { MobileBridgeServer };
