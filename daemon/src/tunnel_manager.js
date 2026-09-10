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

    createTunnel(localPort, remotePort) {
        const tunnelId = crypto.randomUUID().slice(0, 8);
        const server = net.createServer((socket) => {
            const local = net.connect(localPort, 'localhost', () => {
                socket.pipe(local);
                local.pipe(socket);
            });
            local.on('error', () => socket.destroy());
            socket.on('error', () => local.destroy());
        });

        server.listen(remotePort, () => {
            this.tunnels.set(tunnelId, { localPort, remotePort, server, created: Date.now() });
            this.emit('tunnel:created', { tunnelId, localPort, remotePort });
        });

        server.on('error', (err) => {
            this.emit('tunnel:error', { tunnelId, error: err.message });
        });

        return tunnelId;
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
            id, localPort: t.localPort, remotePort: t.remotePort, created: t.created,
        }));
    }

    closeAll() {
        for (const [id] of this.tunnels) this.closeTunnel(id);
    }
}

export { TunnelManager };
