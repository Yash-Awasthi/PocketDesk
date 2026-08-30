/**
 * Desktop Control Module — Inspired by WhipDesk
 * Full desktop control: screen sharing, clipboard sync, file browser, remote input
 */

class DesktopController {
  constructor(ws, options = {}) {
    this.ws = ws;
    this.screenWidth = options.screenWidth || 1920;
    this.screenHeight = options.screenHeight || 1080;
    this.frameRate = options.frameRate || 30;
    this.jpegQuality = options.jpegQuality || 60;
    this.clipboardSync = options.clipboardSync !== false;
    this.fileBrowserEnabled = options.fileBrowserEnabled !== false;
    this.remoteInputEnabled = options.remoteInputEnabled !== false;
    this.screenSharing = false;
    this.clipboard = '';
    this.clipboardHistory = [];
    this.maxHistory = 50;
    this.captureInterval = null;
    this.eventHandlers = new Map();
    this.on = this.on.bind(this);
    this.emit = this.emit.bind(this);
  }

  on(event, handler) {
    if (!this.eventHandlers.has(event)) {
      this.eventHandlers.set(event, []);
    }
    this.eventHandlers.get(event).push(handler);
    return () => {
      const handlers = this.eventHandlers.get(event);
      if (handlers) {
        const idx = handlers.indexOf(handler);
        if (idx >= 0) handlers.splice(idx, 1);
      }
    };
  }

  emit(event, data) {
    const handlers = this.eventHandlers.get(event);
    if (handlers) {
      handlers.forEach(h => h(data));
    }
  }

  startScreenShare() {
    if (this.screenSharing) return;
    this.screenSharing = true;
    this.captureInterval = setInterval(() => {
      this.captureScreen();
    }, 1000 / this.frameRate);
    this.emit('screen_share_started', { frameRate: this.frameRate });
    return { status: 'started', frameRate: this.frameRate };
  }

  stopScreenShare() {
    if (!this.screenSharing) return;
    this.screenSharing = false;
    if (this.captureInterval) {
      clearInterval(this.captureInterval);
      this.captureInterval = null;
    }
    this.emit('screen_share_stopped', {});
    return { status: 'stopped' };
  }

  captureScreen() {
    const frame = {
      type: 'screen_frame',
      timestamp: Date.now(),
      width: this.screenWidth,
      height: this.screenHeight,
      quality: this.jpegQuality,
      data: null
    };
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify(frame));
    }
    return frame;
  }

  resizeScreen(width, height) {
    this.screenWidth = Math.max(640, Math.min(7680, width));
    this.screenHeight = Math.max(480, Math.min(4320, height));
    this.emit('screen_resized', { width: this.screenWidth, height: this.screenHeight });
    return { width: this.screenWidth, height: this.screenHeight };
  }

  setQuality(quality) {
    this.jpegQuality = Math.max(10, Math.min(100, quality));
    this.emit('quality_changed', { quality: this.jpegQuality });
    return { quality: this.jpegQuality };
  }

  syncClipboard(text) {
    if (!this.clipboardSync) return null;
    if (text === this.clipboard) return null;
    this.clipboard = text;
    this.clipboardHistory.unshift({ text, timestamp: Date.now() });
    if (this.clipboardHistory.length > this.maxHistory) {
      this.clipboardHistory.pop();
    }
    if (this.ws && this.ws.readyState === 1) {
      this.ws.send(JSON.stringify({ type: 'clipboard_sync', text }));
    }
    this.emit('clipboard_synced', { text });
    return { synced: true, historyLength: this.clipboardHistory.length };
  }

  getClipboardHistory() {
    return this.clipboardHistory;
  }

  clearClipboardHistory() {
    this.clipboardHistory = [];
    return { cleared: true };
  }

  async listDirectory(path, options = {}) {
    if (!this.fileBrowserEnabled) {
      return { error: 'File browser disabled' };
    }
    const maxDepth = options.maxDepth || 1;
    const maxItems = options.maxItems || 100;
    const showHidden = options.showHidden || false;

    return {
      path,
      maxDepth,
      maxItems,
      showHidden,
      entries: [],
      timestamp: Date.now()
    };
  }

  async readFile(path, options = {}) {
    if (!this.fileBrowserEnabled) {
      return { error: 'File browser disabled' };
    }
    const maxBytes = options.maxBytes || 1048576;
    return {
      path,
      content: null,
      truncated: false,
      size: 0,
      timestamp: Date.now()
    };
  }

  sendMouseEvent(x, y, button, eventType) {
    if (!this.remoteInputEnabled) {
      return { error: 'Remote input disabled' };
    }
    const event = {
      type: 'mouse_event',
      x: Math.max(0, Math.min(this.screenWidth, x)),
      y: Math.max(0, Math.min(this.screenHeight, y)),
      button,
      eventType,
      timestamp: Date.now()
    };
    this.emit('mouse_event', event);
    return { sent: true };
  }

  sendKeyboardEvent(keyCode, key, eventType, modifiers = {}) {
    if (!thisremoteInputEnabled) {
      return { error: 'Remote input disabled' };
    }
    const event = {
      type: 'keyboard_event',
      keyCode,
      key,
      eventType,
      modifiers: {
        ctrl: modifiers.ctrl || false,
        shift: modifiers.shift || false,
        alt: modifiers.alt || false,
        meta: modifiers.meta || false
      },
      timestamp: Date.now()
    };
    this.emit('keyboard_event', event);
    return { sent: true };
  }

  getStatus() {
    return {
      screenSharing: this.screenSharing,
      frameRate: this.frameRate,
      resolution: `${this.screenWidth}x${this.screenHeight}`,
      quality: this.jpegQuality,
      clipboardSync: this.clipboardSync,
      fileBrowser: this.fileBrowserEnabled,
      remoteInput: thisremoteInputEnabled,
      clipboardHistoryLength: this.clipboardHistory.length
    };
  }

  destroy() {
    this.stopScreenShare();
    this.eventHandlers.clear();
  }
}

