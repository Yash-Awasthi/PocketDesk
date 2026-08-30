"""
VNC bridge from novnc patterns — remote desktop access.
"""
const net = require('net');
const EventEmitter = require('events');

class VNCBridge extends EventEmitter {
    constructor(port = 5900) {
        super();
        this.port = port;
        this.server = null;
        this.connections = new Map();
        this.frameBuffer = Buffer.alloc(0);
        this.screenWidth = 1920;
        this.screenHeight = 1080;
    }

    start() {
        this.server = net.createServer((socket) => this.handleConnection(socket));
        this.server.listen(this.port, () => console.log(`VNC bridge on port ${this.port}`));
    }

    handleConnection(socket) {
        const id = `vnc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
        this.connections.set(id, { socket, connectedAt: Date.now() });
        socket.on('data', (data) => this.handleData(id, data));
        socket.on('close', () => this.connections.delete(id));
        socket.on('error', () => this.connections.delete(id));
        this.emit('client:connected', { id });
    }

    handleData(connId, data) {
        const message = data.toString().trim();
        if (message === 'GET_FRAME') {
            const conn = this.connections.get(connId);
            if (conn?.socket.writable) {
                conn.socket.write(JSON.stringify({ width: this.screenWidth, height: this.screenHeight, data: this.frameBuffer.toString('base64') }));
            }
        }
    }

    updateFrame(buffer) {
        this.frameBuffer = buffer;
        const msg = JSON.stringify({ type: 'frame_update', timestamp: Date.now() });
        for (const [, conn] of this.connections) {
            if (conn.socket.writable) conn.socket.write(msg);
        }
    }

    getConnectionCount() { return this.connections.size; }
    stop() { for (const [, conn] of this.connections) conn.socket.destroy(); this.connections.clear(); if (this.server) this.server.close(); }
}

module.exports = { VNCBridge };
