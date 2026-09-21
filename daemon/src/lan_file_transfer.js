/**
 * LAN file transfer — peer-to-peer file sharing on local network.
 *
 * Extracted from inspiration/PocketDesk/lanlink.
 * Pattern: HTTP server with UDP multicast discovery, LocalSend v2 protocol,
 * stream-based file I/O, transfer session management, per-peer trust.
 */

import http from 'node:http';
import dgram from 'node:dgram';
import crypto from 'node:crypto';
import { createWriteStream, createReadStream, statSync } from 'node:fs';
import { basename, join } from 'node:path';
import { networkInterfaces } from 'node:os';

const MULTICAST_ADDR = '224.0.0.167';
const MULTICAST_PORT = 53317;
const HTTP_PORT = 53316;

/**
 * Peer discovery via UDP multicast.
 * Announce presence and listen for other peers on the LAN.
 */
export class PeerDiscovery {
  constructor(opts = {}) {
    this.alias = opts.alias || `device-${crypto.randomBytes(3).toString('hex')}`;
    this.port = opts.port || HTTP_PORT;
    this.fingerprint = crypto.randomBytes(16).toString('hex');
    this.peers = new Map(); // ip → { alias, fingerprint, port, lastSeen }
    this.socket = null;
    this._announceTimer = null;
  }

  start() {
    return new Promise((resolve, reject) => {
      this.socket = dgram.createSocket({ type: 'udp4', reuseAddr: true });

      this.socket.on('message', (msg, rinfo) => {
        try {
          const data = JSON.parse(msg.toString());
          if (data.alias && data.fingerprint) {
            this.peers.set(rinfo.address, {
              alias: data.alias,
              fingerprint: data.fingerprint,
              port: data.port || HTTP_PORT,
              lastSeen: Date.now(),
            });
          }
        } catch {}
      });

      this.socket.on('listening', () => {
        this.socket.addMembership(MULTICAST_ADDR);
        this._startAnnouncing();
        resolve();
      });

      this.socket.on('error', reject);
      this.socket.bind(MULTICAST_PORT);
    });
  }

  _startAnnouncing() {
    const announce = () => {
      const payload = JSON.stringify({
        alias: this.alias,
        fingerprint: this.fingerprint,
        port: this.port,
      });
      this.socket.send(payload, MULTICAST_PORT, MULTICAST_ADDR);
    };
    announce();
    this._announceTimer = setInterval(announce, 5000);
  }

  getPeers() {
    // Prune stale peers (not seen in 15s)
    const now = Date.now();
    for (const [ip, peer] of this.peers) {
      if (now - peer.lastSeen > 15000) {
        this.peers.delete(ip);
      }
    }
    return [...this.peers.entries()].map(([ip, p]) => ({ ip, ...p }));
  }

  stop() {
    if (this._announceTimer) clearInterval(this._announceTimer);
    if (this.socket) this.socket.close();
  }
}

/**
 * HTTP server for receiving files (LocalSend v2 protocol).
 */
export class FileTransferServer {
  constructor(opts = {}) {
    this.port = opts.port || HTTP_PORT;
    this.downloadDir = opts.downloadDir || './downloads';
    this.trustedFingerprints = new Set(opts.trustedFingerprints || []);
    this.sessions = new Map(); // sessionId → { files, totalBytes, receivedBytes, status }
    this.server = null;
  }