class DesktopSession {
  constructor(options = {}) {
    this.controller = new DesktopController(null, options);
    this.scheduledPrompts = [];
    this.agentAlerts = [];
    this.connectionHistory = [];
    this.reconnectAttempts = 0;
    this.maxReconnects = 10;
    this.reconnectDelay = 1000;
    this.pingInterval = null;
    this.lastPong = Date.now();
  }

  connect(ws) {
    this.controller.ws = ws;
    this.connectionHistory.push({
      connectedAt: Date.now(),
      userAgent: null,
      ip: null
    });
    this.startPing();
    return { status: 'connected' };
  }

  disconnect() {
    this.stopPing();
    this.controller.stopScreenShare();
    return { status: 'disconnected' };
  }

  startPing() {
    this.pingInterval = setInterval(() => {
      if (this.controller.ws && this.controller.ws.readyState === 1) {
        this.controller.ws.send(JSON.stringify({ type: 'ping', timestamp: Date.now() }));
      }
    }, 5000);
  }

  stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }

  handlePong() {
    this.lastPong = Date.now();
    this.reconnectAttempts = 0;
  }

  schedulePrompt(prompt, schedule) {
    const entry = {
      id: `sp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      prompt,
      schedule,
      createdAt: Date.now(),
      status: 'pending',
      lastRun: null,
      runCount: 0
    };
    this.scheduledPrompts.push(entry);
    return entry;
  }

  cancelScheduledPrompt(id) {
    const idx = this.scheduledPrompts.findIndex(p => p.id === id);
    if (idx >= 0) {
      this.scheduledPrompts[idx].status = 'cancelled';
      return { cancelled: true };
    }
    return { cancelled: false, error: 'Not found' };
  }

  getScheduledPrompts() {
    return this.scheduledPrompts;
  }

  addAgentAlert(alert) {
    const entry = {
      id: `alert_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`,
      message: alert.message || 'Unknown alert',
      severity: alert.severity || 'info',
      agentName: alert.agentName || 'unknown',
      timestamp: Date.now(),
      acknowledged: false
    };
    this.agentAlerts.push(entry);
    if (this.controller.ws && this.controller.ws.readyState === 1) {
      this.controller.ws.send(JSON.stringify({ type: 'agent_alert', alert: entry }));
    }
    return entry;
  }

  acknowledgeAlert(id) {
    const alert = this.agentAlerts.find(a => a.id === id);
    if (alert) {
      alert.acknowledged = true;
      return { acknowledged: true };
    }
    return { acknowledged: false, error: 'Not found' };
  }

  getAgentAlerts(includeAcknowledged = false) {
    if (includeAcknowledged) return this.agentAlerts;
    return this.agentAlerts.filter(a => !a.acknowledged);
  }

  getStatus() {
    return {
      connected: this.controller.ws && this.controller.ws.readyState === 1,
      screenSharing: this.controller.screenSharing,
      scheduledPrompts: this.scheduledPrompts.filter(p => p.status === 'pending').length,
      activeAlerts: this.agentAlerts.filter(a => !a.acknowledged).length,
      reconnectAttempts: this.reconnectAttempts,
      lastPong: this.lastPong,
      uptime: this.connectionHistory.length > 0
        ? Date.now() - this.connectionHistory[this.connectionHistory.length - 1].connectedAt
        : 0
    };
  }

  destroy() {
    this.stopPing();
    this.controller.destroy();
    this.scheduledPrompts = [];
    this.agentAlerts = [];
    this.connectionHistory = [];
  }
}

module.exports = { DesktopController, DesktopSession };
