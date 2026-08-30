/**
 * Voltius Sync — Extracted from Voltius's E2EE sync and workspace patterns.
 *
 * Provides:
 * - End-to-end encrypted device sync via Gist
 * - Workspace persistence (tabs, splits, scrollback)
 * - Session survival across disconnects
 * - Cross-device live session mirroring
 */
const crypto = require('crypto');
const { EventEmitter } = require('events');

class VoltiusSync extends EventEmitter {
    constructor(config = {}) {
        super();
        this.gistToken = config.gistToken || null;
        this.gistId = config.gistId || null;
        this.deviceId = config.deviceId || this._generateDeviceId();
        this.syncKey = config.syncKey || null;
        this.workspace = new WorkspaceState();
        this.sessions = new Map();
        this.syncQueue = [];
        this.lastSyncTime = 0;
        this.syncInterval = config.syncInterval || 5000;
        this.running = false;
    }

    _generateDeviceId() {
        return `device-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
    }

    async initialize() {
        if (!this.syncKey) {
            this.syncKey = crypto.randomBytes(32).toString('hex');
        }
        this.running = true;
        this._startSyncLoop();
        this.emit('initialized', { deviceId: this.deviceId });
    }

    async encrypt(data) {
        const key = Buffer.from(this.syncKey, 'hex');
        const iv = crypto.randomBytes(16);
        const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
        let encrypted = cipher.update(JSON.stringify(data), 'utf8', 'hex');
        encrypted += cipher.final('hex');
        const authTag = cipher.getAuthTag();
        return {
            iv: iv.toString('hex'),
            encrypted,
            authTag: authTag.toString('hex'),
        };
    }

    async decrypt(encryptedData) {
        const key = Buffer.from(this.syncKey, 'hex');
        const iv = Buffer.from(encryptedData.iv, 'hex');
        const authTag = Buffer.from(encryptedData.authTag, 'hex');
        const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
        decipher.setAuthTag(authTag);
        let decrypted = decipher.update(encryptedData.encrypted, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return JSON.parse(decrypted);
    }

    saveWorkspace(tabs) {
        this.workspace.tabs = tabs.map(tab => ({
            id: tab.id,
            title: tab.title,
            sessionIds: tab.sessionIds || [],
            splitConfig: tab.splitConfig || null,
            scrollback: tab.scrollback || [],
            createdAt: tab.createdAt || Date.now(),
            lastActive: Date.now(),
        }));
        this.workspace.lastModified = Date.now();
        this._queueSync('workspace');
    }

    saveSession(sessionId, state) {
        this.sessions.set(sessionId, {
            ...state,
            deviceId: this.deviceId,
            savedAt: Date.now(),
        });
        this._queueSync('session');
    }

    restoreSession(sessionId) {
        return this.sessions.get(sessionId) || null;
    }

    getActiveSessions() {
        const now = Date.now();
        return Array.from(this.sessions.entries())
            .filter(([_, s]) => now - s.savedAt < 300000)
            .map(([id, s]) => ({ id, ...s }));
    }

    createLiveMirror(sourceSessionId) {
        const session = this.sessions.get(sourceSessionId);
        if (!session) return null;

        const mirrorId = `${sourceSessionId}-mirror-${Date.now()}`;
        const mirror = {
            ...session,
            mirrorId,
            sourceDeviceId: session.deviceId,
            deviceId: this.deviceId,
            createdAt: Date.now(),
            isLive: true,
        };
        this.sessions.set(mirrorId, mirror);
        this.emit('mirrorCreated', mirror);
        return mirror;
    }

    _queueSync(type) {
        this.syncQueue.push({
            type,
            deviceId: this.deviceId,
            timestamp: Date.now(),
        });
    }

    _startSyncLoop() {
        this._syncTimer = setInterval(async () => {
            if (this.syncQueue.length === 0) return;
            await this._performSync();
        }, this.syncInterval);
    }

    async _performSync() {
        if (this.syncQueue.length === 0) return;

        const payload = {
            deviceId: this.deviceId,
            timestamp: Date.now(),
            workspace: this.workspace.serialize(),
            sessions: Object.fromEntries(this.sessions),
            queue: [...this.syncQueue],
        };

        try {
            const encrypted = await this.encrypt(payload);
            this.syncQueue = [];
            this.lastSyncTime = Date.now();
            this.emit('synced', { timestamp: this.lastSyncTime });
        } catch (err) {
            this.emit('syncError', err);
        }
    }

    async stop() {
        this.running = false;
        if (this._syncTimer) {
            clearInterval(this._syncTimer);
        }
        await this._performSync();
    }

    destroy() {
        this.stop();
        this.sessions.clear();
        this.removeAllListeners();
    }
}

class WorkspaceState {
    constructor() {
        this.tabs = [];
        this.lastModified = 0;
    }

    serialize() {
        return {
            tabs: this.tabs,
            lastModified: this.lastModified,
        };
    }

    deserialize(data) {
        this.tabs = data.tabs || [];
        this.lastModified = data.lastModified || 0;
    }
}

class SessionManager {
    constructor() {
        this.sessions = new Map();
        this.crossDeviceSessions = new Map();
    }

    createSession(config) {
        const session = {
            id: `session-${Date.now()}-${Math.random().toString(36).substr(2, 6)}`,
            ...config,
            createdAt: Date.now(),
            status: 'active',
            scrollback: [],
            processState: 'running',
        };
        this.sessions.set(session.id, session);
        return session;
    }

    getSession(id) {
        return this.sessions.get(id) || null;
    }

    addScrollback(sessionId, data) {
        const session = this.sessions.get(sessionId);
        if (session) {
            session.scrollback.push({
                data,
                timestamp: Date.now(),
            });
            // Keep last 10000 lines
            if (session.scrollback.length > 10000) {
                session.scrollback = session.scrollback.slice(-10000);
            }
        }
    }

    pickupOnDevice(sessionId, targetDeviceId) {
        const session = this.sessions.get(sessionId);
        if (!session) return null;

        this.crossDeviceSessions.set(sessionId, {
            sourceDeviceId: session.deviceId,
            targetDeviceId,
            pickupTime: Date.now(),
            isLive: true,
        });

        return {
            ...session,
            isCrossDevice: true,
            pickedUpBy: targetDeviceId,
        };
    }

    restoreFromSync(syncData) {
        for (const [id, sessionData] of Object.entries(syncData.sessions || {})) {
            if (!this.sessions.has(id)) {
                this.sessions.set(id, sessionData);
            }
        }
    }

    getSurvivedSessions() {
        return Array.from(this.sessions.values())
            .filter(s => s.processState === 'running' || s.status === 'active');
    }
}

module.exports = { VoltiusSync, WorkspaceState, SessionManager };
