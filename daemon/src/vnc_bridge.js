/**
 * VNC bridge (noVNC / guacamole-server inspiration) — remote desktop access.
 *
 * Exposes a local TCP port that serves a screen-frame feed: a client sends
 * `GET_FRAME` and receives a JSON frame reply; every new capture is broadcast
 * to all connected clients as `frame_update`. Frames come from the real
 * desktop capture controller, which is asked for a stream only while the
 * bridge is running, so an idle bridge costs nothing. `vnc_frame` still
 * accepts a pushed frame, for feeding a screen the daemon cannot capture
 * itself. Provides the server side of the noVNC/guacamole pattern without
 * pulling in a full RFB proxy.
 */
import net from "node:net";
import { EventEmitter } from "node:events";

export class VNCBridge extends EventEmitter {
  constructor(port = 5900, controller = null) {
    super();
    this.port = port;
    this.controller = controller;
    this.onFrame = (frame) => this.updateFrame(Buffer.from(frame.base64, "base64"), { width: frame.width, height: frame.height });
    this.server = null;
    this.connections = new Map();
    this.frameBuffer = Buffer.alloc(0);
    this.screenWidth = 1920;
    this.screenHeight = 1080;
    this.running = false;
  }

  /**
   * Start the TCP frame server. `port` may be 0 to bind an ephemeral port
   * (reported back in the resolved value). Resolves `{ ok, port }`.
   */
  async start(port, { bindAll = false } = {}) {
    if (this.running) {
      return { ok: false, reason: "already_running", port: this.server?.address()?.port ?? this.port };
    }
    const listenPort = port ?? this.port;
    this.server = net.createServer((socket) => this.handleConnection(socket));
    await new Promise((resolve, reject) => {
      const onError = (err) => { this.server.off("listening", onListening); reject(err); };
      const onListening = () => { this.server.off("error", onError); resolve(); };
      this.server.once("error", onError);
      this.server.once("listening", onListening);
      // Loopback unless asked otherwise: the frame feed is unauthenticated.
      this.server.listen(listenPort, bindAll ? "0.0.0.0" : "127.0.0.1");
    });
    this.running = true;
    this.port = this.server.address().port;
    if (this.controller) {
      this.controller.on("frame", this.onFrame);
      await this.controller.startFrameStream("vnc-bridge");
    }
    this.emit("bridge:started", { port: this.port });
    return { ok: true, port: this.port, capturing: !!this.controller };
  }

  handleConnection(socket) {
    const id = `vnc_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    this.connections.set(id, { socket, connectedAt: Date.now() });
    socket.on("data", (data) => this.handleData(id, data));
    socket.on("close", () => this.connections.delete(id));
    socket.on("error", () => this.connections.delete(id));
    this.emit("client:connected", { id });
  }

  handleData(connId, data) {
    const message = data.toString().trim();
    if (message === "GET_FRAME") {
      const conn = this.connections.get(connId);
      if (conn?.socket.writable) {
        conn.socket.write(JSON.stringify({
          width: this.screenWidth,
          height: this.screenHeight,
          data: this.frameBuffer.toString("base64"),
        }));
      }
    }
  }

  /**
   * Feed a new screen frame; broadcasts `frame_update` to every connected
   * TCP client (mirrors what WS clients see via the vnc_event broadcast).
   */
  updateFrame(buffer, { width, height } = {}) {
    this.frameBuffer = buffer;
    if (width) this.screenWidth = width;
    if (height) this.screenHeight = height;
    const msg = JSON.stringify({ type: "frame_update", timestamp: Date.now() });
    for (const [, conn] of this.connections) {
      if (conn.socket.writable) conn.socket.write(msg);
    }
    this.emit("frame:received", {
      width: this.screenWidth,
      height: this.screenHeight,
      bytes: buffer.length,
      clients: this.connections.size,
    });
  }

  getConnectionCount() { return this.connections.size; }

  getStatus() {
    return {
      running: this.running,
      port: this.port,
      connections: this.connections.size,
      screenWidth: this.screenWidth,
      screenHeight: this.screenHeight,
      frameBytes: this.frameBuffer.length,
    };
  }

  async stop() {
    if (this.controller) {
      this.controller.off("frame", this.onFrame);
      this.controller.stopFrameStream("vnc-bridge");
    }
    for (const [, conn] of this.connections) conn.socket.destroy();
    this.connections.clear();
    this.running = false;
    if (this.server) {
      await new Promise((resolve) => this.server.close(() => resolve()));
      this.server = null;
    }
    this.emit("bridge:stopped", { port: this.port });
    return { ok: true };
  }
}