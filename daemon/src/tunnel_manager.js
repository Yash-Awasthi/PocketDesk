/**
 * Tunnel management from cli-tunnel — port forwarding and remote access.
 */
import net from 'node:net';
import crypto from 'node:crypto';
import { EventEmitter } from 'node:events';

class TunnelManager extends EventEmitter {
    constructor(options = {}) {
        super();
        this.tunnels = new Map();
        this.server = null;
        this.port = options.port || 8780;
    }

    /**
     * `bindAll` opens the forwarded port to every interface. Default is
     * loopback: the listener carries no auth of its own, so binding 0.0.0.0
     * handed the whole LAN whatever PC-local service was being forwarded.
     */
    // Resolves only once the listener is bound: callers answer the phone with
    // an id it can connect to immediately, and a bind failure is a rejection.
    createTunnel(localPort, remotePort, { bindAll = false } = {}) {
        const tunnelId = crypto.randomUUID().slice(0, 8);
        const server = net.createServer((socket) => {
            const local = net.connect(localPort, 'localhost', () => {
                socket.pipe(local);
                local.pipe(socket);
            });
            local.on('error', () => socket.destroy());
            socket.on('error', () => local.destroy());
        });

        const host = bindAll ? '0.0.0.0' : '127.0.0.1';
        return new Promise((resolve, reject) => {
            server.once('error', (err) => {
                this.emit('tunnel:error', { tunnelId, error: err.message });
                reject(err);
            });
            server.listen(remotePort, host, () => {
                this.tunnels.set(tunnelId, { localPort, remotePort, host, server, created: Date.now() });
                this.emit('tunnel:created', { tunnelId, localPort, remotePort, host });
                server.on('error', (err) => this.emit('tunnel:error', { tunnelId, error: err.message }));
                resolve(tunnelId);
            });
        });
    }

    closeTunnel(tunnelId) {
        const tunnel = this.tunnels.get(tunnelId);
        if (tunnel) {
            tunnel.server.close();
            this.tunnels.delete(tunnelId);
            this.emit('tunnel:closed', { tunnelId });
        }
    }

    listTunnels() {
        return Array.from(this.tunnels.entries()).map(([id, t]) => ({
            id, localPort: t.localPort, remotePort: t.remotePort, host: t.host, created: t.created,
        }));
    }

    closeAll() {
        for (const [id] of this.tunnels) this.closeTunnel(id);
    }
}

export { TunnelManager };
