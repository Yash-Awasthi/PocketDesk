/**
 * Relay server from hermes-relay — message relay and forwarding.
 */
const net = require('net');
const crypto = require('crypto');
const EventEmitter = require('events');

class RelayServer extends EventEmitter {
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
        this.connections.set(id, { socket, channels: new Set(), connectedAt: Date.now() });
        socket.on('data', (data) => this.handleMessage(id, data));
        socket.on('close', () => {
            const conn = this.connections.get(id);
            if (conn) { for (const ch of conn.channels) this.leaveChannel(id, ch); }
            this.connections.delete(id);
        });
        socket.on('error', () => this.connections.delete(id));
        socket.write(JSON.stringify({ type: 'connected', id }));
    }

    handleMessage(connId, data) {
        try {
            const msg = JSON.parse(data.toString());
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
        const data = JSON.stringify(message);
        for (const connId of members) {
            const conn = this.connections.get(connId);
            if (conn?.socket.writable) conn.socket.write(data);
        }
    }

    sendTo(connId, message) {
        const conn = this.connections.get(connId);
        if (conn?.socket.writable) conn.socket.write(JSON.stringify(message));
    }

    getConnectionCount() { return this.connections.size; }
    getChannelCount() { return this.channels.size; }

    stop() { for (const [, conn] of this.connections) conn.socket.destroy(); this.connections.clear(); this.channels.clear(); if (this.server) this.server.close(); }
}

module.exports = { RelayServer };
