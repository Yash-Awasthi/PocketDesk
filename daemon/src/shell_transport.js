/**
 * Shell Transport
 *
 * Extracted from bitbang-cli (inspiration).
 * WebSocket-based shell transport with tag-byte protocol for
 * stdin/stdout/stderr routing, resize events, and signal handling.
 */

// --- Constants ---

const TAG_STDIN = 0;
const TAG_STDOUT = 1;
const TAG_STDERR = 2;
const TAG_SIGNAL = 3;
const TAG_RESIZE = 4;

// --- Frame Creation ---

export function createStdinFrame(data) {
  const bytes = new TextEncoder().encode(data);
  const buf = new Uint8Array(1 + bytes.length);
  buf[0] = TAG_STDIN;
  buf.set(bytes, 1);
  return buf;
}

export function createSignalFrame(signal) {
  const bytes = new TextEncoder().encode(signal);
  const buf = new Uint8Array(1 + bytes.length);
  buf[0] = TAG_SIGNAL;
  buf.set(bytes, 1);
  return buf;
}

export function createResizeFrame(cols, rows) {
  const buf = new Uint8Array(5);
  buf[0] = TAG_RESIZE;
  buf[1] = (cols >> 8) & 0xff;
  buf[2] = cols & 0xff;
  buf[3] = (rows >> 8) & 0xff;
  buf[4] = rows & 0xff;
  return buf;
}

// --- Frame Parsing ---

export function parseFrame(data) {
  if (!data || data.byteLength < 1) return null;

  const view = data instanceof ArrayBuffer ? new Uint8Array(data) : data;
  const tag = view[0];
  const body = view.subarray(1);

  switch (tag) {
    case TAG_STDOUT:
    case TAG_STDERR:
      return {
        type: tag === TAG_STDOUT ? 'stdout' : 'stderr',
        data: new TextDecoder().decode(body),
      };
    case TAG_RESIZE:
      if (body.byteLength >= 4) {
        return {
          type: 'resize',
          cols: (body[0] << 8) | body[1],
          rows: (body[2] << 8) | body[3],
        };
      }
      return null;
    case TAG_SIGNAL:
      return {
        type: 'signal',
        signal: new TextDecoder().decode(body),
      };
    default:
      return null;
  }
}

// --- Connection Manager ---

export class ShellConnection {
  constructor(url, options = {}) {
    this.url = url;
    this.ws = null;
    this.handlers = {
      stdout: options.onStdout || (() => {}),
      stderr: options.onStderr || (() => {}),
      resize: options.onResize || (() => {}),
      signal: options.onSignal || (() => {}),
      open: options.onOpen || (() => {}),
      close: options.onClose || (() => {}),
      error: options.onError || (() => {}),
    };
    this.reconnectAttempts = 0;
    this.maxReconnectAttempts = options.maxReconnect || 5;
    this.reconnectDelay = options.reconnectDelay || 1000;
  }

  connect(cols = 80, rows = 24) {
    const wsUrl = new URL(this.url);
    wsUrl.searchParams.set('pty', 'true');
    wsUrl.searchParams.set('cols', String(cols));
    wsUrl.searchParams.set('rows', String(rows));

    this.ws = new WebSocket(wsUrl.toString());
    this.ws.binaryType = 'arraybuffer';

    this.ws.onopen = () => {
      this.reconnectAttempts = 0;
      this.handlers.open();
    };

    this.ws.onmessage = (evt) => {
      if (typeof evt.data === 'string') {
        try {
          const info = JSON.parse(evt.data);
          if (info.error) {
            this.handlers.stderr(`[error: ${info.error}]`);
          }
        } catch {
          this.handlers.stdout(evt.data);
        }
        return;
      }

      const frame = parseFrame(evt.data);
      if (!frame) return;

      if (frame.type === 'stdout' || frame.type === 'stderr') {
        this.handlers[frame.type](frame.data);
      } else if (frame.type === 'resize') {
        this.handlers.resize(frame.cols, frame.rows);
      } else if (frame.type === 'signal') {
        this.handlers.signal(frame.signal);
      }
    };

    this.ws.onclose = (e) => {
      let reason = '[session ended]';
      if (e.reason) {
        try {
          const info = JSON.parse(e.reason);
          if (info.error) reason = `[error: ${info.error}]`;
          else if (info.signal) reason = `[killed by ${info.signal}]`;
          else if (typeof info.exit_code === 'number') reason = `[exit ${info.exit_code}]`;
        } catch {
          reason = `[${e.reason}]`;
        }
      }
      this.handlers.close(reason);
      this._tryReconnect(cols, rows);
    };

    this.ws.onerror = (err) => {
      this.handlers.error(err);
    };
  }

  send(data) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(createStdinFrame(data));
  }

  sendSignal(signal) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(createSignalFrame(signal));
  }

  resize(cols, rows) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(createResizeFrame(cols, rows));
  }

  disconnect() {
    this.maxReconnectAttempts = 0;
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  _tryReconnect(cols, rows) {
    if (this.reconnectAttempts >= this.maxReconnectAttempts) return;
    this.reconnectAttempts++;
    setTimeout(() => this.connect(cols, rows), this.reconnectDelay * this.reconnectAttempts);
  }
}

// --- Syn Payload Builder ---

export function buildSynPayload(options = {}) {
  return {
    type: 'shell',
    pty: options.pty !== false,
    cols: options.cols || 80,
    rows: options.rows || 24,
    env: options.env || {},
    cwd: options.cwd || null,
  };
}

export function parseFinPayload(reason) {
  if (!reason) return { exitCode: 0 };
  try {
    const info = JSON.parse(reason);
    return {
      exitCode: info.exit_code || 0,
      signal: info.signal || null,
      error: info.error || null,
    };
  } catch {
    return { exitCode: 0, error: reason };
  }
}
