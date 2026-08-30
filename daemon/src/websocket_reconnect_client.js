/**
 * WebSocket Client with Auto-Reconnect
 * Extracted from: client-kt (Kotlin WebSocket client with exponential backoff)
 * Patterns: Auto-reconnection, exponential backoff with jitter,
 *           transport drop vs permanent disconnect, coroutine-native async,
 *           configurable retry limits, message wire format
 */

const EventEmitter = require('events');

class WebSocketReconnectClient extends EventEmitter {
  constructor(config = {}) {
    super();
    this.url = config.url;
    this.maxRetries = config.maxRetries || 10;
    this.baseDelay = config.baseDelay || 1000; // ms
    this.maxDelay = config.maxDelay || 30000; // ms
    this.jitter = config.jitter !== false;
    this.protocols = config.protocols || [];
    this.headers = config.headers || {};

    this.state = 'disconnected';
    this.retryCount = 0;
    this.ws = null;
    this.messageQueue = [];
    this.reconnectTimer = null;
    this.pingInterval = null;
    this.lastPong = 0;
    this.pingTimeout = config.pingTimeout || 30000;
  }

  /**
   * Connect to WebSocket server
   */
  connect() {
    if (this.state === 'connected' || this.state === 'connecting') return;

    this.state = 'connecting';
    this.emit('state', this.state);

    try {
      // Node.js WebSocket (ws package)
      const WebSocket = require('ws');
      this.ws = new WebSocket(this.url, this.protocols, { headers: this.headers });

      this.ws.on('open', () => {
        this.state = 'connected';
        this.retryCount = 0;
        this.lastPong = Date.now();
        this.emit('state', this.state);
        this.emit('connected');

        // Flush queued messages
        while (this.messageQueue.length > 0) {
          const msg = this.messageQueue.shift();
          this.send(msg);
        }

        // Start ping/pong
        this._startPing();
      });

      this.ws.on('message', (data) => {
        try {
          const parsed = JSON.parse(data.toString());
          this.emit('message', parsed);

          if (parsed.type === 'pong') {
            this.lastPong = Date.now();
          }
        } catch {
          this.emit('rawMessage', data);
        }
      });

      this.ws.on('close', (code, reason) => {
        this._stopPing();
        const isPermanent = code === 1000 || code === 1001;

        if (isPermanent) {
          this.state = 'disconnected';
          this.emit('state', this.state);
          this.emit('disconnected', { code, reason: reason.toString(), permanent: true });
        } else {
          this.state = 'reconnecting';
          this.emit('state', this.state);
          this.emit('disconnected', { code, reason: reason.toString(), permanent: false });
          this._scheduleReconnect();
        }
      });

      this.ws.on('error', (error) => {
        this.emit('error', error);
        if (this.state !== 'connected') {
          this._scheduleReconnect();
        }
      });

      this.ws.on('pong', () => {
        this.lastPong = Date.now();
      });
    } catch (error) {
      this.state = 'error';
      this.emit('state', this.state);
      this.emit('error', error);
      this._scheduleReconnect();
    }
  }

  /**
   * Send a message (queues if not connected)
   */
  send(data) {
    const message = typeof data === 'string' ? data : JSON.stringify(data);

    if (this.state === 'connected' && this.ws && this.ws.readyState === 1) {
      this.ws.send(message);
      return true;
    }

    this.messageQueue.push(data);
    return false;
  }

  /**
   * Disconnect permanently
   */
  disconnect() {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this._stopPing();
    this.state = 'disconnected';
    this.retryCount = this.maxRetries; // Prevent reconnect

    if (this.ws) {
      this.ws.close(1000, 'Client disconnect');
    }
    this.emit('state', this.state);
  }

  /**
   * Get connection status
   */
  getStatus() {
    return {
      state: this.state,
      url: this.url,
      retryCount: this.retryCount,
      maxRetries: this.maxRetries,
      queuedMessages: this.messageQueue.length,
      lastPong: this.lastPong,
      uptime: this.state === 'connected' ? Date.now() - (this._connectedAt || Date.now()) : 0,
    };
  }

  _scheduleReconnect() {
    if (this.retryCount >= this.maxRetries) {
      this.state = 'failed';
      this.emit('state', this.state);
      this.emit('failed', { retryCount: this.retryCount });
      return;
    }

    const delay = this._calculateDelay();
    this.retryCount++;

    this.emit('reconnecting', { attempt: this.retryCount, delay });

    this.reconnectTimer = setTimeout(() => {
      this.connect();
    }, delay);
  }

  _calculateDelay() {
    let delay = this.baseDelay * Math.pow(2, this.retryCount);
    delay = Math.min(delay, this.maxDelay);

    if (this.jitter) {
      // Equal jitter: delay = delay/2 + random(0, delay/2)
      delay = delay / 2 + Math.random() * (delay / 2);
    }

    return Math.round(delay);
  }

  _startPing() {
    this.pingInterval = setInterval(() => {
      if (this.state === 'connected') {
        // Check pong timeout
        if (Date.now() - this.lastPong > this.pingTimeout) {
          this.ws.terminate();
          return;
        }
        this.send({ type: 'ping', timestamp: Date.now() });
      }
    }, this.pingTimeout / 3);
  }

  _stopPing() {
    if (this.pingInterval) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}

module.exports = { WebSocketReconnectClient };
