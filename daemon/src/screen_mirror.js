/**
 * Screen Mirror — Extracted from ws-scrcpy patterns.
 *
 * Web-based device screen mirroring with:
 * - WebSocket video streaming
 * - Touch/mouse input forwarding
 * - Device discovery and management
 * - Multi-device support
 * - Resolution and quality control
 */
const { EventEmitter } = require('events');

class ScreenMirror extends EventEmitter {
    constructor(config = {}) {
        super();
        this.devices = new Map();
        this.streams = new Map();
        this.config = {
            maxDevices: config.maxDevices || 10,
            defaultResolution: config.defaultResolution || { width: 1280, height: 720 },
            maxFps: config.maxFps || 30,
            ...config,
        };
    }

    registerDevice(deviceInfo) {
        const device = {
            id: deviceInfo.id || `device-${Date.now()}`,
            name: deviceInfo.name || 'Unknown Device',
            type: deviceInfo.type || 'android',
            resolution: deviceInfo.resolution || this.config.defaultResolution,
            status: 'registered',
            lastSeen: Date.now(),
            capabilities: deviceInfo.capabilities || {
                screenCapture: true,
                inputForward: true,
                audioForward: false,
            },
        };
        this.devices.set(device.id, device);
        this.emit('deviceRegistered', device);
        return device;
    }

    unregisterDevice(deviceId) {
        this.stopStream(deviceId);
        this.devices.delete(deviceId);
        this.emit('deviceUnregistered', deviceId);
    }

    getDevice(deviceId) {
        return this.devices.get(deviceId) || null;
    }

    listDevices() {
        return Array.from(this.devices.values());
    }

    startStream(deviceId, options = {}) {
        const device = this.devices.get(deviceId);
        if (!device) throw new Error(`Device ${deviceId} not found`);

        const stream = {
            deviceId,
            resolution: options.resolution || device.resolution,
            fps: options.fps || this.config.maxFps,
            quality: options.quality || 80,
            encoding: options.encoding || 'h264',
            startTime: Date.now(),
            bytesTransferred: 0,
            frameCount: 0,
            clients: new Set(),
        };

        this.streams.set(deviceId, stream);
        device.status = 'streaming';
        this.emit('streamStarted', { deviceId, stream });
        return stream;
    }

    stopStream(deviceId) {
        const stream = this.streams.get(deviceId);
        if (!stream) return;

        const device = this.devices.get(deviceId);
        if (device) device.status = 'connected';

        this.streams.delete(deviceId);
        this.emit('streamStopped', { deviceId });
    }

    addClient(deviceId, clientId) {
        const stream = this.streams.get(deviceId);
        if (!stream) return false;
        stream.clients.add(clientId);
        this.emit('clientAdded', { deviceId, clientId });
        return true;
    }

    removeClient(deviceId, clientId) {
        const stream = this.streams.get(deviceId);
        if (!stream) return;
        stream.clients.delete(clientId);
        this.emit('clientRemoved', { deviceId, clientId });
    }

    sendTouchEvent(deviceId, touchEvent) {
        const device = this.devices.get(deviceId);
        if (!device || !device.capabilities.inputForward) return false;

        this.emit('touchEvent', {
            deviceId,
            type: touchEvent.type,
            x: touchEvent.x,
            y: touchEvent.y,
            pointerId: touchEvent.pointerId || 0,
            timestamp: Date.now(),
        });
        return true;
    }

    sendKeyEvent(deviceId, keyEvent) {
        const device = this.devices.get(deviceId);
        if (!device || !device.capabilities.inputForward) return false;

        this.emit('keyEvent', {
            deviceId,
            keyCode: keyEvent.keyCode,
            action: keyEvent.action,
            timestamp: Date.now(),
        });
        return true;
    }

    sendClipboardText(deviceId, text) {
        this.emit('clipboard', { deviceId, text, timestamp: Date.now() });
        return true;
    }

    resizeStream(deviceId, width, height) {
        const stream = this.streams.get(deviceId);
        if (!stream) return false;

        stream.resolution = { width, height };
        this.emit('streamResized', { deviceId, width, height });
        return true;
    }

    getStreamStats(deviceId) {
        const stream = this.streams.get(deviceId);
        if (!stream) return null;

        const elapsed = (Date.now() - stream.startTime) / 1000;
        return {
            deviceId,
            duration: elapsed,
            fps: stream.frameCount / Math.max(elapsed, 1),
            bytesTransferred: stream.bytesTransferred,
            clientCount: stream.clients.size,
            resolution: stream.resolution,
        };
    }

    captureScreenshot(deviceId) {
        const device = this.devices.get(deviceId);
        if (!device) return null;

        this.emit('screenshotRequest', { deviceId, timestamp: Date.now() });
        return { deviceId, timestamp: Date.now(), status: 'requested' };
    }
}

module.exports = { ScreenMirror };
