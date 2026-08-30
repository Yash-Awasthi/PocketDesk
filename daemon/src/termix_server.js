/**
 * Termix Server — Extracted from Termix patterns.
 *
 * Self-hosted server management with:
 * - SSH connection management
 * - Remote desktop streaming
 * - Automation scheduling
 * - Database-backed configuration
 */
const { EventEmitter } = require('events');
const crypto = require('crypto');

class TermixServer extends EventEmitter {
    constructor(config = {}) {
        super();
        this.hosts = new Map();
        this.sessions = new Map();
        this.automations = new Map();
        this.config = {
            maxConnections: config.maxConnections || 100,
            sessionTimeout: config.sessionTimeout || 3600000,
            sshPort: config.sshPort || 22,
            ...config,
        };
    }

    addHost(hostConfig) {
        const host = {
            id: hostConfig.id || `host-${Date.now()}`,
            name: hostConfig.name,
            hostname: hostConfig.hostname,
            port: hostConfig.port || this.config.sshPort,
            username: hostConfig.username,
            authMethod: hostConfig.authMethod || 'key',
            groups: hostConfig.groups || [],
            tags: hostConfig.tags || [],
            lastConnected: null,
            status: 'disconnected',
            metadata: {
                os: hostConfig.os || 'unknown',
                arch: hostConfig.arch || 'x86_64',
                uptime: 0,
            },
        };
        this.hosts.set(host.id, host);
        this.emit('hostAdded', host);
        return host;
    }

    removeHost(hostId) {
        const host = this.hosts.get(hostId);
        if (!host) return false;

        // Disconnect any active sessions
        for (const [sessionId, session] of this.sessions) {
            if (session.hostId === hostId) {
                this.closeSession(sessionId);
            }
        }

        this.hosts.delete(hostId);
        this.emit('hostRemoved', hostId);
        return true;
    }

    getHost(hostId) {
        return this.hosts.get(hostId) || null;
    }

    listHosts(filters = {}) {
        let hosts = Array.from(this.hosts.values());

        if (filters.group) {
            hosts = hosts.filter(h => h.groups.includes(filters.group));
        }
        if (filters.tag) {
            hosts = hosts.filter(h => h.tags.includes(filters.tag));
        }
        if (filters.status) {
            hosts = hosts.filter(h => h.status === filters.status);
        }

        return hosts;
    }

    createSession(hostId, options = {}) {
        const host = this.hosts.get(hostId);
        if (!host) throw new Error(`Host ${hostId} not found`);

        if (this.sessions.size >= this.config.maxConnections) {
            throw new Error('Max connections reached');
        }

        const session = {
            id: `session-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
            hostId,
            type: options.type || 'ssh',
            status: 'connecting',
            createdAt: Date.now(),
            lastActivity: Date.now(),
            scrollback: [],
            pty: options.pty || { cols: 80, rows: 24 },
        };

        this.sessions.set(session.id, session);
        host.status = 'connected';
        host.lastConnected = Date.now();

        this.emit('sessionCreated', session);
        return session;
    }

    closeSession(sessionId) {
        const session = this.sessions.get(sessionId);
        if (!session) return false;

        session.status = 'closed';
        const host = this.hosts.get(session.hostId);
        if (host) {
            host.status = 'disconnected';
        }

        this.sessions.delete(sessionId);
        this.emit('sessionClosed', session);
        return true;
    }

    getSession(sessionId) {
        return this.sessions.get(sessionId) || null;
    }

    writeToSession(sessionId, data) {
        const session = this.sessions.get(sessionId);
        if (!session) return false;

        session.lastActivity = Date.now();
        session.scrollback.push({
            data,
            timestamp: Date.now(),
            direction: 'input',
        });

        // Keep last 10000 lines
        if (session.scrollback.length > 10000) {
            session.scrollback = session.scrollback.slice(-10000);
        }

        this.emit('sessionData', { sessionId, data });
        return true;
    }

    resizeSession(sessionId, cols, rows) {
        const session = this.sessions.get(sessionId);
        if (!session) return false;
        session.pty = { cols, rows };
        this.emit('sessionResized', { sessionId, cols, rows });
        return true;
    }

    createAutomation(config) {
        const automation = {
            id: config.id || `auto-${Date.now()}`,
            name: config.name,
            hostId: config.hostId,
            schedule: config.schedule,
            commands: config.commands || [],
            enabled: config.enabled !== false,
            lastRun: null,
            nextRun: null,
        };
        this.automations.set(automation.id, automation);
        return automation;
    }

    getStats() {
        return {
            totalHosts: this.hosts.size,
            activeSessions: this.sessions.size,
            connectedHosts: Array.from(this.hosts.values()).filter(h => h.status === 'connected').length,
            automations: this.automations.size,
            uptime: process.uptime(),
        };
    }

    cleanupStaleSessions() {
        const now = Date.now();
        const stale = [];
        for (const [id, session] of this.sessions) {
            if (now - session.lastActivity > this.config.sessionTimeout) {
                stale.push(id);
            }
        }
        for (const id of stale) {
            this.closeSession(id);
        }
        return stale.length;
    }
}

module.exports = { TermixServer };
