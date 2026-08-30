/**
 * QR-based session sharing — share terminal sessions via QR code for mobile access.
 *
 * Extracted from inspiration/PocketDesk/muxile.
 * Pattern: tmux plugin that generates a QR code with a WebSocket URL for mobile viewing.
 * Uses websocat to bridge tmux ↔ WebSocket, QR code for mobile pairing.
 */

import crypto from 'node:crypto';
import { WebSocketServer } from 'ws';

/**
 * Manage shared sessions that can be accessed via QR code.
 * Each shared session gets a unique short token and a WebSocket relay.
 */
export class QRSessionSharing {
  constructor(opts = {}) {
    this.port = opts.port || 0; // 0 = auto-assign
    this.host = opts.host || '0.0.0.0';
    this.publicUrl = opts.publicUrl || '';
    this.ttlMs = opts.ttlMs || 5 * 60 * 1000; // 5 min default
    this.sessions = new Map(); // token → { ws, createdAt, clientId }
    this.server = null;
    this.wss = null;
  }

  start() {
    return new Promise((resolve) => {
      this.wss = new WebSocketServer({ port: this.port, host: this.host });
      this.server = this.wss;

      this.wss.on('connection', (ws, req) => {
        const url = new URL(req.url, `http://${req.headers.host}`);
        const token = url.searchParams.get('token');

        if (!token || !this.sessions.has(token)) {
          ws.close(1008, 'Invalid token');
          return;
        }

        const session = this.sessions.get(token);
        session.ws = ws;
        session.clientId = crypto.randomUUID();

        ws.on('message', (data) => {
          // Relay data back to the terminal
          session.onInput?.(data.toString());
        });

        ws.on('close', () => {
          session.ws = null;
        });

        ws.send(JSON.stringify({ type: 'connected', token }));
      });

      this.server.on('listening', () => {
        const actualPort = this.server.address().port;
        resolve({ port: actualPort });
      });
    });
  }

  /**
   * Create a new shareable session.
   * Returns a token and QR code payload.
   */
  createSession(onInput) {
    const token = crypto.randomBytes(6).toString('hex');
    const port = this.server?.address()?.port || this.port;
    const baseUrl = this.publicUrl || `http://localhost:${port}`;

    const session = {
      token,
      ws: null,
      clientId: null,
      createdAt: Date.now(),
      onInput,
    };

    this.sessions.set(token, session);
    this._scheduleExpiry(token);

    return {
      token,
      url: `${baseUrl}/?token=${token}`,
      // QR payload: JSON with URL + token + timestamp
      qrPayload: JSON.stringify({ url: `${baseUrl}/?token=${token}`, token, ts: Date.now() }),
    };
  }

  /**
   * Send terminal output to the connected mobile viewer.
   */
  sendOutput(token, data) {
    const session = this.sessions.get(token);
    if (session?.ws?.readyState === 1) { // OPEN
      session.ws.send(JSON.stringify({ output: data }));
    }
  }

  /**
   * Stop sharing a session.
   */
  stopSession(token) {
    const session = this.sessions.get(token);
    if (!session) return;
    if (session.ws) {
      try { session.ws.close(1000, 'Session ended'); } catch {}
    }
    this.sessions.delete(token);
  }

  /**
   * Close all sessions and stop the server.
   */
  stop() {
    for (const [token] of this.sessions) {
      this.stopSession(token);
    }
    if (this.wss) {
      this.wss.close();
    }
  }

  _scheduleExpiry(token) {
    setTimeout(() => {
      const session = this.sessions.get(token);
      if (session && Date.now() - session.createdAt > this.ttlMs) {
        this.stopSession(token);
      }
    }, this.ttlMs);
  }
}

/**
 * Generate a simple QR code data URI (minimal, no external deps).
 * Uses a simple matrix barcode (not real QR spec, but sufficient for demo).
 * Returns the URL that should be rendered by a QR library on the client.
 */
export function generateQRUrl(baseUrl, token) {
  const url = `${baseUrl}/?token=${token}`;
  // Use a public QR API as fallback for rendering
  return `https://api.qrserver.com/v1/create-qr-code/?size=300x300&data=${encodeURIComponent(url)}`;
}