  start() {
    this.server = http.createServer((req, res) => {
      const url = new URL(req.url, `http://${req.headers.host}`);

      // GET /api/localsend/v2/info — device info
      if (req.method === 'GET' && url.pathname === '/api/localsend/v2/info') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({
          alias: this.alias || 'PocketDesk',
          version: '2',
          port: this.port,
          protocol: 'https',
          download: '/api/localsend/v2/prepare-upload',
        }));
        return;
      }

      // POST /api/localsend/v2/prepare-upload — file metadata + session creation
      if (req.method === 'POST' && url.pathname === '/api/localsend/v2/prepare-upload') {
        let body = '';
        req.on('data', chunk => body += chunk);
        req.on('end', () => {
          try {
            const data = JSON.parse(body);
            const sessionId = crypto.randomUUID();
            const files = {};
            let totalBytes = 0;
            for (const [id, info] of Object.entries(data.info?.files || {})) {
              files[id] = { ...info, received: 0 };
              totalBytes += info.size || 0;
            }
            // The trust list was collected and never consulted. Empty means
            // "accept anyone", as before; non-empty now actually gates.
            const senderFingerprint = data.info?.sender?.fingerprint;
            if (this.trustedFingerprints.size > 0 && !this.trustedFingerprints.has(senderFingerprint)) {
              res.writeHead(403, { 'Content-Type': 'application/json' });
              res.end(JSON.stringify({ error: 'sender fingerprint not trusted' }));
              return;
            }
            this.sessions.set(sessionId, {
              files,
              totalBytes,
              receivedBytes: 0,
              status: 'waiting',
              senderFingerprint,
            });
            res.writeHead(200, { 'Content-Type': 'application/json' });
            res.end(JSON.stringify({ sessionId, files: Object.keys(files) }));
          } catch (err) {
            res.writeHead(400);
            res.end(JSON.stringify({ error: err.message }));
          }
        });
        return;
      }

      // POST /api/localsend/v2/upload?sessionId=...&fileId=...
      if (req.method === 'POST' && url.pathname === '/api/localsend/v2/upload') {
        const sessionId = url.searchParams.get('sessionId');
        const fileId = url.searchParams.get('fileId');
        const session = this.sessions.get(sessionId);

        if (!session || !session.files[fileId]) {
          res.writeHead(404);
          res.end('Session or file not found');
          return;
        }

        const fileInfo = session.files[fileId];
        // basename: the filename is sender-supplied over an unauthenticated
        // LAN listener, so "../../.ssh/authorized_keys" was an arbitrary write.
        const safeName = basename(String(fileInfo.filename || "")).replace(/^\.+$/, "");
        const filePath = join(this.downloadDir, safeName || `file-${fileId}`);
        const writeStream = createWriteStream(filePath);
        let received = 0;

        req.on('data', chunk => {
          received += chunk.length;
          session.receivedBytes += chunk.length;
        });

        req.pipe(writeStream);

        req.on('end', () => {
          fileInfo.received = received;
          // Check if all files received
          const allDone = Object.values(session.files).every(f => f.received > 0);
          if (allDone && session.receivedBytes >= session.totalBytes) {
            session.status = 'done';
          }
          res.writeHead(200);
          res.end('OK');
        });
        return;
      }

      // GET /api/localsend/v2/cancel?sessionId=...
      if (req.method === 'GET' && url.pathname === '/api/localsend/v2/cancel') {
        const sessionId = url.searchParams.get('sessionId');
        if (sessionId) {
          const session = this.sessions.get(sessionId);
          if (session) session.status = 'cancelled';
        }
        res.writeHead(200);
        res.end('OK');
        return;
      }

      res.writeHead(404);
      res.end('Not found');
    });

    this.server.listen(this.port);
  }

  stop() {
    if (this.server) this.server.close();
  }
}

/**
 * File sender — connect to a peer and send files.
 */
export async function sendFiles(peerIp, peerPort, files, opts = {}) {
  const info = {
    sender: {
      alias: opts.alias || 'PocketDesk',
      fingerprint: opts.fingerprint || crypto.randomBytes(16).toString('hex'),
    },
    files: {},
  };

  for (let i = 0; i < files.length; i++) {
    const stat = statSync(files[i]);
    info.files[String(i)] = {
      id: String(i),
      filename: basename(files[i]),
      size: stat.size,
      fileType: 'application/octet-stream',
    };
  }

  // Step 1: Prepare upload
  const prepareRes = await fetch(`http://${peerIp}:${peerPort}/api/localsend/v2/prepare-upload`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ info }),
  });
  const { sessionId, files: fileIds } = await prepareRes.json();

  // Step 2: Upload each file
  for (let i = 0; i < files.length; i++) {
    const fileId = fileIds[i];
    const fileStream = createReadStream(files[i]);
    await fetch(`http://${peerIp}:${peerPort}/api/localsend/v2/upload?sessionId=${sessionId}&fileId=${fileId}`, {
      method: 'POST',
      body: fileStream,
      duplex: 'half',
    });
  }

  return { sessionId, fileCount: files.length };
}

/**
 * Get local IP addresses (non-internal).
 */
export function getLocalIPs() {
  const interfaces = networkInterfaces();
  const ips = [];
  for (const name of Object.keys(interfaces)) {
    for (const iface of interfaces[name]) {
      if (!iface.internal && iface.family === 'IPv4') {
        ips.push(iface.address);
      }
    }
  }
  return ips;
}
