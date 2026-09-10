/**
 * Relay server from hermes-relay — message relay and forwarding.
 *
 * Small TCP pub/sub relay: clients connect, subscribe to a channel, and either
 * publish (broadcast to channel members) or direct-message a specific peer.
 * Ported to ESM so it loads under the daemon's `"type": "module"` package.
 */
import net from "node:net";
import crypto from "node:crypto";
import { EventEmitter } from "node:events";

export class RelayServer extends EventEmitter {
    constructor(port = 8790) {
        super();
        this.port = port;
        this.server = null;
        this.connections = new Map();
        this.channels = new Map();
    }

    start() {
        this.server = net.createServer((socket) => this.handleConnection(socket));
        this.server.listen(this.port, () => console.log(`Relay on port ${this.port}`));
    }

    handleConnection(socket) {
        const id = crypto.randomUUID().slice(0, 8);
        this.connections.set(id, { socket, channels: new Set(), connectedAt: Date.now(), buf: '' });
        socket.on('data', (data) => this.handleData(id, data));
        socket.on('close', () => {
            const conn = this.connections.get(id);
            if (conn) { for (const ch of conn.channels) this.leaveChannel(id, ch); }
            this.connections.delete(id);
        });
        socket.on('error', () => this.connections.delete(id));
        // Newline-terminated framing: a full frame can arrive split across
        // several TCP segments, or several frames can arrive in one chunk.
        socket.write(JSON.stringify({ type: 'connected', id }) + '\n');
    }

    handleData(connId, data) {
        const conn = this.connections.get(connId);
        if (!conn) return;
        conn.buf += data.toString();
        for (;;) {
            const nl = conn.buf.indexOf('\n');
            if (nl < 0) break;
            const line = conn.buf.slice(0, nl).trim();
            conn.buf = conn.buf.slice(nl + 1);
            if (line) this.handleMessage(connId, line);
        }
        // Tolerant fallback: a client that writes one JSON frame without a
        // trailing newline (old protocol) still gets parsed.
        if (conn.buf.trim()) {
            try {
                this.handleMessage(connId, conn.buf.trim());
                conn.buf = '';
            } catch {}
        }
    }

    handleMessage(connId, line) {
        try {
            const msg = JSON.parse(line);
            switch (msg.type) {
                case 'subscribe': this.joinChannel(connId, msg.channel); break;
                case 'unsubscribe': this.leaveChannel(connId, msg.channel); break;
                case 'publish': this.broadcast(msg.channel, { type: 'message', channel: msg.channel, data: msg.data, from: connId }); break;
                case 'direct': this.sendTo(msg.to, { type: 'direct', data: msg.data, from: connId }); break;
            }
        } catch {}
    }

    joinChannel(connId, channel) {
        if (!this.channels.has(channel)) this.channels.set(channel, new Set());
        this.channels.get(channel).add(connId);
        const conn = this.connections.get(connId);
        if (conn) conn.channels.add(channel);
    }

    leaveChannel(connId, channel) {
        this.channels.get(channel)?.delete(connId);
        this.connections.get(connId)?.channels.delete(channel);
    }

    broadcast(channel, message) {
        const members = this.channels.get(channel);
        if (!members) return;
        const data = JSON.stringify(message) + '\n';
        for (const connId of members) {
            const conn = this.connections.get(connId);
            if (conn?.socket.writable) conn.socket.write(data);
        }
    }

    sendTo(connId, message) {
        const conn = this.connections.get(connId);
        if (conn?.socket.writable) conn.socket.write(JSON.stringify(message) + '\n');
    }

    getConnectionCount() { return this.connections.size; }
    getChannelCount() { return this.channels.size; }

    stop() { for (const [, conn] of this.connections) conn.socket.destroy(); this.connections.clear(); this.channels.clear(); if (this.server) this.server.close(); }
}