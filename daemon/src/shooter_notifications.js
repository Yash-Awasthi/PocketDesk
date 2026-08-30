/**
 * Shooter Notifications — Extracted from Shooter patterns.
 *
 * Smart notification system with:
 * - Decision-first delivery (permission requests, questions)
 * - Per-project coalescing
 * - Smart-idle gate (filter internal events)
 * - Notification telemetry (sent/coalesced/dropped/failed)
 * - Multi-platform delivery (APNs, FCM, Web Push)
 * - Burst detection
 */
const { EventEmitter } = require('events');

class ShooterNotifications extends EventEmitter {
    constructor(config = {}) {
        super();
        this.telemetry = [];
        this.pendingNotifications = new Map();
        this.projectBursts = new Map();
        this.config = {
            coalesceWindowMs: config.coalesceWindowMs || 5000,
            dedupWindowMs: config.dedupWindowMs || 10000,
            maxTelemetryEntries: config.maxTelemetryEntries || 10000,
            channels: config.channels || ['web'],
        };
        this._idlePatterns = [
            'teammate idle',
            'review in progress',
            'background task',
            'heartbeat',
        ];
    }

    shouldNotify(event) {
        // Smart-idle gate: filter internal events
        const text = (event.text || '').toLowerCase();
        for (const pattern of this._idlePatterns) {
            if (text.includes(pattern)) {
                return { send: false, reason: 'idle_gated' };
            }
        }

        // Decision-first: always send permission requests and questions
        if (event.type === 'permission_request' || event.type === 'ask_user') {
            return { send: true, priority: 'high' };
        }

        // Check dedup
        const dedupKey = `${event.projectId}:${event.type}:${event.text}`;
        const lastSent = this.pendingNotifications.get(dedupKey);
        if (lastSent && Date.now() - lastSent < this.config.dedupWindowMs) {
            return { send: false, reason: 'deduplicated' };
        }

        return { send: true, priority: 'normal' };
    }

    sendNotification(event) {
        const decision = this.shouldNotify(event);
        if (!decision.send) {
            this._recordTelemetry(event, 'dropped', decision.reason);
            return { sent: false, reason: decision.reason };
        }

        // Per-project coalescing
        const projectId = event.projectId || 'default';
        const burst = this.projectBursts.get(projectId) || { events: [], lastSent: 0 };

        if (decision.priority !== 'high' && burst.events.length > 0) {
            burst.events.push(event);
            if (Date.now() - burst.lastSent < this.config.coalesceWindowMs) {
                this._recordTelemetry(event, 'coalesced');
                return { sent: false, reason: 'coalesced' };
            }
        }

        // Send the notification
        burst.events = [];
        burst.lastSent = Date.now();
        this.projectBursts.set(projectId, burst);

        const dedupKey = `${projectId}:${event.type}:${event.text}`;
        this.pendingNotifications.set(dedupKey, Date.now());

        this._recordTelemetry(event, 'sent');
        this.emit('notification', event);

        // Multi-platform delivery
        for (const channel of this.config.channels) {
            this._sendToChannel(channel, event);
        }

        return { sent: true, priority: decision.priority };
    }

    _sendToChannel(channel, event) {
        switch (channel) {
            case 'web':
                this.emit('web_push', event);
                break;
            case 'apns':
                this.emit('apns_push', event);
                break;
            case 'fcm':
                this.emit('fcm_push', event);
                break;
        }
    }

    _recordTelemetry(event, status, reason = null) {
        this.telemetry.push({
            timestamp: Date.now(),
            projectId: event.projectId,
            type: event.type,
            status,
            reason,
        });

        // Trim old entries
        if (this.telemetry.length > this.config.maxTelemetryEntries) {
            this.telemetry = this.telemetry.slice(-this.config.maxTelemetryEntries);
        }
    }

    getTelemetryStats() {
        const stats = {
            total: this.telemetry.length,
            sent: 0,
            coalesced: 0,
            dropped: 0,
            failed: 0,
            byProject: {},
            byType: {},
        };

        for (const entry of this.telemetry) {
            stats[entry.status] = (stats[entry.status] || 0) + 1;

            const projectKey = entry.projectId || 'default';
            if (!stats.byProject[projectKey]) {
                stats.byProject[projectKey] = { sent: 0, coalesced: 0, dropped: 0 };
            }
            stats.byProject[projectKey][entry.status] =
                (stats.byProject[projectKey][entry.status] || 0) + 1;

            stats.byType[entry.type] = (stats.byType[entry.type] || 0) + 1;
        }

        return stats;
    }

    detectBursts(windowMs = 60000) {
        const now = Date.now();
        const recent = this.telemetry.filter(t => now - t.timestamp < windowMs);
        const byProject = {};

        for (const entry of recent) {
            const key = entry.projectId || 'default';
            byProject[key] = (byProject[key] || 0) + 1;
        }

        return Object.entries(byProject)
            .filter(([_, count]) => count > 5)
            .map(([projectId, count]) => ({ projectId, count, severity: count > 20 ? 'high' : 'medium' }));
    }

    clearTelemetry() {
        this.telemetry = [];
    }
}

module.exports = { ShooterNotifications };
