/**
 * Web SSH server — minimal Express + WebSocket terminal.
 *
 * Extracted from inspiration/PocketDesk/webssh.
 * Pattern: PTY-based terminal multiplexing over WebSocket.
 * Wire protocol: JSON messages { input: "string" } and { resize: [cols, rows] }
 * Output: JSON messages { output: "string" }
 */

import http from 'node:http';
import { WebSocketServer } from 'ws';

/**
 * Create a WebSocket-based terminal server.
 *
 * @param {object} opts
 * @param {number} opts.port - Listen port
 * @param {function} opts.spawnPty - function(cols, rows) → PTY process
 * @param {function} [opts.onConnect] - called on new connection
 * @param {function} [opts.onDisconnect] - called on close
 * @param {object} [opts.auth] - { token: string } optional auth
 * @returns {http.Server}
 */
export function createWebTerminalServer(opts = {}) {
  const { port = 8999, spawnPty, onConnect, onDisconnect, auth } = opts;

  const server = http.createServer((req, res) => {
    if (req.url === '/health') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', uptime: process.uptime() }));
      return;
    }
    res.writeHead(404);
    res.end('Not found');
  });

  const wss = new WebSocketServer({ server });

  wss.on('connection', (ws, req) => {
    // Auth check
    if (auth?.token) {
      const url = new URL(req.url, `http://${req.headers.host}`);
      const token = url.searchParams.get('token');
      if (token !== auth.token) {
        ws.send(JSON.stringify({ error: 'Unauthorized' }));
        ws.close(1008, 'Unauthorized');
        return;
      }
    }

    let ptyProcess = null;
    const cols = 80, rows = 24;

    try {
      ptyProcess = spawnPty(cols, rows);
    } catch (err) {
      ws.send(JSON.stringify({ error: `Failed to spawn PTY: ${err.message}` }));
      ws.close(1011, 'Internal error');
      return;
    }

    onConnect?.(ws, req);

    // PTY output → WebSocket
    ptyProcess.on('data', (data) => {
      if (ws.readyState === ws.OPEN) {
        ws.send(JSON.stringify({ output: data.toString() }));
      }
    });

    ptyProcess.on('exit', (code) => {
      ws.send(JSON.stringify({ exit: code }));
      ws.close(1000, `Process exited with code ${code}`);
    });

    // WebSocket → PTY
    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.input) {
        ptyProcess.write(msg.input);
      } else if (msg.resize && Array.isArray(msg.resize)) {
        ptyProcess.resize(msg.resize[0], msg.resize[1]);
      }
    });

    ws.on('close', () => {
      if (ptyProcess) {
        try { ptyProcess.kill(); } catch {}
      }
      onDisconnect?.(ws, req);
    });

    ws.on('error', () => {
      if (ptyProcess) {
        try { ptyProcess.kill(); } catch {}
      }
    });
  });

  server.listen(port, () => {
    console.log(`Web terminal server started on port ${port}`);
  });

  return server;
}

/**
 * Minimal client-side WebSocket terminal protocol handler.
 * Useful for tests and for the embedded HTML UI.
 */
export class TerminalClient {
  constructor(wsUrl, handlers = {}) {
    this.ws = new WebSocket(wsUrl);
    this.handlers = handlers;

    this.ws.onopen = () => this.handlers.onOpen?.();
    this.ws.onclose = (e) => this.handlers.onClose?.(e);
    this.ws.onerror = (e) => this.handlers.onError?.(e);
    this.ws.onmessage = (e) => {
      try {
        const msg = JSON.parse(e.data);
        if (msg.output) this.handlers.onOutput?.(msg.output);
        else if (msg.exit !== undefined) this.handlers.onExit?.(msg.exit);
        else if (msg.error) this.handlers.onError?.(new Error(msg.error));
      } catch {
        this.handlers.onRaw?.(e.data);
      }
    };
  }

  sendInput(data) {
    this.ws.send(JSON.stringify({ input: data }));
  }

  resize(cols, rows) {
    this.ws.send(JSON.stringify({ resize: [cols, rows] }));
  }

  close() {
    this.ws.close();
  }
}
